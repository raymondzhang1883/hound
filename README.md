# Hound

Hunt stateful authorization regressions before they ship.

Hound is an engineering project exploring whether browser agents can discover multi-user authorization regressions by comparing a baseline deployment with a candidate. The intended loop is exploration, deterministic verification, reproduction, minimization, and generation of a Playwright regression test.

**Current milestone:** a working local benchmark fixture, its browser UI, a protected reset/inspection harness, and deterministic authorization tests. Autonomous exploration, the Go control plane, distributed workers, minimization, and the Hound dashboard are not implemented yet.

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

Requires Node.js 22 or later and npm. The commands below target macOS/Linux shells. No database, Docker, cloud account, or model API key is needed for this milestone.

```sh
npm ci
npm run setup:browser
npm run check
npm run demo
```

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

## Tests and evidence

```sh
npm run typecheck
npm test
npm run test:browser
npm run test:browser -- --repeat-each=3
```

The state and HTTP tests cover the seeded behavior, session/workspace isolation, member administration boundaries, invitation reuse, conflicting edits, harness authentication, competing execution acquisition, and a request that spans a reset.

Browser tests exercise the real UI as Alice and Bob, check the server's membership state and persisted body/revision, verify fresh-session denial, and check the small-screen layout. They use fresh instances and contexts on each run and do not disturb the interactive demo. The candidate test **passes when the expected seeded bug is observed**; this suite validates the benchmark target.

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
  project-brief.md  Product direction and phased build brief
  fixture.md       How to run, reset, and integrate the benchmark target
  design-decisions/
```

The next design checkpoint is the browser action/observation contract and the first exploration baseline. Major subsystems are designed together before implementation. Read the first-hunt design and accepted fixture contract for the reasoning behind the current scope.
