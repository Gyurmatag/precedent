// An Associate is one agent drafting one change. It works in its own Artifacts
// fork, checks its draft against its own examples and the binding precedents
// inside a Dynamic Worker, pushes a commit, and reports back to the Court.
import { Agent, getAgentByName } from "agents";
import type { Cart, FeatureSpec, Outcome } from "../shared/types.ts";
import { consistent, describeOutcome, isError } from "./behavior.ts";
import { examine } from "./examiner.ts";
import { ZERO_SHA } from "./git.ts";
import { callJson, modelLabel } from "./models.ts";
import { DRAFT_SCHEMA, draftPrompt, repairPrompt, type DraftOutput, type PrecedentBrief } from "./prompts.ts";
import { commitFiles, headOf, treeHashOf, writeToken } from "./repo.ts";
import { BASE_PROBES } from "./seed.ts";
import type { Court } from "./court.ts";

export interface DraftJob {
	sessionId: string;
	draftId: string;
	feature: FeatureSpec;
	model: string;
	trunkRepo: string;
	baseSha: string;
	baseTree: string;
	files: Record<string, string>;
	precedents: PrecedentBrief[];
	forkName: string;
	workspace: { name: string; remote: string; parent: string; parentTree: string };
}

export interface DraftReport {
	draftId: string;
	ok: boolean;
	note?: string;
	repo?: string;
	commit?: string;
	treeHash?: string;
	changed: Record<string, string>;
	examples: { input: Cart; expected: Record<string, unknown> }[];
	assumptions: string[];
	ms: number;
}

interface CheckResult {
	changed: Record<string, string>;
	problems: string[];
	fatal: boolean;
	treeHash: string;
}

export class Associate extends Agent<Env> {
	async start(job: DraftJob): Promise<boolean> {
		await this.ctx.storage.put("job", job);
		await this.schedule(0, "work");
		return true;
	}

	async work() {
		const job = await this.ctx.storage.get<DraftJob>("job");
		if (!job || (await this.ctx.storage.get("done"))) return;
		const court = await getAgentByName<Env, Court>(this.env.Court, job.sessionId);
		const t0 = Date.now();
		const report: DraftReport = { draftId: job.draftId, ok: false, changed: {}, examples: [], assumptions: [], ms: 0 };
		try {
			const fork = job.workspace;
			report.repo = fork.name;
			await court.draftStatus(job.draftId, "drafting", fork.name);

			const prompt = draftPrompt(job.feature, job.files, job.precedents);
			let draft = (await callJson<DraftOutput>(this.env, job.model, prompt.system, prompt.user, DRAFT_SCHEMA)).data;
			let check = await this.check(job, draft);
			if (check.problems.length) {
				const repair = repairPrompt(job.feature, job.files, job.precedents, draft, check.problems);
				try {
					const repaired = (await callJson<DraftOutput>(this.env, job.model, repair.system, repair.user, DRAFT_SCHEMA)).data;
					const recheck = await this.check(job, repaired);
					if (recheck.problems.length <= check.problems.length) {
						draft = repaired;
						check = recheck;
					}
				} catch {
					// keep the first attempt
				}
			}
			report.examples = (draft.examples ?? []).filter((e) => e && typeof e.input === "object").slice(0, 6);
			report.assumptions = (draft.assumptions ?? []).filter((a) => typeof a === "string").slice(0, 6);
			report.changed = check.changed;
			report.treeHash = check.treeHash;

			if (check.fatal) {
				report.note = check.problems[0] ?? "draft does not run";
				return;
			}
			const precedentFailures = check.problems.filter((p) => p.startsWith("precedent"));
			if (precedentFailures.length) {
				report.note = precedentFailures[0];
				return;
			}

			await court.draftStatus(job.draftId, "pushing");
			const token = await writeToken(this.env, fork.name, 600);
			const existing = await headOf(fork.remote, token, "refs/heads/draft");
			const res = await commitFiles(this.env, {
				repoName: fork.name,
				remote: fork.remote,
				token,
				ref: "refs/heads/draft",
				expectedOld: existing ?? ZERO_SHA,
				parents: [fork.parent],
				parentTree: fork.parentTree,
				files: { ...job.files, ...check.changed },
				message: [
					`Draft: ${job.feature.title}`,
					"",
					...report.assumptions.map((a) => `- ${a}`),
					"",
					`Precedent-Feature: ${job.feature.id}`,
					`Precedent-Draft: ${job.draftId}`,
					`Precedent-Model: ${modelLabel(job.model)}`,
				].join("\n"),
			});
			if (!res.ok) throw new Error(`push rejected: ${res.reason}`);
			report.commit = res.commit;
			report.ok = true;
			if (check.problems.length) report.note = `self-check: ${check.problems.length} example(s) disagree with the code`;
		} catch (e) {
			report.note = String((e as Error)?.message ?? e).slice(0, 200);
		} finally {
			report.ms = Date.now() - t0;
			await this.ctx.storage.put("done", true);
			await court.report(report);
		}
	}

