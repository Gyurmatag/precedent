import { useState } from "react";
import type { CourtState, DraftView, PrecedentView } from "../shared/types.ts";
import { clock, positionColor, POSITION_COLORS } from "./format.ts";

const WORKING = ["queued", "forking", "drafting", "pushing", "examining"];

function draftTitle(d: DraftView): string {
	const lines = [`${d.id} · ${d.model.split("/").pop()}`, `status: ${d.status}${d.positionId ? ` · position ${d.positionId}` : ""}`];
	if (d.note) lines.push(d.note);
	if (d.assumptions.length) lines.push("", ...d.assumptions.map((a) => `• ${a}`));
	return lines.join("\n");
}

export function Swarm({ state }: { state: CourtState }) {
	return (
		<section className="panel">
			<header>
				<h2>The swarm</h2>
				<span className="count">{state.drafts.length} agents</span>
			</header>
			<div className="body">
				{state.features.map((f) => {
					const drafts = state.drafts.filter((d) => d.featureId === f.id);
					return (
						<div className="feature" key={f.id}>
							<div className="feature-head">
								<b>{f.title}</b>
								<span className={`status ${f.status}`}>
									{f.status === "deliberating" && f.positions > 1 ? `${f.positions} positions` : f.status}
								</span>
							</div>
							<div className="drafts">
								{drafts.map((d, i) => {
									const working = WORKING.includes(d.status);
									const colored = d.status === "standing" || d.status === "chosen";
									return (
										<span
											key={d.id}
											title={draftTitle(d)}
											className={`draft ${working ? "working" : d.status}`}
											style={colored ? { background: positionColor(d.positionId) } : undefined}
										>
											{d.status === "overruled" ? "✕" : d.status === "chosen" ? "★" : i + 1}
										</span>
									);
								})}
							</div>
							{f.note && <div className="feature-note">{f.note}</div>}
						</div>
					);
				})}
				<div className="legend">
					<span>
						<i style={{ background: POSITION_COLORS[0] }} />
						<i style={{ background: POSITION_COLORS[1] }} />
						positions (same behavior, same color)
					</span>
					<span>★ chosen</span>
					<span>✕ overruled by a precedent</span>
				</div>
			</div>
		</section>
	);
}

function Appeal({ state, p, onOverrule }: { state: CourtState; p: PrecedentView; onOverrule: Overrule }) {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const q = state.docket.find((x) => x.id === p.questionId);
	const alternatives = (q?.options ?? []).filter((o) => JSON.stringify(o.outcome) !== JSON.stringify(p.expect) && !("error" in o.outcome && "error" in p.expect));
	if (!q || !alternatives.length || p.overruled) return null;
	if (!open)
		return (
			<button className="link-btn" onClick={() => setOpen(true)}>
				Appeal…
			</button>
		);
	return (
		<div className="appeal">
			<div className="appeal-title">Overrule #{p.n} with:</div>
			{alternatives.map((o) => (
				<button
					key={o.key}
					className="btn small"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						const r = await onOverrule(p.n, o.key, reason.trim());
						if (!r.ok) {
							setError(r.error ?? "Could not overrule");
							setBusy(false);
						}
					}}
				>
					{o.label}
				</button>
			))}
			<input className="appeal-reason" placeholder="Why the change? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
			{error && <div className="error">{error}</div>}
			<div className="kbd-hint">If the ticket already landed, agents rewrite trunk until every precedent, including the new one, holds.</div>
		</div>
	);
}

type Overrule = (precedentN: number, optionKey: string, rationale: string) => Promise<{ ok: boolean; error?: string }>;

export function Casebook({ state, onOverrule }: { state: CourtState; onOverrule: Overrule }) {
	const cases = [...state.casebook].reverse();
	return (
		<section className="panel">
			<header>
				<h2>Casebook</h2>
				<span className="count">{state.casebook.filter((p) => !p.overruled).length} precedents</span>
			</header>
			<div className="body">
				{!cases.length && <div className="empty">No precedents yet. Your first ruling starts the case law.</div>}
				{cases.map((p) => (
					<div className={`case ${p.overruled ? "overruled" : ""}`} key={p.id}>
						<div className="case-head">
							<span className="case-n">#{p.n}</span>
							<span className="case-title">{p.title}</span>
						</div>
						<div className="case-meta">
							<span className={`badge ${p.decidedBy}`}>{p.decidedBy === "human" ? "you" : "Clef"}</span>{" "}
							{state.features.find((f) => f.id === p.featureId)?.title} ·{" "}
							{p.overruled ? (
								<>overruled by #{p.overruledBy}</>
							) : p.landedIn ? (
								<>
									in trunk <code>{p.landedIn.slice(0, 7)}</code>
								</>
							) : (
								"pending landing"
							)}
							{p.overrules ? <> · overrules #{p.overrules}</> : null}
						</div>
						{p.rationale && <div className="case-reason">“{p.rationale}”</div>}
						<Appeal state={state} p={p} onOverrule={onOverrule} />
					</div>
				))}
			</div>
		</section>
	);
}

export function Trunk({ state, sessionId }: { state: CourtState; sessionId: string }) {
	const [clone, setClone] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	async function getClone() {
		setLoading(true);
		try {
			const r = await fetch(`/api/sessions/${sessionId}/clone`, { method: "POST" });
			const d = (await r.json()) as { cloneUrl?: string };
			if (d.cloneUrl) setClone(`git clone ${d.cloneUrl} checkout && cd checkout && npm test`);
		} finally {
			setLoading(false);
		}
	}
	return (
		<section className="panel">
			<header>
				<h2>Trunk</h2>
				<span className="count">{state.trunk ? <code>{state.trunk.head.slice(0, 7)}</code> : "–"}</span>
			</header>
			<div className="body">
				{state.landings.map((l) => (
					<div className="commit" key={l.commit}>
						<code>{l.commit.slice(0, 7)}</code>
						<div>
							{l.featureIds.map((id) => state.features.find((f) => f.id === id)?.title).join(", ")}
							<br />
							<span>
								{l.appeal ? `appeal of #${l.appeal} · ` : ""}via {l.via}
								{l.precedents.length ? ` · precedents ${l.precedents.map((n) => `#${n}`).join(", ")}` : ""}
								{l.blast !== undefined ? ` · blast radius ${l.blast}` : ""}
							</span>
						</div>
					</div>
				))}
				{state.trunk && (
					<div className="commit">
						<code>seed</code>
						<div>
							Checkout engine
							<br />
							<span>
								Artifacts repo <span className="mono">{state.trunk.repo}</span>
							</span>
						</div>
					</div>
				)}
				<div style={{ marginTop: 10 }}>
					<button className="btn" onClick={getClone} disabled={loading || !state.trunk}>
						{loading ? "Minting read token…" : "Clone with plain git"}
					</button>
					{clone && <div className="clone">{clone}</div>}
					{clone && <div className="kbd-hint">Read-only, expires in 1 hour. Try `git log --notes=precedent`.</div>}
				</div>
			</div>
		</section>
	);
}

export function Activity({ state }: { state: CourtState }) {
	return (
		<section className="panel">
			<header>
				<h2>Activity</h2>
			</header>
			<div className="body events">
				{state.events.map((e, i) => (
					<div className={`event ev-${e.kind}`} key={`${e.at}-${i}`}>
						<time>{clock(e.at)}</time>
						<span>{e.text}</span>
					</div>
				))}
			</div>
		</section>
	);
}
