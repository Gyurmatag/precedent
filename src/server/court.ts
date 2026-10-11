// The Court coordinates one session: it dispatches the swarm, cross-examines
// drafts, turns behavioral disagreements into the fewest possible questions,
// records rulings as binding precedents, and lands winners on trunk with a
// compare-and-swap push.
import { Agent, callable, getAgentByName } from "agents";
import { merge } from "node-diff3";
import type {
	Cart,
	CourtState,
	DraftStatus,
	DraftView,
	EventView,
	FeatureSpec,
	Outcome,
	PrecedentView,
	QuestionOption,
	QuestionView,
} from "../shared/types.ts";
import type { Associate, DraftJob, DraftReport } from "./associate.ts";
import {
	combineCarts,
	consistent,
	dedupeCarts,
	describeOutcome,
	groupPositions,
	isError,
	pickQuestion,
	type Position,
} from "./behavior.ts";
import { examine } from "./examiner.ts";
import { ZERO_SHA } from "./git.ts";
import { assignModels, CLERK_MODEL, callJson, clefChoose, INTEGRATOR_MODELS, modelLabel, REDRAFT_MODELS } from "./models.ts";
import {
	CLERK_SCHEMA,
	clerkPrompt,
	conformPrompt,
	INTEGRATE_SCHEMA,
	integratorPrompt,
	PROBES_SCHEMA,
	prosecutorPrompt,
	type ClerkOutput,
	type PrecedentBrief,
} from "./prompts.ts";
import { commitFiles, createRepo, deleteRepos, forkWithRetry, headOf, readFilesAt, snapshotRepo, treeHashOf, writeToken } from "./repo.ts";
import { BASE_PROBES, FEATURES, SEED_FILES } from "./seed.ts";

export interface SessionConfig {
	featureIds: string[];
	agentsPerFeature: number;
}

interface DraftRecord {
	id: string;
	featureId: string;
	model: string;
	baseSha: string;
	changed: Record<string, string>;
	examples: { input: Cart; expected: Record<string, unknown> }[];
	assumptions: string[];
	treeHash?: string;
	repo?: string;
	commit?: string;
}

interface Candidate {
	id: string;
	via: "fast-forward" | "diff3" | "integrator";
	model?: string;
	files: Record<string, string>;
	treeHash: string;
	outcomes?: Outcome[];
	passes?: boolean;
}

interface PendingLanding {
	head: string;
	candidates: Candidate[];
	probes: Cart[];
}

const CLEF_SETTLE_P = 0.85;
const MAX_EVENTS = 80;

function emptyState(): CourtState {
	return {
		sessionId: null,
		phase: "idle",
		trunk: null,
		features: [],
		drafts: [],
		docket: [],
		casebook: [],
		landings: [],
		events: [],
		metrics: { agents: 0, drafts: 0, standing: 0, questions: 0, settledByClef: 0, humanRulings: 0, humanMs: 0, landed: 0, llmCalls: 0 },
		startedAt: null,
	};
}

/** Cart fields a ticket introduces, e.g. "cart.coupon" in its text. */
function ticketFields(f: FeatureSpec): string[] {
	return [...new Set([...f.spec.matchAll(/cart\.([a-zA-Z]+)/g)].map((m) => m[1]))];
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);
}

function cartKey(c: Cart): string {
	return JSON.stringify(c);
}

export class Court extends Agent<Env, CourtState> {
	initialState: CourtState = emptyState();

	// Browsers may watch and call rule(), but never write state directly.
	validateStateChange(_next: CourtState, source: unknown) {
		if (source !== "server") throw new Error("Court state is read-only for clients");
	}

