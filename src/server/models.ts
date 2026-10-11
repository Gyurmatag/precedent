// The model fleet and structured calls. Drafts are deliberately spread across
// different models: diversity is what exposes the decisions worth asking about.

export interface FleetModel {
	id: string;
	label: string;
	capped: boolean; // Workers AI caps some frontier models at 20 requests/min per account
}

export const FLEET: FleetModel[] = [
	{ id: "@cf/openai/gpt-oss-120b", label: "gpt-oss-120b", capped: false },
	{ id: "@cf/nvidia/nemotron-3-120b-a12b", label: "nemotron-3", capped: false },
	{ id: "@cf/zai-org/glm-5.3-flash", label: "glm-5.3-flash", capped: true },
	{ id: "@cf/deepseek-ai/deepseek-v4-flash-0731", label: "deepseek-v4-flash", capped: true },
	{ id: "@cf/qwen/qwen3.8-27b", label: "qwen3.8", capped: false },
	{ id: "@cf/moonshotai/kimi-k2.7-code", label: "kimi-k2.7-code", capped: true },
];

/** Fast, uncapped models for clerk work (labels, probes, integration). */
export const CLERK_MODEL = "@cf/openai/gpt-oss-120b";
/** Integration rewrites whole files, so it uses the strongest coding models. */
export const INTEGRATOR_MODELS = ["@cf/moonshotai/kimi-k2.7-code", "@cf/deepseek-ai/deepseek-v4-flash-0731"];
/** Models for re-drafting a ticket directly on the current trunk. */
export const REDRAFT_MODELS = ["@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-5.3-flash"];
export const CLEF_MODEL = "@cf/cloudflare/clef";

/** Pick models for a feature's drafts: round-robin, offset per feature so every model gets work. */
export function assignModels(featureIndex: number, count: number): FleetModel[] {
	return Array.from({ length: count }, (_, i) => FLEET[(featureIndex + i) % FLEET.length]);
}

export function modelLabel(id: string): string {
	return FLEET.find((m) => m.id === id)?.label ?? id.split("/").pop() ?? id;
}

export interface JsonCallResult<T> {
	data: T;
	ms: number;
	tokens?: number;
}

function extractContent(out: unknown): string | object | undefined {
	const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
	const raw = o?.response ?? o?.choices?.[0]?.message?.content;
	if (typeof raw === "string" || (raw && typeof raw === "object")) return raw as string | object;
	return undefined;
}

function parseJson(raw: string | object): unknown {
	if (typeof raw === "object") return raw;
	const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error("model did not return JSON");
	}
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** One structured call with retries for rate limits, truncation and invalid JSON. */
export async function callJson<T>(
	env: Env,
	model: string,
	system: string,
	user: string,
	schema: object,
	opts: { maxTokens?: number; attempts?: number; effort?: "low" | "medium" | "high" } = {},
): Promise<JsonCallResult<T>> {
	const attempts = opts.attempts ?? 3;
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		const t0 = Date.now();
		try {
			const out = await env.AI.run(model as keyof AiModels, {
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				response_format: { type: "json_schema", json_schema: schema },
				max_tokens: opts.maxTokens ?? 8000,
				reasoning_effort: opts.effort ?? "low",
			} as never);
			const raw = extractContent(out);
			if (raw === undefined || raw === "") throw new Error("empty model output");
			const usage = (out as { usage?: { total_tokens?: number } }).usage;
			return { data: parseJson(raw) as T, ms: Date.now() - t0, tokens: usage?.total_tokens };
		} catch (e) {
			lastError = e;
			const msg = String((e as Error)?.message ?? e);
			const rateLimited = /rate|429|capacity|too many/i.test(msg);
			await sleep(rateLimited ? 4000 * (i + 1) + Math.random() * 3000 : 800 * (i + 1));
		}
	}
	throw lastError;
}

export interface ClefChoice {
	choice: string;
	p: number;
	probabilities: Record<string, number>;
}

/**
 * Ask Clef, Cloudflare's calibrated decision model, which option the ticket and
 * existing precedents already settle (or that nothing settles it).
 */
export async function clefChoose(env: Env, state: string, instructions: string, criteria: Record<string, string>): Promise<ClefChoice | null> {
	try {
		const out = (await env.AI.run(CLEF_MODEL as keyof AiModels, {
			model: "clef",
			state,
			questions: { verdict: { type: "choice", instructions, criteria } },
		} as never)) as { answers?: Record<string, unknown> };
		const verdict = out?.answers?.verdict as
			| { choice?: string; answer?: string; probabilities?: Record<string, number>; options?: Record<string, number> }
			| undefined;
		if (!verdict) return null;
		const probabilities = verdict.probabilities ?? verdict.options ?? {};
		const choice =
			verdict.choice ?? verdict.answer ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
		return { choice, p: probabilities[choice] ?? 0, probabilities };
	} catch {
		return null;
	}
}
