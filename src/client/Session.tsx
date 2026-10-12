import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import type { CourtState } from "../shared/types.ts";
import { Bench } from "./Bench.tsx";
import { duration } from "./format.ts";
import { Brand } from "./nav.tsx";
import { Activity, Casebook, Swarm, Trunk } from "./Panels.tsx";

function Metrics({ state }: { state: CourtState }) {
	const m = state.metrics;
	const resolved = state.drafts.filter((d) => ["overruled", "chosen", "standing"].includes(d.status)).length;
	const decisions = m.humanRulings;
	const perHundred = m.drafts ? Math.round((m.questions / m.drafts) * 100) : 0;
	return (
		<div className="metrics">
			<div className="metric hero-metric">
				<b>
					{decisions} decision{decisions === 1 ? "" : "s"} · {duration(m.humanMs)}
				</b>
				<span>
					your total time on the bench, governing {resolved} examined drafts across {state.features.length} tickets
				</span>
			</div>
			<div className="metric">
				<b>{m.agents}</b>
				<span>agents</span>
			</div>
			<div className="metric">
				<b>{m.drafts}</b>
				<span>drafts pushed to forks</span>
			</div>
			<div className="metric">
				<b>{m.questions + m.settledByClef}</b>
				<span>
					questions found ({m.settledByClef} settled by Clef)
				</span>
			</div>
			<div className="metric">
				<b>{perHundred}</b>
				<span>questions per 100 drafts</span>
			</div>
			<div className="metric">
				<b>
					{m.landed}/{state.features.length}
				</b>
				<span>tickets landed on trunk</span>
			</div>
		</div>
	);
}

export function Session({ id }: { id: string }) {
	const [state, setState] = useState<CourtState | null>(null);
	const agent = useAgent<CourtState>({
		agent: "court",
		name: id,
		onStateUpdate: (s) => setState(s),
	});

	useEffect(() => {
		// First paint without waiting for the socket.
		fetch(`/api/sessions/${id}/state`)
			.then((r) => (r.ok ? (r.json() as Promise<CourtState>) : null))
			.then((s) => {
				if (s) setState((cur) => cur ?? s);
			})
			.catch(() => undefined);
	}, [id]);

	async function rule(questionId: string, optionKey: string, rationale: string, ms: number) {
		await agent.call("rule", [{ questionId, optionKey, rationale, ms }]);
	}

	async function overrule(precedentN: number, optionKey: string, rationale: string) {
		return (await agent.call("overrule", [{ precedentN, optionKey, rationale }])) as { ok: boolean; error?: string };
	}

	const live = state?.phase === "running";
	return (
		<>
			<div className="topbar">
				<Brand />
				<div className="spacer" />
				{state && <span className={`pill ${live ? "live" : ""}`}>{live ? "session in progress" : state.phase === "done" ? "adjourned" : "idle"}</span>}
				<span className="pill mono">session {id}</span>
			</div>
			{!state ? (
				<div className="waiting">Connecting to the court…</div>
			) : state.phase === "idle" ? (
				<div className="waiting">
					<h3>No session here</h3>
					<div>
						This session doesn't exist or has expired. <a href="/">Start a new one</a>.
					</div>
				</div>
			) : (
				<>
					<Metrics state={state} />
					<main className="session">
						<div className="stack">
							<Swarm state={state} sessionId={id} />
						</div>
						<div className="stack">
							<Bench state={state} onRule={rule} />
							<Activity state={state} />
						</div>
						<div className="stack">
							<Casebook state={state} onOverrule={overrule} />
							<Trunk state={state} sessionId={id} />
						</div>
					</main>
				</>
			)}
		</>
	);
}
