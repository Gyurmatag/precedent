// Minimal Git object/pack writer and smart-HTTP receive-pack client.
// Lets a Worker create commits on an Artifacts repo without cloning it:
// only the new objects (blobs, changed trees, commit) are packed and pushed,
// and the ref update is a compare-and-swap on the expected old commit.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ZERO_SHA = "0".repeat(40);

export type ObjectType = "commit" | "tree" | "blob";
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

export interface GitObject {
	type: ObjectType;
	sha: string;
	content: Uint8Array;
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function sha1(data: Uint8Array): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-1", data as BufferSource);
}

export async function hashObject(type: ObjectType, content: Uint8Array): Promise<GitObject> {
	const header = enc.encode(`${type} ${content.length}\0`);
	const sha = toHex(await sha1(concat([header, content])));
	return { type, sha, content };
}

export function blob(content: string | Uint8Array): Promise<GitObject> {
	return hashObject("blob", typeof content === "string" ? enc.encode(content) : content);
}

export interface TreeEntry {
	name: string;
	mode: string; // "100644" file, "100755" exec, "40000" tree
	sha: string;
}

// Git sorts tree entries by name, comparing directories as if they ended in "/".
function treeSortKey(e: TreeEntry): string {
	return e.mode === "40000" ? `${e.name}/` : e.name;
}