	// Serializes work per key (a feature, or landings) across interleaved awaits.
	private chains = new Map<string, Promise<unknown>>();
	private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.chains.set(
			key,
			next.catch(() => undefined),
		);
		return next;
	}

	// ── state helpers ────────────────────────────────────────────────────────

	private patch(fn: (s: CourtState) => void) {
		const s = structuredClone(this.state);
		fn(s);
		this.setState(s);
	}

	private log(kind: EventView["kind"], text: string) {
		this.patch((s) => {
			s.events = [{ at: Date.now(), kind, text }, ...s.events].slice(0, MAX_EVENTS);
		});
	}

	private feature(id: string): FeatureSpec {
		const f = FEATURES.find((x) => x.id === id);
		if (!f) throw new Error(`unknown feature ${id}`);
		return f;
	}

	private setDraft(id: string, fn: (d: DraftView) => void) {
		this.patch((s) => {
			const d = s.drafts.find((x) => x.id === id);
			if (d) fn(d);
			s.metrics.standing = s.drafts.filter((x) => x.status === "standing" || x.status === "chosen").length;
		});
	}

	private setFeature(id: string, fn: (f: CourtState["features"][number]) => void) {
		this.patch((s) => {
			const f = s.features.find((x) => x.id === id);
			if (f) fn(f);
		});
	}

	private countLlm(n = 1) {
		this.patch((s) => {
			s.metrics.llmCalls += n;
		});
	}

	private async getDraft(id: string): Promise<DraftRecord | undefined> {
		return this.ctx.storage.get<DraftRecord>(`draft:${id}`);
	}

	private async trunkFiles(): Promise<Record<string, string>> {
		return (await this.ctx.storage.get<Record<string, string>>("trunkFiles")) ?? {};
	}

	private async snapshot(sha: string): Promise<Record<string, string> | undefined> {
		return this.ctx.storage.get<Record<string, string>>(`base:${sha}`);
	}

	/** Precedents binding on a feature's drafts: its own, plus everything already on trunk. */
	private briefs(featureId: string | null): PrecedentBrief[] {
		const landed = new Set(this.state.features.filter((f) => f.status === "landed").map((f) => f.id));
		return this.state.casebook
			.filter((p) => !p.overruled && (p.featureId === featureId || landed.has(p.featureId) || p.landedIn))
			.map((p) => ({ n: p.n, title: p.title, cart: p.cart, expect: p.expect }));
	}

	// ── session lifecycle ────────────────────────────────────────────────────

	/** Called by the Worker API (not by browsers directly). */
	async start(config: SessionConfig): Promise<{ ok: boolean; error?: string }> {
		if (this.state.phase !== "idle") return { ok: false, error: "session already started" };
		const id = this.name;
		const features = config.featureIds.map((f) => this.feature(f));
		const perFeature = Math.max(2, Math.min(6, config.agentsPerFeature));

		const trunkName = `s${id}-trunk`;
		const trunk = await createRepo(this.env, trunkName, "Precedent session trunk");
		const token = await writeToken(this.env, trunkName, 300);
		const seeded = await commitFiles(this.env, {
			repoName: trunkName,
			remote: trunk.remote,
			token,
			ref: "refs/heads/main",
			expectedOld: ZERO_SHA,
			parents: [],
			files: SEED_FILES,
			message: "Seed checkout engine\n\nPrecedent-Session: " + id,
		});
		if (!seeded.ok) return { ok: false, error: `could not seed trunk: ${seeded.reason}` };

		await this.ctx.storage.put("config", { ...config, agentsPerFeature: perFeature });
		await this.ctx.storage.put("trunkFiles", SEED_FILES);
		await this.ctx.storage.put("trunkTree", seeded.tree);
		await this.ctx.storage.put(`base:${seeded.commit}`, SEED_FILES);

		const drafts: DraftView[] = [];
		features.forEach((f, i) => {
			assignModels(i, perFeature).forEach((m, k) => {
				drafts.push({ id: `${f.id}-${k + 1}`, featureId: f.id, model: m.id, status: "queued", assumptions: [] });
			});
		});

		this.setState({
			...emptyState(),
			sessionId: id,
			phase: "running",
			trunk: { repo: trunkName, remote: trunk.remote, head: seeded.commit },
			features: features.map((f) => ({ id: f.id, title: f.title, spec: f.spec, status: "drafting", positions: 0 })),
			drafts,
			startedAt: Date.now(),
			metrics: { ...emptyState().metrics, agents: drafts.length },
		});
		this.log("info", `Trunk seeded at ${seeded.commit.slice(0, 7)}. Dispatching ${drafts.length} agents on ${features.length} tickets.`);

		await this.schedule(0, "dispatch");
		for (const f of features) await this.schedule(0, "prepareProbes", { featureId: f.id });
		await this.schedule(8 * 60, "watchdog");
		const tick = await this.scheduleEvery(30, "tick");
		await this.ctx.storage.put("tickId", tick.id);
		await this.schedule(24 * 60 * 60, "cleanup");
		return { ok: true };
	}

	async dispatch() {
		const trunk = this.state.trunk!;
		const files = await this.trunkFiles();
		const baseTree = (await this.ctx.storage.get<string>("trunkTree"))!;
		const queued = this.state.drafts.filter((d) => d.status === "queued");
		// Forks fail silently under heavy fan-out, so the Court forks at most 3 at a time
		// and starts each agent the moment its workspace is ready.
		let next = 0;
		const worker = async () => {
			while (next < queued.length) {
				const d = queued[next++];
				await this.startDraft(d, trunk, files, baseTree);
			}
		};
		await Promise.all([worker(), worker(), worker()]);
	}

	private async startDraft(d: DraftView, trunk: NonNullable<CourtState["trunk"]>, files: Record<string, string>, baseTree: string) {
		const forkName = `s${this.state.sessionId}-${d.id}`;
		this.setDraft(d.id, (x) => (x.status = "forking"));
		let workspace: DraftJob["workspace"];
		try {
			const fork = await forkWithRetry(this.env, trunk.repo, forkName);
			workspace = { ...fork, parent: trunk.head, parentTree: baseTree };
		} catch {
			try {
				const snap = await snapshotRepo(this.env, forkName, files, `Snapshot of ${trunk.repo}@${trunk.head.slice(0, 7)}`);
				workspace = { name: snap.name, remote: snap.remote, parent: snap.commit, parentTree: snap.tree };
				this.log("warn", `Fork for ${d.id} failed; using a snapshot workspace instead.`);
			} catch (e) {
				this.setDraft(d.id, (x) => {
					x.status = "dismissed";
					x.note = `no workspace: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
				});
				return;
			}
		}
		const job: DraftJob = {
			sessionId: this.state.sessionId!,
			draftId: d.id,
			feature: this.feature(d.featureId),
			model: d.model,
			trunkRepo: trunk.repo,
			baseSha: trunk.head,
			baseTree,
			files,
			precedents: this.briefs(d.featureId),
			forkName,
			workspace,
		};
		await this.ctx.storage.put(`draft:${d.id}`, {
			id: d.id,
			featureId: d.featureId,
			model: d.model,
			baseSha: trunk.head,
			changed: {},
			examples: [],
			assumptions: [],
		} satisfies DraftRecord);
		this.setDraft(d.id, (x) => {
			x.status = "drafting";
			x.repo = workspace.name;
		});
		const associate = await getAgentByName<Env, Associate>(this.env.Associate, `${this.state.sessionId}-${d.id}`);
		await associate.start(job);
		this.countLlm();
	}

	/** RPC from Associates. */
	async draftStatus(draftId: string, status: DraftStatus, repo?: string) {
		this.setDraft(draftId, (d) => {
			d.status = status;
			if (repo) d.repo = repo;
		});
	}

	/** RPC from Associates: a finished (or failed) draft. */
	async report(r: DraftReport) {
		const rec = await this.getDraft(r.draftId);
		if (!rec) return;
		const updated: DraftRecord = {
			...rec,
			changed: r.changed,
			examples: r.examples,
			assumptions: r.assumptions,
			treeHash: r.treeHash,
			repo: r.repo,
			commit: r.commit,
		};
		await this.ctx.storage.put(`draft:${r.draftId}`, updated);
		this.setDraft(r.draftId, (d) => {
			d.status = r.ok ? "examining" : "dismissed";
			d.repo = r.repo;
			d.commit = r.commit;
			d.assumptions = r.assumptions;
			d.note = r.note;
			d.ms = r.ms;
		});
		this.patch((s) => {
			s.metrics.drafts += r.ok ? 1 : 0;
		});
		const view = this.state.drafts.find((d) => d.id === r.draftId)!;
		this.log(
			"draft",
			r.ok
				? `${modelLabel(rec.model)} drafted ${this.feature(rec.featureId).title} (${Math.round(r.ms / 1000)}s)`
				: `${modelLabel(rec.model)} draft for ${this.feature(rec.featureId).title} dismissed: ${r.note ?? "failed"}`,
		);
		const siblings = this.state.drafts.filter((d) => d.featureId === view.featureId);
		const pending = siblings.some((d) => ["queued", "forking", "drafting", "pushing"].includes(d.status));
		if (!pending) await this.schedule(0, "examineFeature", { featureId: view.featureId });
	}

	/** If some agents never report, carry on with the drafts that did. */
	async watchdog() {
		for (const f of this.state.features) {
			if (f.status !== "drafting") continue;
			const ds = this.state.drafts.filter((d) => d.featureId === f.id);
			for (const d of ds)
				if (["queued", "forking", "drafting", "pushing"].includes(d.status))
					this.setDraft(d.id, (x) => {
						x.status = "dismissed";
						x.note = "timed out";
					});
			await this.schedule(0, "examineFeature", { featureId: f.id });
		}
	}

	/** Heartbeat: keeps landings moving if a run was interrupted, and stops when the session is done. */
	async tick() {
		if (this.state.phase !== "running") {
			const id = await this.ctx.storage.get<string>("tickId");
			if (id) await this.cancelSchedule(id);
			return;
		}
		const queue = (await this.ctx.storage.get<string[]>("landingQueue")) ?? [];
		if (queue.length) await this.processLandings();
	}

	async cleanup() {
		if (!this.state.sessionId) return;
		const n = await deleteRepos(this.env, `s${this.state.sessionId}-`, `s${this.state.sessionId}-trunk`);
		this.log("info", `Session archived: deleted ${n} draft workspaces; the trunk is kept.`);
	}

	// ── probes ───────────────────────────────────────────────────────────────

	/** The prosecutor proposes carts likely to expose disagreements for a ticket. */
	async prepareProbes({ featureId }: { featureId: string }) {
		if (await this.ctx.storage.get(`prosecutor:${featureId}`)) return;
		const p = prosecutorPrompt(this.feature(featureId), SEED_FILES["AGENTS.md"]);
		let carts: Cart[] = [];
		try {
			this.countLlm();
			const out = await callJson<{ carts: Cart[] }>(this.env, CLERK_MODEL, p.system, p.user, PROBES_SCHEMA, { maxTokens: 6000 });
			carts = (out.data.carts ?? []).filter(
				(c) =>
					c &&
					Array.isArray((c as { items?: unknown }).items) &&
					((c as { items: unknown[] }).items as Record<string, unknown>[]).every((i) => typeof i?.price === "number" && typeof i?.qty === "number"),
			);
		} catch {
			// drafts' own examples still provide probes
		}
		await this.ctx.storage.put(`prosecutor:${featureId}`, carts);
	}

	private async probesFor(featureId: string): Promise<Cart[]> {
		const existing = await this.ctx.storage.get<Cart[]>(`probes:${featureId}`);
		if (existing) return existing;
		if (!(await this.ctx.storage.get(`prosecutor:${featureId}`))) await this.prepareProbes({ featureId });
		const prosecutor = (await this.ctx.storage.get<Cart[]>(`prosecutor:${featureId}`)) ?? [];
		const examples: Cart[] = [];
		for (const d of this.state.drafts.filter((x) => x.featureId === featureId)) {
			const rec = await this.getDraft(d.id);
			for (const e of rec?.examples ?? []) examples.push(e.input);
		}
		const allowed = new Set(["items", "country", ...ticketFields(this.feature(featureId))]);
		const inScope = (c: Cart) => Object.keys(c).every((k) => allowed.has(k));
		const probes = dedupeCarts([...BASE_PROBES, ...prosecutor.filter(inScope), ...examples.filter(inScope)], 48);
		await this.ctx.storage.put(`probes:${featureId}`, probes);
		return probes;
	}

	// ── examination and deliberation ─────────────────────────────────────────

	async examineFeature({ featureId }: { featureId: string }) {
		return this.exclusive(`feature:${featureId}`, async () => {
			const f = this.state.features.find((x) => x.id === featureId);
			if (!f || f.status !== "drafting") return;
			this.setFeature(featureId, (x) => (x.status = "examining"));
			const probes = await this.probesFor(featureId);
			const drafts = this.state.drafts.filter((d) => d.featureId === featureId && d.status === "examining");
			await Promise.all(
				drafts.map(async (d) => {
					const rec = await this.getDraft(d.id);
					if (!rec?.treeHash) return;
					const base = (await this.snapshot(rec.baseSha)) ?? (await this.trunkFiles());
					const files = { ...base, ...rec.changed };
					const exam = await examine(this.env, rec.treeHash, files, probes);
					if (exam.loadError) {
						this.setDraft(d.id, (x) => {
							x.status = "dismissed";
							x.note = exam.loadError;
						});
						return;
					}
					await this.ctx.storage.put(`outcomes:${d.id}`, exam.outcomes);
					this.setDraft(d.id, (x) => (x.status = "standing"));
				}),
			);
			const standing = this.state.drafts.filter((d) => d.featureId === featureId && d.status === "standing").length;
			this.log("info", `Cross-examined ${standing} drafts of ${f.title} on ${probes.length} carts in isolated Workers.`);
			await this.deliberateNow(featureId);
		});
	}

	async deliberate({ featureId }: { featureId: string }) {
		return this.exclusive(`feature:${featureId}`, () => this.deliberateNow(featureId));
	}

	private async deliberateNow(featureId: string) {
		const f = this.state.features.find((x) => x.id === featureId)!;
		if (!["examining", "deliberating"].includes(f.status)) return;
		this.setFeature(featureId, (x) => (x.status = "deliberating"));

		for (let round = 0; round < 12; round++) {
			const probes = await this.probesFor(featureId);
			const index = new Map(probes.map((c, i) => [cartKey(c), i]));
			const binding = this.state.casebook.filter((p) => p.featureId === featureId && !p.overruled);

			// Apply precedents: drafts that contradict a ruling are overruled.
			const standing: { id: string; outcomes: Outcome[] }[] = [];
			for (const d of this.state.drafts.filter((x) => x.featureId === featureId && x.status === "standing")) {
				const outcomes = (await this.ctx.storage.get<Outcome[]>(`outcomes:${d.id}`)) ?? [];
				const broken = binding.find((p) => {
					const i = index.get(cartKey(p.cart));
					return i !== undefined && !consistent(outcomes[i], p.expect);
				});
				if (broken) {
					this.setDraft(d.id, (x) => {
						x.status = "overruled";
						x.note = `contradicts precedent #${broken.n}`;
					});
					continue;
				}
				standing.push({ id: d.id, outcomes });
			}

			const positions = groupPositions(standing);
			this.patch((s) => {
				for (const p of positions) for (const id of p.draftIds) {
					const d = s.drafts.find((x) => x.id === id);
					if (d) d.positionId = p.id;
				}
				const fv = s.features.find((x) => x.id === featureId)!;
				fv.positions = positions.length;
			});

			if (positions.length === 0) {
				this.setFeature(featureId, (x) => {
					x.status = "blocked";
					x.note = "no draft satisfies the precedents";
				});
				this.log("warn", `${f.title}: no standing draft satisfies the precedents.`);
				return;
			}
			if (positions.length === 1) {
				await this.decide(featureId, positions[0]);
				return;
			}
			if (this.state.docket.some((q) => q.featureId === featureId && q.status === "open")) return;

			const plan = pickQuestion(positions, probes);
			if (!plan) {
				// Positions differ only on carts no option can distinguish; treat as one.
				await this.decide(featureId, positions[0]);
				return;
			}
			const question = await this.draftQuestion(featureId, "feature", probes[plan.probeIndex], plan, positions);
			await this.markBaseline(question, standing.map((s) => s.id));
			const settled = await this.triage(question);
			if (!settled) {
				this.patch((s) => {
					s.docket.push(question);
					s.metrics.questions++;
				});
				this.log("question", `Question for you on ${f.title}: ${question.headline ?? "which receipt is right?"} (${question.leverage} drafts hang on it)`);
				return;
			}
			// Clef settled it: the precedent is recorded, loop to apply it.
		}
	}

	private async draftQuestion(
		featureId: string,
		kind: QuestionView["kind"],
		cart: Cart,
		plan: NonNullable<ReturnType<typeof pickQuestion>>,
		positions: Position[] | null,
		candidateInfo?: Map<string, string>,
	): Promise<QuestionView> {
		const options: QuestionOption[] = [];
		for (const [i, o] of plan.options.entries()) {
			const quotes = new Set<string>();
			const models = new Set<string>();
			for (const id of o.draftIds) {
				if (kind === "feature") {
					const d = this.state.drafts.find((x) => x.id === id);
					if (d) {
						models.add(modelLabel(d.model));
						for (const a of d.assumptions) quotes.add(a);
					}
				} else if (candidateInfo?.has(id)) models.add(candidateInfo.get(id)!);
			}
			options.push({
				key: String.fromCharCode(65 + i),
				outcome: o.outcome,
				applied: isError(o.full) ? undefined : o.full.applied,
				label: describeOutcome(o.outcome),
				draftIds: o.draftIds,
				models: [...models],
				quotes: [...quotes].slice(0, 6),
			});
		}
		const q: QuestionView = {
			id: `Q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
			featureId,
			kind,
			cart,
			fields: plan.fields,
			options,
			leverage: plan.options.reduce((n, o) => n + o.draftIds.length, 0),
			askedAt: Date.now(),
			status: "open",
		};
		try {
			const p = clerkPrompt(
				this.feature(featureId),
				cart,
				options.map((o, i) => ({ ...o, full: plan.options[i].full })),
			);
			this.countLlm();
			const out = await callJson<ClerkOutput>(this.env, CLERK_MODEL, p.system, p.user, CLERK_SCHEMA, { maxTokens: 6000, effort: "medium" });
			q.headline = out.data.headline;
			for (const l of out.data.labels ?? []) {
				const opt = options.find((o) => o.key === l.key);
				if (opt && l.label) opt.label = l.label.length > 90 ? `${l.label.slice(0, 88).trimEnd()}…` : l.label;
				// Only quote an agent verbatim: the clerk may pick a quote but not write one.
				const norm = (x: string) => x.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
				const match = opt && l.why ? opt.quotes.find((x) => norm(x) === norm(l.why!)) : undefined;
				if (opt && match) {
					opt.why = match;
					opt.quotes = [match, ...opt.quotes.filter((x) => x !== match)];
				}
			}
		} catch {
			// numeric labels are still usable
		}
		void positions;
		return q;
	}

	/** Clef decides whether the ticket or existing precedents already settle a question. */
	/** Which option (if any) keeps the code's behavior from before this ticket on this cart? */
	private async markBaseline(q: QuestionView, draftIds: string[]) {
		const rec = draftIds.length ? await this.getDraft(draftIds[0]) : undefined;
		const base = rec ? await this.snapshot(rec.baseSha) : undefined;
		if (!base) return;
		const exam = await examine(this.env, await treeHashOf(base), base, [q.cart]);
		const before = exam.outcomes[0];
		if (!before || exam.loadError) return;
		const keeper = q.options.find((o) => consistent(before, isError(o.outcome) ? { error: "rejected" } : o.outcome));
		if (keeper && q.options.filter((o) => consistent(before, isError(o.outcome) ? { error: "rejected" } : o.outcome)).length === 1) {
			keeper.keepsBehavior = true;
		}
	}

	private async triage(q: QuestionView): Promise<boolean> {
		const f = this.feature(q.featureId);
		const precedents = this.state.casebook.filter((p) => !p.overruled).map((p) => `#${p.n} ${p.title}`);
		const criteria: Record<string, string> = {};
		for (const o of q.options) criteria[o.key] = `${o.label} (${describeOutcome(o.outcome)})${o.keepsBehavior ? " — this is exactly what the code did before this ticket" : ""}`;
		const keeper = q.options.find((o) => o.keepsBehavior);
		criteria.open = "Neither the ticket nor the existing decisions settle this; it is a product decision for a human.";
		this.countLlm();
		const verdict = await clefChoose(
			this.env,
			`Ticket: ${f.title}. ${f.spec}\nExisting decisions: ${precedents.join("; ") || "none"}\nCart: ${JSON.stringify(q.cart)}\nQuestion: ${q.headline ?? "Which receipt is correct?"}${keeper ? `\nBefore this ticket, the code produced option ${keeper.key} for this cart. Existing behavior must be kept unless the ticket text explicitly asks to change it.` : ""}`,
			"Does the ticket text, an existing decision, or the rule to keep existing behavior that the ticket does not mention already determine which option is correct? Choose that option only if it is clearly determined; otherwise choose open.",
			criteria,
		);
		if (!verdict) return false;
		if (verdict.choice === "open" || verdict.p < CLEF_SETTLE_P) {
			q.triage = { open: true, p: verdict.probabilities.open ?? 1 - verdict.p };
			return false;
		}
		const option = q.options.find((o) => o.key === verdict.choice);
		if (!option) return false;
		q.triage = { settledBy: "clef", option: option.key, p: verdict.p };
		q.status = "settled";
		this.patch((s) => {
			s.docket.push(q);
			s.metrics.settledByClef++;
		});
		this.addPrecedent(q, option, "clef", `Settled by the ticket (Clef, p=${verdict.p.toFixed(2)})`);
		return true;
	}

	private addPrecedent(q: QuestionView, option: QuestionOption, by: "human" | "clef", rationale?: string): PrecedentView {
		const n = this.state.casebook.length + 1;
		const p: PrecedentView = {
			id: `P${n}`,
			n,
			featureId: q.featureId,
			title: option.label,
			cart: q.cart,
			expect: isError(option.outcome) ? { error: "rejected" } : option.outcome,
			rationale,
			decidedBy: by,
			decidedAt: Date.now(),
			questionId: q.id,
		};
		this.patch((s) => {
			s.casebook.push(p);
		});
		this.log("ruling", `Precedent #${n} (${by === "human" ? "you" : "Clef"}): ${p.title}`);
		return p;
	}

	/** Browser: rule on an open question. */
	@callable()
	async rule(input: { questionId: string; optionKey: string; rationale?: string; ms?: number }) {
		const q = this.state.docket.find((x) => x.id === input.questionId);
		if (!q || q.status !== "open") return { ok: false };
		const option = q.options.find((o) => o.key === input.optionKey);
		if (!option) return { ok: false };
		this.patch((s) => {
			const x = s.docket.find((y) => y.id === q.id)!;
			x.status = "ruled";
			s.metrics.humanRulings++;
			s.metrics.humanMs += Math.max(0, Math.min(input.ms ?? 0, 10 * 60 * 1000));
		});
		this.addPrecedent(q, option, "human", input.rationale?.slice(0, 200) || undefined);
		if (q.kind === "feature") {
			await this.schedule(0, "deliberate", { featureId: q.featureId });
		} else {
			await this.schedule(0, "processLandings");
		}
		return { ok: true };
	}

	/**
	 * When an approved change can't be carried onto the moved trunk, start over on
	 * the current trunk: fresh agents draft with every binding precedent in hand.
	 */
	private async redraft(featureId: string, why: string) {
		await this.ctx.storage.put(`redrafted:${featureId}`, true);
		const queue = ((await this.ctx.storage.get<string[]>("landingQueue")) ?? []).filter((x) => x !== featureId);
		await this.ctx.storage.put("landingQueue", queue);
		const fresh: DraftView[] = REDRAFT_MODELS.map((model, i) => ({
			id: `${featureId}-r${i + 1}`,
			featureId,
			model,
			status: "queued",
			assumptions: [],
		}));
		this.patch((s) => {
			for (const d of s.drafts)
				if (d.featureId === featureId && !["dismissed", "overruled"].includes(d.status)) {
					d.status = "dismissed";
					d.note = "superseded: re-drafted on the current trunk";
				}
			s.drafts.push(...fresh);
			s.metrics.agents += fresh.length;
			const f = s.features.find((x) => x.id === featureId)!;
			f.status = "drafting";
			f.positions = 0;
			f.note = undefined;
		});
		await this.ctx.storage.delete(`probes:${featureId}`);
		this.log("warn", `${this.feature(featureId).title}: the approved change no longer fits trunk (${why}). Re-drafting on the current trunk.`);
		const trunk = this.state.trunk!;
		const files = await this.trunkFiles();
		const baseTree = (await this.ctx.storage.get<string>("trunkTree"))!;
		for (const d of fresh) await this.startDraft(d, trunk, files, baseTree);
	}

	private async decide(featureId: string, position: Position) {
		// Prefer the smallest change among behaviorally identical drafts.
		let winner = position.draftIds[0];
		let best = Infinity;
		for (const id of position.draftIds) {
			const rec = await this.getDraft(id);
			const size = Object.values(rec?.changed ?? {}).reduce((n, c) => n + c.length, 0);
			if (size < best) {
				best = size;
				winner = id;
			}
		}
		await this.ctx.storage.put(`winner:${featureId}`, winner);
		this.setDraft(winner, (d) => (d.status = "chosen"));
		this.setFeature(featureId, (f) => (f.status = "decided"));
		const queue = (await this.ctx.storage.get<string[]>("landingQueue")) ?? [];
		if (!queue.includes(featureId)) queue.push(featureId);
		await this.ctx.storage.put("landingQueue", queue);
		const d = this.state.drafts.find((x) => x.id === winner)!;
		this.log("info", `${this.feature(featureId).title} decided: ${position.draftIds.length} drafts agree; landing ${modelLabel(d.model)}'s draft.`);
		await this.schedule(0, "processLandings");
	}

	// ── landing ──────────────────────────────────────────────────────────────

	async processLandings() {
		return this.exclusive("landings", async () => {
			const queue = (await this.ctx.storage.get<string[]>("landingQueue")) ?? [];
			const remaining: string[] = [];
			for (const featureId of queue) {
				const result = await this.land(featureId);
				if (result === "waiting") remaining.push(featureId);
			}
			// Keep tickets that were queued while we were landing.
			const latest = (await this.ctx.storage.get<string[]>("landingQueue")) ?? [];
			for (const id of latest) if (!queue.includes(id) && !remaining.includes(id)) remaining.push(id);
			await this.ctx.storage.put("landingQueue", remaining);
			if (remaining.some((id) => !queue.includes(id))) await this.schedule(0, "processLandings");
			if (this.state.features.every((f) => f.status === "landed" || f.status === "blocked")) {
				this.patch((s) => (s.phase = "done"));
				this.log("info", "Every ticket is landed or blocked. Session complete.");
			}
		});
	}

	private async verify(candidates: Candidate[], probes: Cart[], binding: PrecedentView[]) {
		const all = dedupeCarts([...binding.map((p) => p.cart), ...probes], 64);
		const index = new Map(all.map((c, i) => [cartKey(c), i]));
		await Promise.all(
			candidates.map(async (c) => {
				const exam = await examine(this.env, c.treeHash, c.files, all);
				if (exam.loadError) {
					c.passes = false;
					return;
				}
				c.outcomes = exam.outcomes;
				c.passes = binding.every((p) => consistent(exam.outcomes[index.get(cartKey(p.cart))!], p.expect));
			}),
		);
		return all;
	}

	private failures(c: Candidate, all: Cart[], binding: PrecedentView[]): string[] {
		const index = new Map(all.map((x, i) => [cartKey(x), i]));
		return binding
			.filter((p) => !c.outcomes || !consistent(c.outcomes[index.get(cartKey(p.cart))!], p.expect))
			.map((p) => `precedent #${p.n} (${p.title}) does not hold: expected ${describeOutcome(p.expect)}${c.outcomes ? `, got ${describeOutcome(c.outcomes[index.get(cartKey(p.cart))!])}` : ""}`)
			.slice(0, 6);
	}

	private async land(featureId: string): Promise<"landed" | "blocked" | "waiting"> {
		const feature = this.feature(featureId);
		const winnerId = await this.ctx.storage.get<string>(`winner:${featureId}`);
		const winner = winnerId ? await this.getDraft(winnerId) : undefined;
		if (!winner) return "blocked";
		this.setFeature(featureId, (f) => (f.status = "integrating"));

		const trunk = this.state.trunk!;
		const trunkFiles = await this.trunkFiles();
		const binding = this.state.casebook.filter((p) => !p.overruled && (p.featureId === featureId || !!p.landedIn));

		let pending = await this.ctx.storage.get<PendingLanding>(`pending:${featureId}`);
		if (!pending || pending.head !== trunk.head) {
			const candidates: Candidate[] = [];
			if (winner.baseSha === trunk.head) {
				const files = { ...trunkFiles, ...winner.changed };
				candidates.push({ id: "ff", via: "fast-forward", files, treeHash: await treeHashOf(files) });
			} else {
				const base = (await this.snapshot(winner.baseSha)) ?? {};
				const merged: Record<string, string> = { ...trunkFiles };
				let clean = true;
				for (const [path, content] of Object.entries(winner.changed)) {
					const ours = trunkFiles[path];
					const original = base[path];
					if (ours === undefined || original === undefined || ours === original) {
						merged[path] = content;
						continue;
					}
					const m = merge(ours.split("\n"), original.split("\n"), content.split("\n"));
					if (m.conflict) {
						clean = false;
						break;
					}
					merged[path] = m.result.join("\n");
				}
				if (clean) candidates.push({ id: "diff3", via: "diff3", files: merged, treeHash: await treeHashOf(merged) });
				const briefs = binding.map((p) => ({ n: p.n, title: p.title, cart: p.cart, expect: p.expect }));
				const integrated = await Promise.all(
					INTEGRATOR_MODELS.map(async (model, i) => {
						try {
							const prompt = integratorPrompt(feature, trunkFiles, winner.changed, winner.assumptions, briefs);
							this.countLlm();
							const out = await callJson<{ files: { path: string; content: string }[] }>(this.env, model, prompt.system, prompt.user, INTEGRATE_SCHEMA);
							const files = { ...trunkFiles };
							for (const f of out.data.files ?? [])
								if (typeof f?.path === "string" && f.path.startsWith("src/") && typeof f.content === "string") files[f.path] = f.content;
							return { id: `int${i + 1}`, via: "integrator" as const, model, files, treeHash: await treeHashOf(files) };
						} catch {
							return null;
						}
					}),
				);
				for (const c of integrated) if (c) candidates.push(c);
			}

			// Interaction probes: this ticket's carts combined with carts from tickets already on trunk.
			const own = await this.probesFor(featureId);
			const landedCarts = this.state.casebook.filter((p) => p.landedIn).map((p) => p.cart);
			const interactions: Cart[] = [];
			for (const a of own.slice(5, 17)) for (const b of landedCarts.slice(0, 6)) interactions.push(combineCarts(a, b));
			const probes = dedupeCarts([...own, ...interactions], 48);
			pending = { head: trunk.head, candidates, probes };
			// Cache per trunk head: retries (heartbeat, rulings) must not re-run the integrators.
			await this.ctx.storage.put(`pending:${featureId}`, pending);
		}

		const all = await this.verify(pending.candidates, pending.probes, binding);
		let passing = pending.candidates.filter((c) => c.passes);

		if (!passing.length && pending.candidates.some((c) => c.via === "integrator")) {
			// One retry with the failures spelled out.
			const failed = pending.candidates.find((c) => c.via === "integrator")!;
			const problems = this.failures(failed, all, binding);
			try {
				const briefs = binding.map((p) => ({ n: p.n, title: p.title, cart: p.cart, expect: p.expect }));
				const prompt = integratorPrompt(feature, trunkFiles, winner.changed, winner.assumptions, briefs, problems);
				this.countLlm();
				const out = await callJson<{ files: { path: string; content: string }[] }>(this.env, INTEGRATOR_MODELS[0], prompt.system, prompt.user, INTEGRATE_SCHEMA);
				const files = { ...trunkFiles };
				for (const f of out.data.files ?? []) if (typeof f?.path === "string" && f.path.startsWith("src/")) files[f.path] = f.content;
				const retry: Candidate = { id: "int-retry", via: "integrator", model: INTEGRATOR_MODELS[0], files, treeHash: await treeHashOf(files) };
				await this.verify([retry], pending.probes, binding);
				pending.candidates.push(retry);
				if (retry.passes) passing = [retry];
			} catch {
				// fall through to blocked
			}
		}

		if (!passing.length) {
			await this.ctx.storage.delete(`pending:${featureId}`);
			const tried = pending.candidates[pending.candidates.length - 1];
			const why = tried?.outcomes ? this.failures(tried, all, binding)[0] : "integrations did not run";
			if (!(await this.ctx.storage.get(`redrafted:${featureId}`))) {
				await this.redraft(featureId, why);
				return "blocked";
			}
			this.setFeature(featureId, (f) => {
				f.status = "blocked";
				f.note = why;
			});
			this.log("warn", `${feature.title} could not be integrated without breaking a precedent: ${why}`);
			return "blocked";
		}

		// Integrations that pass every precedent but behave differently on combined carts
		// expose an interaction nobody has decided yet: that becomes a question.
		if (passing.length > 1) {
			const groups = groupPositions(passing.map((c) => ({ id: c.id, outcomes: c.outcomes! })));
			if (groups.length > 1) {
				const plan = pickQuestion(groups, all);
				if (plan && !this.state.docket.some((q) => q.featureId === featureId && q.kind === "interaction" && q.status === "open")) {
					const info = new Map(passing.map((c) => [c.id, c.model ? `integrator: ${modelLabel(c.model)}` : c.via]));
					const q = await this.draftQuestion(featureId, "interaction", all[plan.probeIndex], plan, null, info);
					await this.ctx.storage.put(`pending:${featureId}`, pending);
					const settled = await this.triage(q);
					if (!settled) {
						this.patch((s) => {
							s.docket.push(q);
							s.metrics.questions++;
						});
						this.log("question", `Interaction found while landing ${feature.title}: ${q.headline ?? "which receipt is right?"}`);
						this.setFeature(featureId, (f) => (f.status = "deliberating"));
						return "waiting";
					}
					return this.land(featureId);
				}
				if (plan) return "waiting";
			}
		}

		const chosen = passing.sort((a, b) => ["fast-forward", "diff3", "integrator"].indexOf(a.via) - ["fast-forward", "diff3", "integrator"].indexOf(b.via))[0];
		return this.commitLanding(featureId, winner, chosen);
	}

	private precedentFiles(precedents: PrecedentView[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (const p of precedents) {
			out[`precedents/${String(p.n).padStart(3, "0")}-${slug(p.title)}.json`] = `${JSON.stringify(
				{
					n: p.n,
					title: p.title,
					feature: p.featureId,
					cart: p.cart,
					expect: p.expect,
					rationale: p.rationale ?? null,
					decidedBy: p.decidedBy,
					decidedAt: new Date(p.decidedAt).toISOString(),
					...(p.overrules ? { overrules: p.overrules } : {}),
					...(p.overruled ? { overruled: true, overruledBy: p.overruledBy ?? null } : {}),
				},
				null,
				2,
			)}\n`;
		}
		return out;
	}

	/**
	 * Push a new trunk commit with a compare-and-swap on main. Only the Court
	 * writes main, so a stale ref means our view is outdated: refresh and report it.
	 */
	private async pushTrunk(files: Record<string, string>, message: string, note: string): Promise<{ ok: true; commit: string; objects: number } | { ok: false; stale: boolean; reason?: string }> {
		const trunk = this.state.trunk!;
		const token = await writeToken(this.env, trunk.repo, 300);
		const head = trunk.head;
		const parentTree = (await this.ctx.storage.get<string>("trunkTree"))!;
		const res = await commitFiles(this.env, {
			repoName: trunk.repo,
			remote: trunk.remote,
			token,
			ref: "refs/heads/main",
			expectedOld: head,
			parents: [head],
			parentTree,
			files,
			message,
			note: { ref: "refs/notes/precedent", text: note },
		});
		if (res.ok) {
			await this.ctx.storage.put("trunkFiles", files);
			await this.ctx.storage.put("trunkTree", res.tree);
			await this.ctx.storage.put(`base:${res.commit}`, files);
			this.patch((s) => (s.trunk = { ...s.trunk!, head: res.commit }));
			return { ok: true, commit: res.commit, objects: res.objectsPushed };
		}
		const fresh = await headOf(trunk.remote, token);
		if (fresh && fresh !== head) {
			const { files: f, treeHash } = await readFilesAt(this.env, trunk.repo, fresh);
			await this.ctx.storage.put("trunkFiles", f);
			await this.ctx.storage.put("trunkTree", treeHash);
			await this.ctx.storage.put(`base:${fresh}`, f);
			this.patch((s) => (s.trunk = { ...s.trunk!, head: fresh }));
			this.log("warn", `Compare-and-swap on main rejected (${res.reason}); main moved to ${fresh.slice(0, 7)}.`);
			return { ok: false, stale: true, reason: res.reason };
		}
		return { ok: false, stale: false, reason: res.reason };
	}

	private async commitLanding(featureId: string, winner: DraftRecord, chosen: Candidate, retries = 1): Promise<"landed" | "blocked"> {
		const feature = this.feature(featureId);
		const newPrecedents = this.state.casebook.filter((p) => !p.landedIn && p.featureId === featureId);
		const files = { ...chosen.files, ...this.precedentFiles(newPrecedents) };
		files["CASEBOOK.md"] = renderCasebook([...this.state.casebook.filter((p) => p.landedIn), ...newPrecedents], (id) => this.feature(id).title);

		const rulings = newPrecedents.map((p) => `#${p.n}`).join(", ") || "none";
		const message = [
			feature.title,
			"",
			...winner.assumptions.map((a) => `- ${a}`),
			"",
			`Precedent-Feature: ${featureId}`,
			`Precedent-Rulings: ${rulings}`,
			`Precedent-Draft: ${winner.id} (${modelLabel(winner.model)})`,
			`Precedent-Via: ${chosen.via}${chosen.model ? ` (${modelLabel(chosen.model)})` : ""}`,
		].join("\n");
		const otherDrafts = this.state.drafts.filter((d) => d.featureId === featureId && d.id !== winner.id);
		const note = [
			`Ticket: ${feature.title} — ${feature.spec}`,
			`Approved draft: ${winner.id} by ${modelLabel(winner.model)}${winner.repo ? ` (artifacts:${winner.repo}@${winner.commit?.slice(0, 7)})` : ""}`,
			`Agent's assumptions:`,
			...winner.assumptions.map((a) => `  - ${a}`),
			`Rulings: ${newPrecedents.map((p) => `#${p.n} ${p.title} (${p.decidedBy})`).join("; ") || "none"}`,
			`Other drafts: ${otherDrafts.map((d) => `${d.id}:${d.status}`).join(", ")}`,
		].join("\n");

		const res = await this.pushTrunk(files, message, note);
		if (res.ok) {
			await this.ctx.storage.delete(`pending:${featureId}`);
			this.patch((s) => {
				for (const p of s.casebook) if (!p.landedIn && p.featureId === featureId) p.landedIn = res.commit;
				const f = s.features.find((x) => x.id === featureId)!;
				f.status = "landed";
				f.landedCommit = res.commit;
				s.landings.unshift({ commit: res.commit, featureIds: [featureId], precedents: newPrecedents.map((p) => p.n), via: chosen.via, at: Date.now() });
				s.metrics.landed++;
			});
			this.log("landing", `Landed ${feature.title} on trunk at ${res.commit.slice(0, 7)} via ${chosen.via} (${res.objects} objects pushed, compare-and-swap on main).`);
			return "landed";
		}
		if (res.stale && retries > 0) {
			// Re-verify against the new main rather than overwriting it.
			const again = await this.land(featureId);
			return again === "waiting" ? "blocked" : again;
		}
		this.setFeature(featureId, (f) => {
			f.status = "blocked";
			f.note = `push rejected: ${res.reason ?? "unknown"}`;
		});
		return "blocked";
	}

	// ── appeals ──────────────────────────────────────────────────────────────

	/** Browser: overrule a precedent by choosing a different answer to its original question. */
	@callable()
	async overrule(input: { precedentN: number; optionKey: string; rationale?: string }) {
		const old = this.state.casebook.find((p) => p.n === input.precedentN);
		if (!old || old.overruled) return { ok: false, error: "no such standing precedent" };
		const q = this.state.docket.find((x) => x.id === old.questionId);
		const option = q?.options.find((o) => o.key === input.optionKey);
		if (!q || !option) return { ok: false, error: "unknown option" };
		if (JSON.stringify(option.outcome) === JSON.stringify(old.expect) || (isError(option.outcome) && isError(old.expect)))
			return { ok: false, error: "that is the current ruling" };
		const feature = this.state.features.find((f) => f.id === old.featureId);
		if (feature && ["decided", "integrating"].includes(feature.status)) return { ok: false, error: "this ticket is landing right now; appeal once it has landed" };

		const next = this.addPrecedent(q, option, "human", input.rationale?.slice(0, 200) || undefined);
		this.patch((s) => {
			const o = s.casebook.find((p) => p.n === old.n)!;
			o.overruled = true;
			o.overruledBy = next.n;
			const n = s.casebook.find((p) => p.n === next.n)!;
			n.overrules = old.n;
			s.metrics.humanRulings++;
		});
		this.log("ruling", `Appeal: precedent #${old.n} overruled by #${next.n}.`);

		if (old.landedIn) {
			await this.schedule(0, "conform", { next: next.n, old: old.n });
		} else {
			// Not on trunk yet: revive drafts that the old ruling had overruled, and deliberate again.
			this.patch((s) => {
				for (const d of s.drafts)
					if (d.featureId === old.featureId && d.status === "overruled" && d.note?.includes(`#${old.n}`)) {
						d.status = "standing";
						d.note = undefined;
					}
				const f = s.features.find((x) => x.id === old.featureId);
				if (f && f.status === "blocked") f.status = "deliberating";
			});
			await this.schedule(0, "deliberate", { featureId: old.featureId });
		}
		return { ok: true, precedent: next.n };
	}

	/** After an appeal on a landed ticket: agents rewrite trunk so the new ruling holds. */
	async conform({ next, old }: { next: number; old: number }) {
		return this.exclusive("landings", async () => {
			const p = this.state.casebook.find((x) => x.n === next)!;
			const before = this.state.casebook.find((x) => x.n === old)!;
			const binding = this.state.casebook.filter((x) => !x.overruled && (x.landedIn || x.n === next));
			const trunkFiles = await this.trunkFiles();
			const current: Candidate = { id: "trunk", via: "fast-forward", files: trunkFiles, treeHash: await treeHashOf(trunkFiles) };
			const probes = await this.probesFor(p.featureId);
			await this.verify([current], probes, binding);

			let chosen: Candidate | undefined = current.passes ? current : undefined;
			if (!chosen) {
				this.log("info", `Agents are rewriting trunk to satisfy precedent #${next}.`);
				const briefs = binding.map((x) => ({ n: x.n, title: x.title, cart: x.cart, expect: x.expect }));
				let problems = this.failures(current, await this.verify([current], probes, binding), binding);
				for (let attempt = 0; attempt < 2 && !chosen; attempt++) {
					const candidates = (
						await Promise.all(
							INTEGRATOR_MODELS.map(async (model, i) => {
								try {
									const prompt = conformPrompt(trunkFiles, briefs, { n: before.n, title: before.title, cart: before.cart, expect: before.expect }, { n: p.n, title: p.title, cart: p.cart, expect: p.expect }, problems);
									this.countLlm();
									const out = await callJson<{ files: { path: string; content: string }[] }>(this.env, model, prompt.system, prompt.user, INTEGRATE_SCHEMA);
									const files = { ...trunkFiles };
									for (const f of out.data.files ?? []) if (typeof f?.path === "string" && f.path.startsWith("src/") && typeof f.content === "string") files[f.path] = f.content;
									const c: Candidate = { id: `conform${attempt}-${i}`, via: "integrator", model, files, treeHash: await treeHashOf(files) };
									return c;
								} catch {
									return null;
								}
							}),
						)
					).filter((c): c is NonNullable<typeof c> => c !== null);
					const all = await this.verify(candidates, probes, binding);
					chosen = candidates.find((c) => c.passes);
					if (!chosen && candidates[0]) problems = this.failures(candidates[0], all, binding);
				}
			}
			if (!chosen) {
				this.log("warn", `No agent could satisfy precedent #${next} without breaking another precedent. Trunk is unchanged.`);
				return;
			}
			const files = { ...chosen.files, ...this.precedentFiles(this.state.casebook.filter((x) => x.landedIn || x.n === next)) };
			files["CASEBOOK.md"] = renderCasebook(this.state.casebook.filter((x) => x.landedIn || x.n === next), (id) => this.feature(id).title);
			const message = [
				`Appeal: precedent #${old} overruled by #${next}`,
				"",
				`${p.title}`,
				...(p.rationale ? ["", `Reason: ${p.rationale}`] : []),
				"",
				`Precedent-Overrules: #${old}`,
				`Precedent-Rulings: #${next}`,
				`Precedent-Via: ${chosen.id === "trunk" ? "no code change needed" : `integrator (${modelLabel(chosen.model!)})`}`,
			].join("\n");
			const note = `Appeal on ticket ${this.feature(p.featureId).title}: #${old} (${before.title}) overruled by #${next} (${p.title}).`;
			const res = await this.pushTrunk(files, message, note);
			if (!res.ok) {
				this.log("warn", `Appeal could not be pushed (${res.reason ?? "rejected"}).`);
				return;
			}
			this.patch((s) => {
				const x = s.casebook.find((y) => y.n === next)!;
				x.landedIn = res.commit;
				s.landings.unshift({ commit: res.commit, featureIds: [p.featureId], precedents: [next], via: chosen!.id === "trunk" ? "fast-forward" : "integrator", at: Date.now() });
			});
			this.log("landing", `Trunk now follows precedent #${next} (${res.commit.slice(0, 7)}). The code followed the law.`);
		});
	}

	// ── read-only helpers for the API ────────────────────────────────────────

	/** Global daily budget, kept on a dedicated Court instance named "registry". */
	async admit(maxPerDay: number): Promise<boolean> {
		const day = new Date().toISOString().slice(0, 10);
		const key = `admitted:${day}`;
		const n = (await this.ctx.storage.get<number>(key)) ?? 0;
		if (n >= maxPerDay) return false;
		await this.ctx.storage.put(key, n + 1);
		return true;
	}

	async getState(): Promise<CourtState> {
		return this.state;
	}

	/** Same as the browser's rule(), for API and CLI callers. */
	async ruleFromApi(input: { questionId: string; optionKey: string; rationale?: string; ms?: number }) {
		return this.rule(input);
	}

	async summary() {
		return { phase: this.state.phase, trunk: this.state.trunk, startedAt: this.state.startedAt };
	}
}

function renderCasebook(precedents: PrecedentView[], featureTitle: (id: string) => string): string {
	const lines = [
		"# Casebook",
		"",
		"Binding decisions about how this checkout behaves. Each one was made by a human",
		"(or settled automatically when the ticket already answered it) and is enforced",
		"by `npm test` through the matching file in `precedents/`.",
		"",
	];
	for (const p of precedents) {
		const heading = p.overruled ? `## ~~#${p.n} ${p.title}~~ (overruled by #${p.overruledBy})` : `## #${p.n} ${p.title}`;
		lines.push(
			heading,
			"",
			`- Ticket: ${featureTitle(p.featureId)}`,
			`- Decided by: ${p.decidedBy === "human" ? "a human" : "Clef (the ticket already settled it)"} on ${new Date(p.decidedAt).toISOString().slice(0, 10)}`,
			...(p.overrules ? [`- Overrules: #${p.overrules}`] : []),
			`- Cart: \`${JSON.stringify(p.cart)}\``,
			`- Ruling: ${describeOutcome(p.expect)}`,
			...(p.rationale ? [`- Reason: ${p.rationale}`] : []),
			"",
		);
	}
	return lines.join("\n");
}
