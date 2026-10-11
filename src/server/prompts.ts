// Prompts and JSON schemas for every model role in Precedent.
import type { Cart, FeatureSpec, Outcome } from "../shared/types.ts";
import { describeOutcome } from "./behavior.ts";

export interface PrecedentBrief {
	n: number;
	title: string;
	cart: Cart;
	expect: Outcome;
}

const AGENT_SYSTEM =
	"You are a software engineering agent. Many other agents work on the same codebase at the same time, each in its own copy. Follow AGENTS.md. Respond with JSON only.";

function repoListing(files: Record<string, string>): string {
	return Object.entries(files)
		.filter(([p]) => p.startsWith("src/") || p === "AGENTS.md")
		.map(([p, c]) => `--- ${p} ---\n${c}`)
		.join("\n");
}

function precedentList(precedents: PrecedentBrief[]): string {
	if (!precedents.length) return "";
	return `\nBinding precedents (decided by humans; quote() must satisfy every one):\n${precedents
		.map((p) => `- #${p.n} ${p.title}\n  cart: ${JSON.stringify(p.cart)}\n  expected: ${describeOutcome(p.expect)}`)
		.join("\n")}\n`;
}

export const DRAFT_SCHEMA = {
	type: "object",
	properties: {
		files: {
			type: "array",
			items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
		},
		examples: {
			type: "array",
			items: { type: "object", properties: { input: { type: "object" }, expected: { type: "object" } }, required: ["input", "expected"] },
		},
		assumptions: { type: "array", items: { type: "string" } },
	},
	required: ["files", "examples", "assumptions"],
};

export interface DraftOutput {
	files: { path: string; content: string }[];
	examples: { input: Cart; expected: Record<string, unknown> }[];
	assumptions: string[];
}

export function draftPrompt(feature: FeatureSpec, files: Record<string, string>, precedents: PrecedentBrief[]) {
	const user = `${repoListing(files)}
${precedentList(precedents)}
Ticket: ${feature.title}
${feature.spec}

Implement the ticket. Return JSON with:
- files: the full new content of every file you change or add (only under src/).
- examples: 3 to 6 examples for this ticket, each { input: cart, expected: { only the receipt fields you assert } }. Include edge cases. Money is integer cents.
- assumptions: one short sentence for each product decision the ticket did not specify.
Keep the receipt contract from AGENTS.md. Do not touch precedents/ or test/.`;
	return { system: AGENT_SYSTEM, user };
}

export function repairPrompt(
	feature: FeatureSpec,
	files: Record<string, string>,
	precedents: PrecedentBrief[],
	previous: DraftOutput,
	problems: string[],
) {
	const base = draftPrompt(feature, files, precedents);
	const user = `${base.user}

Your previous attempt had problems:
${problems.map((p) => `- ${p}`).join("\n")}

Previous files:
${previous.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n")}

Fix the problems and return the complete JSON again.`;
	return { system: AGENT_SYSTEM, user };
}

export const PROBES_SCHEMA = {
	type: "object",
	properties: { carts: { type: "array", items: { type: "object" } } },
	required: ["carts"],
};

export function prosecutorPrompt(feature: FeatureSpec, agentsMd: string) {
	return {
		system: "You design test inputs that reveal where different reasonable implementations disagree. Respond with JSON only.",
		user: `${agentsMd}

Ticket: ${feature.title}
${feature.spec}

Several agents are implementing this ticket independently, and the ticket leaves decisions open.
Propose 8 carts that would expose differences between reasonable implementations: boundaries,
rounding, interaction with tax and shipping, extreme or invalid values. Use the cart format above,
with integer cent prices and realistic item names. Return { "carts": [ ... ] }.`,
	};
}

export const CLERK_SCHEMA = {
	type: "object",
	properties: {
		headline: { type: "string" },
		labels: {
			type: "array",
			items: {
				type: "object",
				properties: { key: { type: "string" }, label: { type: "string" }, why: { type: "string" } },
				required: ["key", "label"],
			},
		},
	},
	required: ["headline", "labels"],
};

export interface ClerkOutput {
	headline: string;
	labels: { key: string; label: string; why?: string }[];
}

export function clerkPrompt(
	feature: FeatureSpec,
	cart: Cart,
	options: { key: string; outcome: Outcome; quotes: string[] }[],
) {
	return {
		system: "You are a court clerk. You turn disagreements between implementations into one plain-language product question. Respond with JSON only.",
		user: `Ticket: ${feature.title}
${feature.spec}

Agents implemented the ticket differently. For this cart:
${JSON.stringify(cart)}

their implementations produce different receipts:
${options.map((o) => `${o.key}: ${describeOutcome(o.outcome)}\n   their stated assumptions: ${o.quotes.slice(0, 4).join(" | ") || "none"}`).join("\n")}

Return:
- headline: the product decision a human must make, as a question of at most 12 words.
- labels: for each option key, the rule it implies, in at most 10 words, and "why": the one stated
  assumption (quoted verbatim from that option's list) that best explains it, or "" if none does.`,
	};
}

export const INTEGRATE_SCHEMA = {
	type: "object",
	properties: {
		files: {
			type: "array",
			items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
		},
	},
	required: ["files"],
};

export function integratorPrompt(
	feature: FeatureSpec,
	trunkFiles: Record<string, string>,
	approvedChanged: Record<string, string>,
	assumptions: string[],
	precedents: PrecedentBrief[],
	problems: string[] = [],
) {
	return {
		system:
			"You integrate an approved change into the current trunk. Behavior that humans approved is the source of truth, not the text of the old change. Respond with JSON only.",
		user: `Current trunk:
${repoListing(trunkFiles)}
${precedentList(precedents)}
Ticket to integrate: ${feature.title}
${feature.spec}

The approved implementation was written against an older trunk. Its versions of the files it changed:
${Object.entries(approvedChanged)
	.map(([p, c]) => `--- ${p} (approved draft) ---\n${c}`)
	.join("\n")}

Its stated assumptions: ${assumptions.join(" | ") || "none"}

Write the current trunk's src/ files so that quote() keeps every existing behavior and precedent,
and adds this ticket exactly as the approved implementation behaves.${problems.length ? `\n\nA previous integration attempt failed:\n${problems.map((p) => `- ${p}`).join("\n")}` : ""}
Return { "files": [ { "path", "content" } ] } with the full content of every src/ file you change.`,
	};
}