export function tree(entries: TreeEntry[]): Promise<GitObject> {
	const sorted = [...entries].sort((a, b) => {
		const ka = treeSortKey(a);
		const kb = treeSortKey(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	const parts: Uint8Array[] = [];
	for (const e of sorted) {
		parts.push(enc.encode(`${e.mode} ${e.name}\0`), fromHex(e.sha));
	}
	return hashObject("tree", concat(parts));
}

export interface Signature {
	name: string;
	email: string;
	timestamp?: number; // unix seconds
}

function sig(s: Signature): string {
	const ts = s.timestamp ?? Math.floor(Date.now() / 1000);
	return `${s.name} <${s.email}> ${ts} +0000`;
}

export function commit(opts: {
	tree: string;
	parents: string[];
	author: Signature;
	committer?: Signature;
	message: string;
}): Promise<GitObject> {
	const lines = [`tree ${opts.tree}`, ...opts.parents.map((p) => `parent ${p}`)];
	lines.push(`author ${sig(opts.author)}`, `committer ${sig(opts.committer ?? opts.author)}`);
	const message = opts.message.endsWith("\n") ? opts.message : `${opts.message}\n`;
	return hashObject("commit", enc.encode(`${lines.join("\n")}\n\n${message}`));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	// "deflate" is the zlib (RFC 1950) format, which is what packfiles use.
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packObjectHeader(type: ObjectType, size: number): Uint8Array {
	const bytes: number[] = [];
	let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
	size >>= 4;
	while (size > 0) {
		bytes.push(byte | 0x80);
		byte = size & 0x7f;
		size >>= 7;
	}
	bytes.push(byte);
	return new Uint8Array(bytes);
}

export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
	const header = new Uint8Array(12);
	header.set(enc.encode("PACK"), 0);
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, objects.length);
	const parts: Uint8Array[] = [header];
	for (const o of objects) {
		parts.push(packObjectHeader(o.type, o.content.length), await deflate(o.content));
	}
	const body = concat(parts);
	return concat([body, new Uint8Array(await sha1(body))]);
}

function pktLine(payload: string): Uint8Array {
	const bytes = enc.encode(payload);
	return concat([enc.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

const FLUSH = enc.encode("0000");

function parsePktLines(data: Uint8Array): string[] {
	const lines: string[] = [];
	let i = 0;
	while (i + 4 <= data.length) {
		const len = parseInt(dec.decode(data.subarray(i, i + 4)), 16);
		if (Number.isNaN(len)) break;
		if (len === 0) {
			lines.push("");
			i += 4;
			continue;
		}
		lines.push(dec.decode(data.subarray(i + 4, i + len)));
		i += len;
	}
	return lines;
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "User-Agent": "git/2.45.0 precedent/0.1" };
}

export interface RefAdvertisement {
	refs: Record<string, string>;
	capabilities: string[];
}

/**
 * Read current refs from a smart-HTTP advertisement (cheap, no clone).
 * receive-pack needs a write token and also lists push capabilities;
 * upload-pack works with read tokens too.
 */
export async function lsRefs(
	remote: string,
	token: string,
	service: "git-receive-pack" | "git-upload-pack" = "git-receive-pack",
): Promise<RefAdvertisement> {
	const res = await fetch(`${remote}/info/refs?service=${service}`, { headers: authHeaders(token) });
	if (!res.ok) throw new Error(`info/refs failed: ${res.status} ${await res.text()}`);
	const lines = parsePktLines(new Uint8Array(await res.arrayBuffer()));
	const refs: Record<string, string> = {};
	let capabilities: string[] = [];
	for (const line of lines) {
		if (!line || line.startsWith("#")) continue;
		const [refPart, caps] = line.replace(/\n$/, "").split("\0");
		if (caps !== undefined) capabilities = caps.split(" ");
		const [sha, name] = refPart.split(" ");
		if (name && name !== "capabilities^{}") refs[name] = sha;
	}
	return { refs, capabilities };
}

export interface RefUpdate {
	ref: string;
	oldSha: string; // ZERO_SHA to create
	newSha: string;
}

export interface PushResult {
	ok: boolean;
	unpack: string;
	refs: Record<string, { ok: boolean; reason?: string }>;
	raw: string[];
}

/**
 * Push objects and update refs. Each ref update is a compare-and-swap:
 * the server rejects it if the ref no longer points at oldSha.
 */
export async function push(
	remote: string,
	token: string,
	updates: RefUpdate[],
	objects: GitObject[],
	opts: { atomic?: boolean } = {},
): Promise<PushResult> {
	const caps = ["report-status", ...(opts.atomic ? ["atomic"] : [])].join(" ");
	const commands = updates.map((u, i) =>
		pktLine(`${u.oldSha} ${u.newSha} ${u.ref}${i === 0 ? `\0${caps}` : ""}\n`),
	);
	const pack = await buildPack(objects);
	const body = concat([...commands, FLUSH, pack]);
	const res = await fetch(`${remote}/git-receive-pack`, {
		method: "POST",
		headers: {
			...authHeaders(token),
			"Content-Type": "application/x-git-receive-pack-request",
			Accept: "application/x-git-receive-pack-result",
		},
		body: body as BodyInit,
	});
	const raw = parsePktLines(new Uint8Array(await res.arrayBuffer()));
	const result: PushResult = { ok: res.ok, unpack: "", refs: {}, raw };
	for (const line of raw) {
		const l = line.replace(/\n$/, "");
		if (l.startsWith("unpack ")) result.unpack = l.slice(7);
		else if (l.startsWith("ok ")) result.refs[l.slice(3)] = { ok: true };
		else if (l.startsWith("ng ")) {
			const [ref, ...reason] = l.slice(3).split(" ");
			result.refs[ref] = { ok: false, reason: reason.join(" ") };
		}
	}
	result.ok = res.ok && result.unpack === "ok" && updates.every((u) => result.refs[u.ref]?.ok);
	return result;
}

/** Build tree objects for a full set of files (path -> content). Returns root tree + all objects. */
export async function buildTreeFromFiles(
	files: Record<string, string | Uint8Array>,
): Promise<{ root: string; objects: GitObject[] }> {
	const objects: GitObject[] = [];
	interface Dir {
		files: Map<string, string>;
		dirs: Map<string, Dir>;
	}
	const rootDir: Dir = { files: new Map(), dirs: new Map() };
	for (const [path, content] of Object.entries(files)) {
		const segments = path.split("/");
		let dir = rootDir;
		for (const seg of segments.slice(0, -1)) {
			if (!dir.dirs.has(seg)) dir.dirs.set(seg, { files: new Map(), dirs: new Map() });
			dir = dir.dirs.get(seg)!;
		}
		const b = await blob(content);
		objects.push(b);
		dir.files.set(segments[segments.length - 1], b.sha);
	}
	async function write(dir: Dir): Promise<string> {
		const entries: TreeEntry[] = [];
		for (const [name, sha] of dir.files) entries.push({ name, mode: "100644", sha });
		for (const [name, child] of dir.dirs) entries.push({ name, mode: "40000", sha: await write(child) });
		const t = await tree(entries);
		objects.push(t);
		return t.sha;
	}
	const root = await write(rootDir);
	return { root, objects };
}
