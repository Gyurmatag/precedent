// Worker entry: session API, read-only repo access, and Agents SDK routing for
// the live UI (each session's Court is a Durable Object the browser subscribes to).
import { getAgentByName, routeAgentRequest } from "agents";
import { Court, type SessionConfig } from "./court.ts";
import { FEATURES } from "./seed.ts";
import { readToken } from "./repo.ts";

export { Court } from "./court.ts";
export { Associate } from "./associate.ts";

const DEFAULT_FEATURES = ["percent-coupon", "bogo-mugs", "free-shipping", "member-discount", "gift-card", "loyalty-points"];
const MAX_DRAFTS = 60;

function json(data: unknown, status = 200) {
	return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function newSessionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

async function court(env: Env, id: string) {
	return getAgentByName<Env, Court>(env.Court, id);
}

async function createSession(request: Request, env: Env) {
	const body = (await request.json().catch(() => ({}))) as Partial<SessionConfig>;
	const featureIds = (body.featureIds?.length ? body.featureIds : DEFAULT_FEATURES).filter((id) => FEATURES.some((f) => f.id === id));
	const agentsPerFeature = Math.max(2, Math.min(6, Number(body.agentsPerFeature ?? 4)));
	if (!featureIds.length) return json({ error: "choose at least one ticket" }, 400);
	if (featureIds.length * agentsPerFeature > MAX_DRAFTS) return json({ error: `at most ${MAX_DRAFTS} agents per session` }, 400);

	const registry = await court(env, "registry");
	if (!(await registry.admit(Number(env.MAX_SESSIONS_PER_DAY ?? 40))))
		return json({ error: "Today's demo budget is used up. Watch a recorded session, or self-host (see README)." }, 429);

	const id = newSessionId();
	const result = await (await court(env, id)).start({ featureIds, agentsPerFeature });
	if (!result.ok) return json({ error: result.error }, 500);
	return json({ id });
}

/** Read a file from a session's trunk or one of its draft forks, at any ref. */
async function readSessionFile(env: Env, id: string, url: URL) {
	const repoName = url.searchParams.get("repo") ?? `s${id}-trunk`;
	if (!repoName.startsWith(`s${id}-`)) return json({ error: "not part of this session" }, 403);
	const ref = url.searchParams.get("ref") ?? "main";
	const path = url.searchParams.get("path");
	if (!path) return json({ error: "path required" }, 400);
	const repo = await env.ARTIFACTS.get(repoName);
	const file = await repo.readFile({ ref, path });
	if (!file) return json({ error: "not found" }, 404);
	return new Response(await file.text(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** A short-lived, read-only capability URL so anyone can `git clone` the trunk. */
async function cloneUrl(env: Env, id: string) {
	const name = `s${id}-trunk`;
	const repo = await env.ARTIFACTS.get(name);
	const info = await repo.info();
	const secret = (await readToken(env, name, 3600)).split("?expires=")[0];
	const remote = info.remote.replace(/^https:\/\//, `https://x:${secret}@`);
	return json({ remote: info.remote, cloneUrl: remote, expiresIn: 3600 });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/agents/")) {
			// Only session Courts are reachable from browsers; Associates and the registry are internal.
			if (!/^\/agents\/court\/[a-z0-9]{6,12}(\/|$|\?)/.test(url.pathname + url.search)) return json({ error: "not found" }, 404);
			return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
		}

		try {
			if (url.pathname === "/api/features" && request.method === "GET") {
				return json({
					features: FEATURES,
					defaults: DEFAULT_FEATURES,
					maxDrafts: MAX_DRAFTS,
					showcase: env.SHOWCASE_SESSION || null,
					source: env.SOURCE_URL || null,
				});
			}
			if (url.pathname === "/api/sessions" && request.method === "POST") return await createSession(request, env);

			const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{6,12})\/(file|clone|state|rule|overrule)$/);
			if (m && m[2] === "state" && request.method === "GET") return json(await (await court(env, m[1])).getState());
			if (m && m[2] === "overrule" && request.method === "POST") {
				const input = (await request.json()) as { precedentN: number; optionKey: string; rationale?: string };
				return json(await (await court(env, m[1])).overruleFromApi(input));
			}
			if (m && m[2] === "rule" && request.method === "POST") {
				const input = (await request.json()) as { questionId: string; optionKey: string; rationale?: string };
				return json(await (await court(env, m[1])).ruleFromApi(input));
			}
			if (m && m[2] === "file" && request.method === "GET") return await readSessionFile(env, m[1], url);
			if (m && m[2] === "clone" && request.method === "POST") return await cloneUrl(env, m[1]);
		} catch (e) {
			return json({ error: String((e as Error)?.message ?? e) }, 500);
		}
		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
