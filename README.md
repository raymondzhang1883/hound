# Hound

Hunt stateful authorization regressions before they ship.

Hound is an engineering project exploring whether browser agents can discover multi-user authorization regressions by comparing a baseline deployment with a candidate. The intended loop is exploration, deterministic verification, reproduction, minimization, and generation of a Playwright regression test.

**Current milestone:** Hound's bounded simple agent discovered the seeded regression, deterministic replay verified it against fresh candidate and baseline state, and the model-free paired minimizer reduced the recorded trajectory from 14 to 12 browser actions. Three fresh confirmation pairs reproduced the result, and Hound emitted a conventional Playwright regression that passes on the baseline and fails on the seeded candidate. The CLI now submits durable runs to a loopback Go/Postgres control plane, streams sanitized events, supports detached execution and cancellation, and uses a separately authenticated local browser worker. Workers commit a checksummed replay plan and allowlisted result before completion, so `show` and the secondary HTML report no longer depend on worker-local files. Historical journals remain available through explicit `--local` commands. Two live control-plane smoke runs added $0.015702 in estimated model cost; cumulative estimated model cost is $0.547931.

## The first regression

The fixture, **Fieldnotes**, is a small collaborative document application. Alice creates a workspace and invites Bob. Bob accepts, opens a document, and can edit it legitimately. Alice then removes Bob while he keeps the editor open.

| Attempt | Baseline | Candidate |
| --- | --- | --- |
| Bob edits while a current member | `200`, edit persists | `200`, edit persists |
| Bob edits after removal, in the session that read the document | `403`, document unchanged | `200`, unauthorized edit persists |
| Bob reads after removal | `403` | `403` |
| Bob edits after removal using a fresh session | `403` | `403` |

The candidate deliberately trusts a session's cached workspace grant on writes. The baseline checks current membership. Authentication survives membership removal in both versions. The application interface is identical; a startup setting selects the one seeded difference.

These are expected behaviors verified by the fixture acceptance suite, not autonomous-discovery benchmark results.

## Run locally

Requires Node.js 22 or later and npm. The commands below target macOS/Linux shells. The fixture and credential-free test suites need no database, Docker, cloud account, or model API key. Durable CLI runs additionally use Docker for the local control plane; only live model exploration needs an API key.

```sh
npm ci
npm run setup:browser
npm run check
npm run demo
./hound --help
```

Start the durable local control plane through Hound itself:

```sh
./hound control up
./hound control status
./hound hunt --preflight
```

`control up` creates owner-readable random credentials in the ignored `.hound/control-plane.env`, builds exact-digest Go and PostgreSQL images, and publishes only the control API on loopback. PostgreSQL is not published. `control down` stops the containers and retains the database volume.

The demo launches two independent processes and starts a fresh execution in each:

| Deployment | Browser URL | Protected harness |
| --- | --- | --- |
| Baseline | http://127.0.0.1:4311 | http://127.0.0.1:4411 |
| Candidate | http://127.0.0.1:4312 | http://127.0.0.1:4412 |

Local demo credentials are intentionally non-secret: Alice uses `alice-local-demo`; Bob uses `bob-local-demo`. They are only fixture accounts. **Do not use real data, real passwords, or expose these servers to a network.** The candidate is intentionally vulnerable and both listeners bind to loopback only.

Use separate browser profiles for Alice and Bob. Ordinary tabs share cookies, and multiple private windows may also share a private session. The browser tests create independent Playwright contexts automatically.

## Walk through the demo

Perform this sequence once on each deployment:

1. Sign in as Alice, create a workspace, and send Bob an invitation.
2. In Bob's separate browser profile, sign in, click **Refresh**, and accept the invitation.
3. Open the workspace and its shared document as Bob. Save a legitimate edit.
4. In Alice's workspace, click **Refresh members**, then **Remove Bob**.
5. Without reloading Bob's editor or signing out, change the document and click **Save document**.

The baseline shows `403`. The candidate saves the edit. Alice can open the document afterward to see whether the edit actually persisted. Reloading Bob's page is denied in both versions.

`Ctrl+C` stops both processes and removes the private demo manifest. Run `npm run demo` again for clean state. State is intentionally discarded on restart. Assets are loaded on startup, so restart after code/UI changes.

## Local agent pilot

The initial model is **GPT-5.4 mini**, pinned to `gpt-5.4-mini-2026-03-17` with medium reasoning. The model decision explains the cost/capability tradeoff. The working `hound-simple-browser@2` policy remains a one-primitive loop; it adds a generic causal authorization-test method without a fixture sequence or planner. One positive and one both-correct live invocation are encouraging integration evidence, not detection- or false-positive-rate estimates.

```sh
./hound hunt --preflight
npm run hunt:check
```

The readiness check makes one loopback health request and no provider request. `hunt:check` runs the complete controller and real fixture browsers with simulated provider responses and an authored test sequence. It verifies a candidate-only result, the both-correct control, and cancellation. It is not an autonomous-discovery benchmark. Add `-- --headed` to watch it.

For live exploration, configure `OPENAI_API_KEY` in the ignored project `.env` file. Start a worker in one terminal, then submit from another with an explicit dollar budget:

```sh
./hound worker
# another terminal
./hound hunt --case positive --max-cost-usd 1
./hound hunt --case negative --max-cost-usd 1
```

Each command has a separate estimated spend allowance; the example allocates $2 across the two pilots. Costs depend on actual tokens. No automatic provider retries or model fallback occur. `hunt` streams until terminal by default; `--detach` prints the durable run ID and returns. `status`, `logs`, and `cancel` operate on that ID. Each worker attempt creates fresh loopback fixtures and private records under `.hound/runs/`; it does not borrow the interactive demo. `./hound hunt --local ...` retains the direct development runner. A nondetection is never called a security pass. See the agent setup and results guide before running a paid pilot.

