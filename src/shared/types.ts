// Types shared by the Worker (Court, Associates) and the browser UI.

/** A cart as accepted by the checkout engine's quote(cart). Money is integer cents. */
export type Cart = Record<string, unknown>;

/** The fields of a receipt that define behavior. Everything else (labels, ordering) is ignored. */
export const BEHAVIOR_FIELDS = ["subtotal", "discount", "shipping", "tax", "total", "giftCard", "due", "points"] as const;
export type BehaviorField = (typeof BEHAVIOR_FIELDS)[number];

/** What a draft did with one probe cart: a normalized receipt, or a rejection. */
export type Outcome = { error: string } | (Partial<Record<BehaviorField, number>> & { applied?: string[] });

export type DraftStatus = "queued" | "forking" | "drafting" | "pushing" | "examining" | "standing" | "dismissed" | "overruled" | "chosen";

export interface DraftView {
	id: string;
	featureId: string;
	model: string;
	status: DraftStatus;
	repo?: string;
	commit?: string;
	positionId?: string;
	note?: string;
	assumptions: string[];
	ms?: number;
}

export type FeatureStatus = "drafting" | "examining" | "deliberating" | "decided" | "integrating" | "landed" | "blocked";

export interface FeatureView {
	id: string;
	title: string;
	spec: string;
	status: FeatureStatus;
	positions: number;
	note?: string;
	landedCommit?: string;
}

export interface QuestionOption {
	key: string; // "A", "B", ...
	outcome: Outcome;
	label: string; // one-line rule summary written by the clerk
	draftIds: string[];
	models: string[];
	quotes: string[]; // agents' own one-line assumptions supporting this option
	why?: string; // the single assumption that best explains this option (picked by the clerk)
	keepsBehavior?: boolean; // this option is what the code did before the ticket
	applied?: string[]; // the receipt's own labels for the rules it applied (context only)
}

export interface QuestionView {
	id: string;
	featureId: string;
	kind: "feature" | "interaction";
	cart: Cart;
	fields: BehaviorField[]; // the fields the options disagree on
	options: QuestionOption[];
	headline?: string; // the product decision, phrased by the clerk
	leverage: number; // drafts or candidates this answer resolves
	askedAt: number;
	status: "open" | "ruled" | "settled";
	triage?: { settledBy: "clef"; option: string; p: number } | { open: true; p: number };
}

export interface PrecedentView {
	id: string;
	n: number;
	featureId: string;
	title: string; // the rule, in words
	cart: Cart;
	expect: Outcome;
	rationale?: string;
	decidedBy: "human" | "clef";
	decidedAt: number;
	overruled?: boolean;
	overruledBy?: number;
	overrules?: number;
	questionId?: string;
	landedIn?: string;
}

export interface LandingView {
	commit: string;
	featureIds: string[];
	precedents: number[];
	via: "fast-forward" | "diff3" | "integrator";
	at: number;
}

export interface EventView {
	at: number;
	kind: "info" | "draft" | "question" | "ruling" | "landing" | "warn";
	text: string;
}

export interface Metrics {
	agents: number;
	drafts: number;
	standing: number;
	questions: number;
	settledByClef: number;
	humanRulings: number;
	humanMs: number;
	landed: number;
	llmCalls: number;
}

export interface CourtState {
	sessionId: string | null;
	phase: "idle" | "running" | "done";
	trunk: { repo: string; remote: string; head: string } | null;
	features: FeatureView[];
	drafts: DraftView[];
	docket: QuestionView[];
	casebook: PrecedentView[];
	landings: LandingView[];
	events: EventView[];
	metrics: Metrics;
	startedAt: number | null;
}

export interface FeatureSpec {
	id: string;
	title: string;
	spec: string;
}
