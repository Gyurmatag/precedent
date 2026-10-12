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

/** Instructions an external agent (Claude Code, Codex, ...) can follow to join a live session. */
function joinInstructions(origin: string, id: string): string {
	const api = `${origin}/api/sessions/${id}`;
	return `# Join Precedent session ${id}

You are joining a swarm of agents. Several agents draft the same tickets in parallel. Precedent
cross-examines every draft against the others and asks a human only where behavior disagrees.
Watch the session at ${origin}/s/${id}

## 1. Take a seat
\`\`\`sh
curl -s -X POST ${api}/seats -H 'content-type: application/json' -d '{"name":"claude-code"}' > seat.json
\`\`\`
\`seat.json\` contains your ticket, your own Artifacts fork (\`seat.remote\`), a write token scoped to that
fork (\`seat.token\`, valid 1 hour), \`seat.secret\` for submitting, and the binding \`seat.precedents\`.
Keep the token out of files, git config and logs.

## 2. Clone your fork
\`\`\`sh
REMOTE=$(jq -r .seat.remote seat.json); TOKEN=$(jq -r .seat.token seat.json)
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone "$REMOTE" work && cd work
\`\`\`

## 3. Implement the ticket
Read \`AGENTS.md\`. Implement \`seat.ticket\` in \`src/\` (plain JavaScript, no dependencies). Every
precedent in \`seat.precedents\` must hold. \`npm test\` checks the ones already in the repo.
Whenever the ticket leaves a product decision open, make a reasonable choice and note it in one sentence.

## 4. Push to the \`draft\` branch of your fork
\`\`\`sh
git checkout -b draft && git add -A && git commit -m "Draft: <ticket title>"
git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin draft
\`\`\`

## 5. Submit
\`\`\`sh
curl -s -X POST ${api}/seats/$(jq -r .seat.draftId ../seat.json)/submit -H 'content-type: application/json' \\
  -d '{"secret":"<seat.secret>","assumptions":["<one sentence per decision>"],"examples":[{"input":{"items":[...]},"expected":{"total":1234}}]}'
\`\`\`
Your draft is now cross-examined alongside the swarm's drafts. If it disagrees with them, a human decides,
and the ruling binds everyone, including you.
`;
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

			const seat = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{6,12})\/seats(?:\/([a-z0-9-]{3,60})\/submit)?$/);
			if (seat && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
				const c = await court(env, seat[1]);
				if (!seat[2]) {
					const r = await c.openSeat({ featureId: typeof body.featureId === "string" ? body.featureId : undefined, name: typeof body.name === "string" ? body.name : undefined });
					return json(r, r.ok ? 200 : 409);
				}
				const r = await c.submitSeat({ draftId: seat[2], secret: String(body.secret ?? ""), assumptions: body.assumptions, examples: body.examples });
				return json(r, r.ok ? 200 : 409);
			}
			const join = url.pathname.match(/^\/api\/sessions\/([a-z0-9]{6,12})\/join$/);
			if (join && request.method === "GET") return new Response(joinInstructions(url.origin, join[1]), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

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
