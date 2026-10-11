# Precedent

**Agents write the code. You set the precedent.**

Precedent is a Git platform for the agentic era, built on Cloudflare Workers and Artifacts. Humans never review diffs in it.

A swarm of agents drafts every change in parallel, each on its own model and in its own Artifacts fork. Precedent then:

1. **Cross-examines** the drafts. Each one is booted in an isolated Dynamic Worker and run against every other draft's examples.
2. **Finds the disagreements.** It looks for the exact places where the drafts' *behavior* differs.
3. **Asks you the fewest possible questions:** *"For this cart, which receipt is right?"*

Each answer becomes a **precedent**, a binding, versioned test in the repository that every current and future agent must satisfy. Winning drafts land on `main` with a compare-and-swap push built in the Worker: no clone, no merge button.

> When code is abundant, human decisions are the scarce resource. Precedent spends them only where agents genuinely disagree, and makes every decision count forever.

---

## Why this is different

The blog post asks:

| Question | Precedent's answer |
|---|---|
| How do agents know what other agents are working on? | The **casebook** is the shared channel. A ruling on one ticket binds every agent working now and later; contradicting drafts are overruled instantly. |
| What happens when they make conflicting changes? | Conflicts are defined by **behavior**, not lines.<br>• Drafts that behave identically collapse into one *position*.<br>• Integrations that pass every precedent but behave differently on combined carts become an *interaction question*.<br>• Text-level races on `main` are compare-and-swap rejections that retry. |
| How do you review everything they produce? | You don't read diffs. You answer concrete behavioral questions, chosen to settle as many drafts as possible each time (20-questions style).<br>Clef, Cloudflare's calibrated decision model, settles the questions the ticket already answers, so humans only see real product decisions. |
| How do you keep track of *why* a change was made? | Every precedent records the cart, the expected receipt, who decided and the reason. It lives in `CASEBOOK.md` and `precedents/*.json`.<br>Each landing commit carries trailers (`Precedent-Rulings`, `Precedent-Draft`, `Precedent-Via`) and a git note with the agent's stated assumptions. All of it is plain Git. |

**More agents make it better, not worse.** More agents produce more varied drafts, which expose more edge cases, which become more precedents. The spec sharpens as the swarm grows, and the "questions per 100 drafts" number falls as the casebook fills up.

**No lock-in.** A trunk is an ordinary Git repository: `git clone`, then `npm test` checks every precedent with plain Node.

---

## How it works on Cloudflare

```
Browser (React) ──WebSocket state sync──▶ Court (Agents SDK Durable Object, one per session)
                                             │
             ┌───────────────────────────────┼──────────────────────────────────┐
             ▼                               ▼                                  ▼
  Associates (one DO per agent)      Examiner (Dynamic Workers)          Artifacts
  fork trunk → draft with a          boots each draft by git tree        trunk + one fork per draft;
  Workers AI model → self-check →    hash, network blocked; runs         reads via binding (readTree/
  push a commit to its fork          probe carts through quote()         readFile); writes via our own
                                                                         pack writer + CAS receive-pack
             ▲                               ▲
             └── Workers AI fleet: gpt-oss-120b, nemotron-3, glm-5.3-flash, deepseek-v4-flash,
                 qwen3.8, kimi-k2.7-code · clerk & prosecutor roles · Clef for calibrated triage
```

| Primitive | What Precedent uses it for |
|---|---|
| **Artifacts** | One trunk repo per session and **one fork per draft**. Files are read with `readTree`/`readFile`, with no clones. Commits land through a ~250-line pack writer in `src/server/git.ts`, which pushes only new objects (typically 5–10) with a **compare-and-swap** ref update (`ng refs/heads/main stale ref` on a race). Git notes on `refs/notes/precedent` carry the agents' reasoning. |
| **Durable Objects / Agents SDK** | The `Court` is the session's brain and live UI state. Each `Associate` is one agent with durable identity, scheduled work and RPC. |
| **Dynamic Workers** | The courtroom. Every draft and integration candidate is booted as its own isolate keyed by its git tree hash, with `globalOutbound: null`. It is run against up to 64 probe carts in milliseconds; the same code is never booted twice. |
| **Workers AI** | A deliberately *mixed* model fleet (diversity is what exposes decisions), plus three more roles:<br>• a prosecutor that proposes edge-case carts;<br>• a clerk that phrases each disagreement as a product question;<br>• integrators that rebuild approved behavior on a moved trunk.<br>**Clef** (`@cf/cloudflare/clef`) returns calibrated probabilities that decide whether a question is already settled. |

