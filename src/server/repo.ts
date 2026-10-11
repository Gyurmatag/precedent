// Artifacts helpers: repo lookup, forks with retry, reading trees, and
// committing a full file map by pushing only the objects that are new.
import { blob, buildTreeFromFiles, commit, lsRefs, push, tree, ZERO_SHA, type GitObject, type RefUpdate } from "./git.ts";

export const AUTHOR = { name: "Precedent", email: "court@precedent.dev" };

export async function getRepo(env: Env, name: string): Promise<ArtifactsRepo> {
	return env.ARTIFACTS.get(name);
}

export async function createRepo(env: Env, name: string, description: string) {
	const created = await env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" });
	return { name: created.name, remote: created.remote };
}

export async function writeToken(env: Env, name: string, ttl = 900): Promise<string> {
	const repo = await env.ARTIFACTS.get(name);
	return (await repo.createToken("write", ttl)).plaintext;
}

export async function readToken(env: Env, name: string, ttl = 3600): Promise<string> {
	const repo = await env.ARTIFACTS.get(name);
	return (await repo.createToken("read", ttl)).plaintext;
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Wait until a repo that is still being created or forked answers metadata reads. */
async function waitReady(env: Env, name: string, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const repo = await env.ARTIFACTS.get(name);
			const info = await repo.info();
			return { name: info.name, remote: info.remote };
		} catch (e) {
			lastError = e;
			await sleep(800);
		}
	}
	throw lastError;
}

/**
 * Fork with retries. Parallel forks occasionally fail with a transient internal
 * error, and a failed attempt may still have created the fork in the background.
 */
export async function forkWithRetry(env: Env, source: string, name: string, attempts = 5) {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			const src = await env.ARTIFACTS.get(source);
			await src.fork(name, { description: `Draft fork of ${source}` });
			return await waitReady(env, name);
		} catch (e) {
			lastError = e;
			const msg = String((e as Error)?.message ?? e);
			if (/already exists|in progress/i.test(msg)) return await waitReady(env, name);
			await sleep(400 * 2 ** i + Math.random() * 400);
		}
	}
	throw lastError;
}

/** Recursively read every file under a tree. */
export async function readTreeFiles(repo: ArtifactsRepo, treeHash: string, prefix = ""): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const entries = (await repo.readTree(treeHash)) ?? [];
	await Promise.all(
		entries.map(async (e) => {
			const path = prefix + e.name;
			if (e.type === "tree") Object.assign(out, await readTreeFiles(repo, e.hash, `${path}/`));
			else if (e.type === "blob" || e.type === "exec") {
				const b = await repo.readBlob(e.hash);
				if (b) out[path] = await b.text();
			}
		}),
	);
	return out;
}

/** All object hashes (trees and blobs) reachable from a tree, so pushes can skip them. */
async function treeObjectHashes(repo: ArtifactsRepo, treeHash: string, into = new Set<string>()): Promise<Set<string>> {
	into.add(treeHash);
	const entries = (await repo.readTree(treeHash)) ?? [];
	await Promise.all(
		entries.map(async (e) => {
			if (e.type === "tree") await treeObjectHashes(repo, e.hash, into);
			else into.add(e.hash);
		}),
	);
	return into;
}

export async function readFilesAt(env: Env, repoName: string, commitSha: string) {
	const repo = await env.ARTIFACTS.get(repoName);
	const c = await repo.readCommit(commitSha);
	if (!c) throw new Error(`commit ${commitSha} not found in ${repoName}`);
	return { treeHash: c.treeHash, files: await readTreeFiles(repo, c.treeHash) };
}

/** Git tree hash of a file map: the content address used for caching examinations. */
export async function treeHashOf(files: Record<string, string>): Promise<string> {
	return (await buildTreeFromFiles(files)).root;
}

