import { useEffect, useState } from "react";
import type { FeatureSpec } from "../shared/types.ts";
import { Brand, navigate } from "./nav.tsx";

const STEPS = [
	{ t: "Swarm", d: "Several agents on different models draft every ticket in parallel, each in its own Artifacts fork." },
	{ t: "Cross-examine", d: "Every draft runs against every other draft's examples in isolated Dynamic Workers." },
	{ t: "Decide", d: "Where behavior disagrees you get one concrete question: which receipt is right?" },
	{ t: "Precedent", d: "Your answer becomes a binding test in the repo. Winners land on main by compare-and-swap." },
];

export function Landing() {
	const [features, setFeatures] = useState<FeatureSpec[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [agents, setAgents] = useState(4);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showcase, setShowcase] = useState<string | null>(null);
	const [source, setSource] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/features")
			.then((r) => r.json() as Promise<{ features: FeatureSpec[]; defaults: string[]; showcase: string | null; source: string | null }>)
			.then((d) => {
				setFeatures(d.features);
				setSelected(d.defaults);
				setShowcase(d.showcase);
				setSource(d.source);
			})
			.catch(() => setError("Could not load tickets."));
	}, []);

	const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

	async function start() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ featureIds: selected, agentsPerFeature: agents }),
			});
			const data = (await res.json()) as { id?: string; error?: string };
			if (!res.ok || !data.id) throw new Error(data.error ?? "Could not start a session.");
			navigate(`/s/${data.id}`);
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	}

	return (
		<>
			<div className="topbar">
				<Brand />
				<div className="spacer" />
				{showcase && (
					<a className="pill" href={`/s/${showcase}`} onClick={(e) => (e.preventDefault(), navigate(`/s/${showcase}`))}>
						Watch a finished session
					</a>
				)}
				{source && (
					<a className="pill" href={source} target="_blank" rel="noreferrer">
						Source
					</a>
				)}
			</div>
			<main className="landing">
				<section className="hero">
					<h1>
						Agents write the code.
						<br />
						You set the <em>precedent</em>.
					</h1>
					<p className="lede">
						A Git platform where humans never review diffs. A swarm of agents drafts every change in parallel. Precedent runs
						every draft against every other and finds exactly where their <b>behavior</b> disagrees. You answer a handful of
						concrete questions, and each answer becomes binding case law for every agent that comes after.
					</p>
				</section>

				<div className="steps">
					{STEPS.map((s, i) => (
						<div className="step" key={s.t}>
							<span className="n">{i + 1}</span>
							<b>{s.t}</b>
							<span>{s.d}</span>
						</div>
					))}
				</div>

				<section className="setup">
					<h2>Open a session on a checkout engine</h2>
					<p className="hint">
						Pick the tickets the swarm should work on. They're deliberately terse, like real tickets: the gaps are product
						decisions the agents will disagree on.
					</p>
					<div className="tickets">
						{features.map((f) => (
							<button key={f.id} className={`ticket ${selected.includes(f.id) ? "on" : ""}`} onClick={() => toggle(f.id)}>
								<b>{f.title}</b>
								<span>{f.spec}</span>
							</button>
						))}
					</div>
					<div className="setup-row">
						<label>
							Agents per ticket
							<input type="range" min={2} max={6} value={agents} onChange={(e) => setAgents(Number(e.target.value))} />
							<b>{agents}</b>
						</label>
						<span className="pill">{selected.length * agents} agents in total</span>
						<div className="spacer" />
						<button className="btn primary" disabled={busy || !selected.length} onClick={start}>
							{busy ? "Seeding trunk…" : "Convene the swarm →"}
						</button>
					</div>
					{error && <div className="error">{error}</div>}
				</section>
			</main>
		</>
	);
}
