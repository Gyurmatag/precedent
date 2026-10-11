// Behavior analysis: group drafts into positions (identical behavior on every
// probe), and pick the single question whose answer settles the most drafts.
import { BEHAVIOR_FIELDS, type BehaviorField, type Cart, type Outcome } from "../shared/types.ts";

export function isError(o: Outcome): o is { error: string } {
	return "error" in o;
}

/** Canonical key of an outcome, optionally restricted to some fields. Errors compare equal. */
export function outcomeKey(o: Outcome, fields: readonly BehaviorField[] = BEHAVIOR_FIELDS): string {
	if (isError(o)) return "rejected";
	return fields.map((f) => `${f}=${o[f] ?? "-"}`).join(",");
}

export interface DraftBehavior {
	id: string;
	outcomes: Outcome[]; // aligned with the probe list
}

export interface Position {
	id: string;
	draftIds: string[];
	outcomes: Outcome[];
}

/** Drafts with identical outcomes on every probe form one position, largest first. */
export function groupPositions(drafts: DraftBehavior[]): Position[] {
	const groups = new Map<string, Position>();
	for (const d of drafts) {
		const sig = d.outcomes.map((o) => outcomeKey(o)).join("|");
		const g = groups.get(sig);
		if (g) g.draftIds.push(d.id);
		else groups.set(sig, { id: "", draftIds: [d.id], outcomes: d.outcomes });
	}
	const positions = [...groups.values()].sort((a, b) => b.draftIds.length - a.draftIds.length);
	positions.forEach((p, i) => (p.id = `P${i + 1}`));
	return positions;
}

/** Fields whose values differ across the given (non-error) outcomes. */
export function differingFields(outcomes: Outcome[]): BehaviorField[] {
	const ok = outcomes.filter((o) => !isError(o)) as Partial<Record<BehaviorField, number>>[];
	return BEHAVIOR_FIELDS.filter((f) => new Set(ok.map((o) => o[f] ?? null)).size > 1);
}

export function restrict(o: Outcome, fields: readonly BehaviorField[]): Outcome {
	if (isError(o)) return { error: o.error };
	const out: Partial<Record<BehaviorField, number>> = {};
	for (const f of fields) if (o[f] !== undefined) out[f] = o[f];
	return out;
}

/** Does an outcome satisfy a precedent's expectation? */
export function consistent(o: Outcome, expect: Outcome): boolean {
	if (isError(expect)) return isError(o);
	if (isError(o)) return false;
	return Object.entries(expect).every(([f, v]) => o[f as BehaviorField] === v);
}

export interface QuestionPlan {
	probeIndex: number;
	fields: BehaviorField[];
	options: { outcome: Outcome; positionIds: string[]; draftIds: string[] }[];
	settles: number; // drafts eliminated whichever option is chosen (at least)
}

function cartComplexity(cart: Cart): number {
	return JSON.stringify(cart).length;
}

/**
 * Choose the probe that splits the standing positions most evenly: the answer
 * eliminates as many drafts as possible in the worst case (20-questions style).
 * Ties prefer two-way questions and simpler carts.
 */
export function pickQuestion(positions: Position[], probes: Cart[], maxOptions = 4): QuestionPlan | null {
	if (positions.length < 2) return null;
	const total = positions.reduce((n, p) => n + p.draftIds.length, 0);
	let best: QuestionPlan | null = null;
	let bestScore = -Infinity;
	for (let i = 0; i < probes.length; i++) {
		const byOutcome = new Map<string, { outcome: Outcome; positionIds: string[]; draftIds: string[] }>();
		for (const p of positions) {
			const o = p.outcomes[i];
			const key = outcomeKey(o);
			const g = byOutcome.get(key);
			if (g) {
				g.positionIds.push(p.id);
				g.draftIds.push(...p.draftIds);
			} else byOutcome.set(key, { outcome: o, positionIds: [p.id], draftIds: [...p.draftIds] });
		}
		if (byOutcome.size < 2) continue;
		const groups = [...byOutcome.values()].sort((a, b) => b.draftIds.length - a.draftIds.length);
		const largest = groups[0].draftIds.length;
		const settles = total - largest;
		const score = settles * 1000 - (groups.length - 2) * 50 - cartComplexity(probes[i]) / 100;
		if (score > bestScore) {
			bestScore = score;
			const options = groups.slice(0, maxOptions);
			let fields = differingFields(options.map((g) => g.outcome));
			if (!fields.length) {
				// One option rejects the cart: bind the others on what the customer would pay.
				const ok = options.map((g) => g.outcome).filter((o) => !isError(o)) as Partial<Record<BehaviorField, number>>[];
				fields = (["discount", "total"] as BehaviorField[]).filter((f) => ok.some((o) => o[f] !== undefined));
			}
			best = {
				probeIndex: i,
				fields,
				options: options.map((g) => ({ ...g, outcome: restrict(g.outcome, fields) })),
				settles,
			};
		}
	}
	return best;
}

/** Combine two carts so one probe exercises two features at once (interaction probes). */
export function combineCarts(a: Cart, b: Cart): Cart {
	const out: Cart = { ...b, ...a };
	const itemsA = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : [];
	const itemsB = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
	const seen = new Set(itemsA.map((i) => i.sku));
	out.items = [...itemsA, ...itemsB.filter((i) => !seen.has(i.sku))];
	return out;
}

/** Deduplicate carts by canonical JSON, keeping order. */
export function dedupeCarts(carts: Cart[], limit = 48): Cart[] {
	const seen = new Set<string>();
	const out: Cart[] = [];
	for (const c of carts) {
		if (!c || typeof c !== "object" || !Array.isArray((c as { items?: unknown }).items)) continue;
		const key = JSON.stringify(c);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(c);
		if (out.length >= limit) break;
	}
	return out;
}

export function formatCents(n: number | undefined): string {
	if (n === undefined) return "–";
	const sign = n < 0 ? "-" : "";
	return `${sign}€${(Math.abs(n) / 100).toFixed(2)}`;
}

/** A compact human description of an outcome for prompts and labels. */
export function describeOutcome(o: Outcome): string {
	if (isError(o)) return "rejects the cart";
	return Object.entries(o)
		.map(([f, v]) => `${f} ${f === "points" ? v : formatCents(v as number)}`)
		.join(", ");
}