### Landing a ticket
1. If trunk hasn't moved since the draft forked, the commit is a **fast-forward**.
2. Otherwise Precedent tries a **diff3** merge, and two **integrator agents** rebuild the approved behavior on the current trunk in parallel.
3. Every candidate must satisfy every precedent.
4. If passing candidates still behave differently on carts that combine features, that interaction becomes a question for a human.
5. The winner is pushed with compare-and-swap against the `main` it was verified on.

### Designed for Cloudflare's limits
- **Model rate limits:** frontier Workers AI models allow 20 requests per minute per account. Drafts are spread round-robin across six models, uncapped models carry the clerk work, and each draft uses one or two large-context calls.
- **Trunk throughput:** `main` is a single Durable Object (2,000 git requests per 10 s), so only the Court writes it. Agents read through the binding and write to their own forks.
- **Forks:** they take 2–5 s and occasionally fail transiently when run in parallel, so they are retried, and a fork that is still copying is awaited.
- **Dynamic Workers:** at most 10 run at once per Durable Object, so the Examiner keeps 8 in flight and caches by tree hash.

---

## Try it

**Live demo:** _URL added at submission_

1. Open the demo, keep the default tickets, and press **Convene the swarm**. That starts 24 agents on 6 tickets.
2. Within a few minutes, questions appear on **the bench**. Press `1`/`2`/… and `Enter` to rule, optionally with a one-line reason.
3. Watch drafts collapse, tickets land on trunk, and the casebook grow.
4. Press **Clone with plain git** for a read-only, one-hour URL, then run `npm test` and `git log --notes=precedent` in the clone.

The demo has a daily session budget. If it's used up, self-host below.

## Run it yourself

You need a Cloudflare account on the **Workers Paid** plan (Artifacts is in open beta there), Node.js 22+, and Wrangler logged in (`npx wrangler login`).

```sh
git clone <this repo> precedent && cd precedent
npm install
npm run dev          # Vite + Workers runtime locally; Artifacts and Workers AI run remotely
```

Open http://localhost:5173 and start a session. To deploy your own copy:

```sh
npm run deploy       # vite build && wrangler deploy
```

Configuration lives in `wrangler.jsonc`:
- Artifacts namespace `precedent`, created automatically on first use;
- `MAX_SESSIONS_PER_DAY`;
- the `Court` and `Associate` Durable Objects, the Worker Loader and the AI binding.

### API (scriptable without the UI)

```sh
curl -X POST localhost:5173/api/sessions -d '{"featureIds":["percent-coupon","free-shipping"],"agentsPerFeature":3}'
curl localhost:5173/api/sessions/<id>/state            # full court state as JSON
curl -X POST localhost:5173/api/sessions/<id>/rule -d '{"questionId":"…","optionKey":"B","rationale":"…"}'
curl -X POST localhost:5173/api/sessions/<id>/clone    # read-only capability URL for git clone
```

## Repository map

| Path | What it is |
|---|---|
| `src/server/court.ts` | Session coordinator: dispatch, cross-examination, deliberation, rulings, landing |
| `src/server/associate.ts` | One agent: fork → draft → self-check → push → report |
| `src/server/examiner.ts` | Dynamic Worker harness that runs probe carts against any version of the code |
| `src/server/behavior.ts` | Positions, minimum-question selection, precedent consistency (unit-tested) |
| `src/server/git.ts` | Git object hashing, packfile writer, smart-HTTP receive-pack with compare-and-swap |
| `src/server/repo.ts` | Artifacts helpers: forks with retry, tree reads, commit-by-new-objects, notes |
| `src/server/models.ts`, `prompts.ts` | Model fleet, structured calls, Clef triage, prompts for every role |
| `src/server/seed.ts` | The checkout engine every session starts from, plus the tickets |
| `src/client/*` | The bench, swarm, casebook and trunk UI |

```sh
npm test         # unit tests for behavior analysis
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
