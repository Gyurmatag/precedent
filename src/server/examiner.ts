// The Examiner boots a version of the code as a Dynamic Worker (one isolate per
// git tree hash, so identical code is never booted twice) and runs probe carts
// through quote(). Network access is blocked; the code only ever sees the cart.
import { BEHAVIOR_FIELDS, type Cart, type Outcome } from "../shared/types.ts";

const HARNESS = `
let engine;
let loadError = null;
async function load() {
  if (engine || loadError) return;
  try {
    engine = await import("./src/checkout.js");
  } catch (e) {
    loadError = String((e && e.message) || e);
  }
}

function normalize(receipt) {
  if (!receipt || typeof receipt !== "object") return { error: "quote() did not return a receipt" };
  const out = {};
  for (const f of ${JSON.stringify(BEHAVIOR_FIELDS)}) {
    const v = receipt[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = Math.round(v);
  }
  return out;
}

export default {
  async fetch(request) {
    const { probes } = await request.json();
    await load();
    if (loadError || !engine || typeof engine.quote !== "function") {
      return Response.json({ loadError: loadError ?? "src/checkout.js does not export quote()" });
    }
    const outcomes = probes.map((cart) => {
      try {
        return normalize(engine.quote(structuredClone(cart)));
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 200) };
      }
    });
    return Response.json({ outcomes });
  },
};
`;

export interface Examination {
	loadError?: string;
	outcomes: Outcome[];
	ms: number;
}

// At most 10 Dynamic Workers may be in flight per Durable Object; stay below that.
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire() {
	if (inFlight < 8) {
		inFlight++;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
	inFlight++;
}
function release() {
	inFlight--;
	waiters.shift()?.();
}

/** Run probes against the code in `files`, identified by its git tree hash. */
export async function examine(env: Env, treeHash: string, files: Record<string, string>, probes: Cart[]): Promise<Examination> {
	const t0 = Date.now();
	await acquire();
	try {
		const worker = env.LOADER.get(`tree-${treeHash}`, async () => {
			const modules: Record<string, string> = { "harness.js": HARNESS };
			for (const [path, content] of Object.entries(files)) if (path.startsWith("src/") && path.endsWith(".js")) modules[path] = content;
			return { compatibilityDate: "2026-10-01", mainModule: "harness.js", modules, globalOutbound: null };
		});
		const call = worker.getEntrypoint().fetch("http://examiner/", { method: "POST", body: JSON.stringify({ probes }) });
		const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("examination timed out (possible infinite loop)")), 8000));
		const res = await Promise.race([call, timeout]);
		const body = (await res.json()) as { loadError?: string; outcomes?: Outcome[] };
		if (body.loadError) return { loadError: body.loadError, outcomes: probes.map(() => ({ error: "load error" })), ms: Date.now() - t0 };
		return { outcomes: body.outcomes ?? [], ms: Date.now() - t0 };
	} catch (e) {
		return { loadError: String((e as Error)?.message ?? e), outcomes: probes.map(() => ({ error: "load error" })), ms: Date.now() - t0 };
	} finally {
		release();
	}
}