	/** Run the draft in a Dynamic Worker against its own examples and the binding precedents. */
	private async check(job: DraftJob, draft: DraftOutput): Promise<CheckResult> {
		const changed: Record<string, string> = {};
		for (const f of draft.files ?? []) {
			if (typeof f?.path !== "string" || typeof f?.content !== "string") continue;
			const path = f.path.replace(/^\.?\//, "");
			if (path.startsWith("src/") && path.endsWith(".js") && f.content !== job.files[path]) changed[path] = f.content;
		}
		const files = { ...job.files, ...changed };
		const treeHash = await treeHashOf(files);
		if (!Object.keys(changed).length) return { changed, problems: ["the draft changed no files under src/"], fatal: true, treeHash };

		const examples = (draft.examples ?? []).filter((e) => e && typeof e.input === "object" && Array.isArray((e.input as { items?: unknown }).items));
		const probes: Cart[] = [...BASE_PROBES, ...examples.map((e) => e.input), ...job.precedents.map((p) => p.cart)];
		const exam = await examine(this.env, treeHash, files, probes);
		if (exam.loadError) return { changed, problems: [`the code does not load: ${exam.loadError}`], fatal: true, treeHash };

		const problems: string[] = [];
		const baseCrashes = exam.outcomes.slice(0, BASE_PROBES.length).filter((o, i) => isError(o) && BASE_PROBES[i].items.length > 0);
		if (baseCrashes.length) problems.push(`quote() throws on ordinary carts: ${(baseCrashes[0] as { error: string }).error}`);

		examples.forEach((ex, i) => {
			const got = exam.outcomes[BASE_PROBES.length + i];
			const expected = ex.expected ?? {};
			if ("error" in expected) {
				if (!isError(got)) problems.push(`example ${i + 1}: expected the cart to be rejected, got ${describeOutcome(got)}`);
				return;
			}
			const wrong = Object.entries(expected).filter(
				([f, v]) => typeof v === "number" && !isError(got) && (got as Record<string, number>)[f] !== Math.round(v),
			);
			if (isError(got)) problems.push(`example ${i + 1}: quote() threw "${got.error}"`);
			else if (wrong.length)
				problems.push(`example ${i + 1}: ${wrong.map(([f, v]) => `${f} expected ${v}, got ${(got as Record<string, number>)[f]}`).join("; ")}`);
		});

		job.precedents.forEach((p, i) => {
			const got: Outcome = exam.outcomes[BASE_PROBES.length + examples.length + i];
			if (!consistent(got, p.expect)) problems.push(`precedent #${p.n} (${p.title}) does not hold: expected ${describeOutcome(p.expect)}, got ${describeOutcome(got)}`);
		});
		return { changed, problems: problems.slice(0, 8), fatal: false, treeHash };
	}
}