## Minimize and export a finding

Use the run ID of a verified `candidate_only_violation` result. The command uses fresh owned loopback fixture pairs and Chromium; it does not load `.env` or call a model.

```sh
./hound minimize --run-id <positive-run-id>
npm run test:generated
HOUND_FIXTURE_MODE=stale-write npm run test:generated
```

The first test command should pass. The explicit seeded-candidate command should fail with `Expected: "denied"` and `Received: "violation"`. A successful minimization writes its private journal under `.hound/minimizations/` and exports [the generated regression](generated-tests/removed-member-write.spec.ts). Export requires a deletion-minimal result and three successful confirmation pairs by default. See the minimizer and exporter guide for the algorithm, evidence, and claim limits.

## CLI first, HTML second

The CLI is Hound's primary interface. It owns execution, terminal status, machine-readable output, result inspection, minimization, and report export:

```sh
./hound runs
./hound runs --json | jq '.[0]'
./hound runs --local
./hound status <run-id>
./hound logs <run-id> --follow
./hound cancel <run-id>
./hound show --run-id <run-id>
./hound report --run-id <run-id>
```

`show` is the default way to understand a durable result. `report` is an explicit secondary export for reviewing or sharing one confirmed finding; it does not start a server or become a separate source of truth. Reports are static, contain no scripts or external assets, and derive from a versioned allowlisted projection that excludes raw observations, provider text, credentials, HTTP bodies, addresses, and private paths. Historical local results use `show --local` or `report --local`. See the CLI and report guide, report design, and durable result contract.

## Tests and evidence

```sh
npm run typecheck
npm test
npm run test:browser
npm run test:runtime
npm run test:control
npm run test:browser -- --repeat-each=3
```

`test:control` requires `./hound control up`; it exercises durable creation, concurrent leasing, heartbeat, idempotent and conflicting result/artifact uploads, completion gating, crash-boundary cleanup, cancellation, stale-worker fencing, retry exhaustion, and SSE replay without a browser or provider call.

The state and HTTP tests cover the seeded behavior, session/workspace isolation, member administration boundaries, invitation reuse, conflicting edits, harness authentication, competing execution acquisition, and a request that spans a reset.

Browser tests exercise the real UI as Alice and Bob, check the server's membership state and persisted body/revision, verify fresh-session denial, and check the small-screen layout. They use fresh instances and contexts on each run and do not disturb the interactive demo. The candidate test **passes when the expected seeded bug is observed**; this suite validates the benchmark target.

`npm run test:runtime` exercises the same fixture through Hound's decision executor, records an authored trajectory, and replays it with new sessions and resource IDs. It checks candidate-only, both-correct, and both-buggy outcomes, plus invalid decisions, lost sessions, closed browsers, deadlines, cleanup, and local traffic restrictions. This demonstrates execution and verification without a model API key. It does **not** demonstrate autonomous discovery. `npm run test:generated` runs the exported regression against the correct fixture. See the runtime guide for its interface and limitations.

After browser tests, `test-results/` contains post-login screenshots and selected JSON evidence; `playwright-report/` contains the HTML report. View it with:

```sh
npx playwright show-report --host 127.0.0.1
```

Raw traces and authentication headers are not captured. Harness credentials, execution tokens, browser downloads, and reports are excluded from Git. Evidence capture here is deliberately limited; the full artifact/redaction subsystem is a later design step.

## How the final tool will use this fixture

In-memory storage is a property of the **target application**, not a restriction on Hound's future persistence. A runner controls the fixture through versioned HTTP interfaces and can persist evidence independently.

The runner acquires an exclusive execution through the protected harness, creates Alice/Bob browser contexts, explores through normal UI/API routes, inspects authoritative state for its oracle, and ends the execution. Every paired replay starts from fresh state, resolving generated resource IDs independently in each deployment. No store internals need to be imported by the runner.

See the fixture integration guide for API shapes, configuration, credentials, reset semantics, and limitations. The manual demo writes its active execution handles and harness credentials to the ignored, owner-readable `.hound/demo.json`; keep that file out of model input and published artifacts.

## Repository layout

```text
apps/fixture/
  src/             In-memory state, actor server, protected harness, harness client
  public/          Fieldnotes browser UI
  scripts/         Two-process local demo launcher
  tests/           State, HTTP, and Playwright acceptance checks
services/runtime/
  src/             Browser execution, control client, oracle/replay, minimizer/exporter, provider policy, journal
  scripts/         Primary CLI control client, local worker, direct runner, minimizer, report export
  tests/           Pure checks and local browser integration tests
services/control-plane/
  main.go          Durable run, lease, event, result, artifact, cancellation, and completion API
  migrations/      PostgreSQL lifecycle and result metadata schema
deploy/local/      Exact-digest loopback Docker Compose stack
generated-tests/   Model-free Playwright regressions emitted from confirmed plans
  project-brief.md  Product direction and phased build brief
  fixture.md       How to run, reset, and integrate the benchmark target
  runtime.md       Deterministic runtime interface, completion, and failure semantics
  agent.md         Model setup, pilot budgets, private run records, and outcomes
  cli.md           Primary CLI and secondary static report contract
  minimization.md  Paired reduction, export workflow, evidence, and limits
  design-decisions/
```

The browser contract, provider integration, simple causal baseline, and paired minimizer/exporter are implemented following an adversarial review. Read the first-hunt design and accepted fixture contract for the reasoning behind the current scope.
