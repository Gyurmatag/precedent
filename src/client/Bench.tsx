import { useEffect, useRef, useState } from "react";
import { BEHAVIOR_FIELDS, type BehaviorField, type Cart, type CourtState, type Outcome, type QuestionOption, type QuestionView } from "../shared/types.ts";
import { FIELD_LABELS, fieldValue, money } from "./format.ts";

function CartView({ cart }: { cart: Cart }) {
	const items = (Array.isArray(cart.items) ? cart.items : []) as Record<string, unknown>[];
	const extras = Object.entries(cart).filter(([k]) => k !== "items");
	return (
		<div className="cart">
			<div className="cart-title">For this cart</div>
			{items.length ? (
				<table>
					<tbody>
						{items.map((it, i) => (
							<tr key={i}>
								<td>
									{String(it.qty ?? "?")} × {String(it.name ?? it.sku ?? "item")}
									{it.category ? <span style={{ color: "var(--faint)" }}> · {String(it.category)}</span> : null}
									{it.limited ? <span style={{ color: "var(--faint)" }}> · limited</span> : null}
								</td>
								<td className="r">{typeof it.price === "number" ? money(it.price as number) : String(it.price)}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<div className="empty">An empty cart</div>
			)}
			{extras.length > 0 && (
				<div className="tags">
					{extras.map(([k, v]) => (
						<span className="tag" key={k}>
							{k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

function Receipt({ outcome, fields }: { outcome: Outcome; fields: BehaviorField[] }) {
	if ("error" in outcome) return <div className="receipt rejected">✕ Rejects the cart</div>;
	const shown = BEHAVIOR_FIELDS.filter((f) => outcome[f] !== undefined || fields.includes(f));
	return (
		<div className="receipt">
			{shown.map((f) => (
				<div key={f} className={fields.includes(f) ? "diff" : ""}>
					<span>{FIELD_LABELS[f]}</span>
					<span>{fieldValue(f, outcome)}</span>
				</div>
			))}
		</div>
	);
}

function OptionCard({ q, o, i, selected, onSelect }: { q: QuestionView; o: QuestionOption; i: number; selected: boolean; onSelect: () => void }) {
	const quote = o.why;
	return (
		<button className={`option ${selected ? "selected" : ""}`} onClick={onSelect}>
			<span className="key">{i + 1}</span>
			<div className="label">{o.label}</div>
			{o.keepsBehavior && <div className="keeps">keeps today's behavior</div>}
			<Receipt outcome={o.outcome} fields={q.fields} />
			{o.applied && o.applied.length > 0 && (
				<div className="applied">
					{o.applied.map((a, k) => (
						<span key={k}>{a}</span>
					))}
				</div>
			)}
			<div className="backers">
				{q.kind === "feature" ? `${o.draftIds.length} draft${o.draftIds.length === 1 ? "" : "s"}` : `${o.draftIds.length} integration${o.draftIds.length === 1 ? "" : "s"}`}
				{o.models.length ? ` · ${o.models.join(", ")}` : ""}
			</div>
			{quote && <div className="quote">“{quote}”</div>}
		</button>
	);
}

export function Bench({ state, onRule }: { state: CourtState; onRule: (questionId: string, optionKey: string, rationale: string, ms: number) => Promise<void> }) {
	const open = state.docket.filter((q) => q.status === "open").sort((a, b) => b.leverage - a.leverage || a.askedAt - b.askedAt);
	const q = open[0];
	const [choice, setChoice] = useState<number | null>(null);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const shownAt = useRef(Date.now());
	const reasonRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setChoice(null);
		setReason("");
		setBusy(false);
		shownAt.current = Date.now();
		// A new question: number keys should choose an option, not type into the reason field.
		reasonRef.current?.blur();
	}, [q?.id]);

	async function submit(index = choice) {
		if (!q || index === null || busy) return;
		setBusy(true);
		await onRule(q.id, q.options[index].key, reason.trim(), Date.now() - shownAt.current);
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (!q) return;
			const typing = document.activeElement === reasonRef.current;
			const n = Number(e.key);
			if (!typing && n >= 1 && n <= q.options.length) {
				setChoice(n - 1);
				e.preventDefault();
			} else if (e.key === "Enter" && choice !== null) {
				e.preventDefault();
				void submit();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const settled = state.docket.filter((x) => x.status === "settled").length;
	const feature = q ? state.features.find((f) => f.id === q.featureId) : undefined;

	return (
		<section className="panel bench">
			<header>
				<h2>The bench</h2>
				<span className="count">{open.length ? `${open.length} open question${open.length === 1 ? "" : "s"}` : "no open questions"}</span>
			</header>
			<div className="body">
				{q ? (
					<>
						<div className="q-meta">
							<span className="badge">{q.kind === "feature" ? "ticket" : "interaction"}</span>
							<b>{feature?.title}</b>
							<span>· {q.leverage} {q.kind === "feature" ? "drafts" : "integrations"} hang on this answer</span>
							{"open" in (q.triage ?? {}) && <span>· Clef: the ticket doesn't settle it</span>}
						</div>
						<h3 className="q-headline">{q.headline ?? "Which receipt is right?"}</h3>
						<CartView cart={q.cart} />
						<div className="options">
							{q.options.map((o, i) => (
								<OptionCard key={o.key} q={q} o={o} i={i} selected={choice === i} onSelect={() => setChoice(i)} />
							))}
						</div>
						<div className="rule-row">
							<input
								ref={reasonRef}
								placeholder="Why? (optional, one line, saved with the precedent)"
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								maxLength={200}
							/>
							<button className="btn primary" disabled={choice === null || busy} onClick={() => void submit()}>
								{busy ? "Recording…" : "Set precedent"}
							</button>
						</div>
						<div className="kbd-hint">
							Press {q.options.map((_, i) => i + 1).join(" / ")} to choose, Enter to rule. The answer binds every current and future agent.
						</div>
					</>
				) : (
					<Waiting state={state} />
				)}
				{settled > 0 && (
					<div className="settled">
						{settled} question{settled === 1 ? " was" : "s were"} settled automatically by Clef because the ticket already answered{" "}
						{settled === 1 ? "it" : "them"}.
					</div>
				)}
			</div>
		</section>
	);
}

function Waiting({ state }: { state: CourtState }) {
	const working = state.drafts.filter((d) => ["queued", "forking", "drafting", "pushing"].includes(d.status)).length;
	const integrating = state.features.filter((f) => f.status === "integrating" || f.status === "decided").length;
	if (state.phase === "done") {
		const landed = state.features.filter((f) => f.status === "landed").length;
		return (
			<div className="waiting">
				<div style={{ fontSize: 28 }}>⚖️</div>
				<h3>The session is adjourned</h3>
				<div>
					{landed} of {state.features.length} tickets landed on trunk, governed by {state.casebook.length} precedent
					{state.casebook.length === 1 ? "" : "s"}.
				</div>
			</div>
		);
	}
	return (
		<div className="waiting">
			<div style={{ fontSize: 28 }}>⏳</div>
			<h3>{working ? `${working} agents are drafting` : integrating ? "Landing decided tickets" : "Cross-examining drafts"}</h3>
			<div className="queue-note">
				Questions appear here as soon as drafts of a ticket disagree on behavior. You'll only ever see the disagreements that
				matter.
			</div>
		</div>
	);
}