export interface CommitPlan {
	repoName: string;
	remote: string;
	token: string;
	ref: string; // e.g. refs/heads/main
	expectedOld: string; // compare-and-swap expectation (ZERO_SHA to create)
	parents: string[];
	parentTree?: string; // tree of the parent, to skip already-present objects
	files: Record<string, string>;
	message: string;
	note?: { ref: string; text: string }; // optional git note attached to the new commit
}

export interface CommitResult {
	ok: boolean;
	commit: string;
	tree: string;
	objectsPushed: number;
	reason?: string;
}

/**
 * Commit a complete file map on top of `parents` and update `ref` with a
 * compare-and-swap push. Only objects missing from the parent tree are sent.
 */
export async function commitFiles(env: Env, plan: CommitPlan): Promise<CommitResult> {
	const { root, objects } = await buildTreeFromFiles(plan.files);
	const c = await commit({ tree: root, parents: plan.parents, author: AUTHOR, message: plan.message });
	let known = new Set<string>();
	if (plan.parentTree) {
		const repo = await env.ARTIFACTS.get(plan.repoName);
		known = await treeObjectHashes(repo, plan.parentTree);
	}
	const fresh = dedupe(objects.filter((o) => !known.has(o.sha)));
	const updates: RefUpdate[] = [{ ref: plan.ref, oldSha: plan.expectedOld, newSha: c.sha }];
	const send: GitObject[] = [...fresh, c];

	if (plan.note) {
		const noteObjs = await buildNote(env, plan, c.sha);
		updates.push(noteObjs.update);
		send.push(...noteObjs.objects);
	}

	const res = await push(plan.remote, plan.token, updates, send);
	const main = res.refs[plan.ref];
	return {
		ok: !!main?.ok && res.unpack === "ok",
		commit: c.sha,
		tree: root,
		objectsPushed: send.length,
		reason: main?.ok ? undefined : (main?.reason ?? res.unpack ?? res.raw.join(" ")),
	};
}

function dedupe(objects: GitObject[]): GitObject[] {
	const seen = new Set<string>();
	return objects.filter((o) => (seen.has(o.sha) ? false : (seen.add(o.sha), true)));
}

/** Append a note for `target` to a notes ref (refs/notes/precedent), keeping earlier notes. */
async function buildNote(env: Env, plan: CommitPlan, target: string) {
	const note = plan.note!;
	const adv = await lsRefs(plan.remote, plan.token);
	const notesHead = adv.refs[note.ref];
	const entries: { name: string; mode: string; sha: string }[] = [];
	if (notesHead) {
		const repo = await env.ARTIFACTS.get(plan.repoName);
		const nc = await repo.readCommit(notesHead);
		for (const e of (nc && (await repo.readTree(nc.treeHash))) ?? []) entries.push({ name: e.name, mode: e.mode, sha: e.hash });
	}
	const b = await blob(note.text.endsWith("\n") ? note.text : `${note.text}\n`);
	const kept = entries.filter((e) => e.name !== target);
	const t = await tree([...kept, { name: target, mode: "100644", sha: b.sha }]);
	const nc = await commit({ tree: t.sha, parents: notesHead ? [notesHead] : [], author: AUTHOR, message: "Notes added by Precedent" });
	return { update: { ref: note.ref, oldSha: notesHead ?? ZERO_SHA, newSha: nc.sha } as RefUpdate, objects: [b, t, nc] };
}

export async function headOf(remote: string, token: string, ref = "refs/heads/main"): Promise<string | undefined> {
	return (await lsRefs(remote, token)).refs[ref];
}

export async function deleteRepos(env: Env, prefix: string): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	const names: string[] = [];
	do {
		const page = await env.ARTIFACTS.list({ limit: 100, cursor });
		for (const r of page.repos) if (r.name.startsWith(prefix)) names.push(r.name);
		cursor = page.cursor;
	} while (cursor);
	for (const n of names) {
		try {
			await env.ARTIFACTS.delete(n);
			deleted++;
		} catch {
			// best effort
		}
	}
	return deleted;
}
