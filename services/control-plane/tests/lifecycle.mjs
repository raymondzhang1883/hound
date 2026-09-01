import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const envPath = process.env.HOUND_CONTROL_ENV ?? ".hound/control-plane.env";
const values = Object.fromEntries(
  (await readFile(envPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }),
);
const baseURL = process.env.HOUND_CONTROL_URL ?? `http://127.0.0.1:${values.HOUND_CONTROL_PORT ?? "8090"}`;
const workerKey = values.HOUND_WORKER_KEY;
assert.match(baseURL, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
assert.ok(workerKey?.length >= 32, "missing worker key in the local control environment");

async function request(path, { expected = 200, headers, ...options } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...headers },
  });
  const text = await response.text();
  let body;
  if (text) body = JSON.parse(text);
  assert.equal(response.status, expected, `${options.method ?? "GET"} ${path}: ${response.status} ${text}`);
  return body;
}

async function createRun(caseName = "positive") {
  return request("/v1/runs", {
    method: "POST",
    expected: 201,
    body: JSON.stringify({ case: caseName, maxCostUsd: 0.1, maxTrials: 1 }),
  });
}

async function lease(workerId, expected = 200) {
  return request("/v1/jobs/lease", {
    method: "POST",
    expected,
    headers: { "X-Hound-Worker-Key": workerKey },
    body: JSON.stringify({ workerId }),
  });
}

async function leaseMaybe(workerId) {
  const response = await fetch(`${baseURL}/v1/jobs/lease`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Hound-Worker-Key": workerKey },
    body: JSON.stringify({ workerId }),
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  assert.equal(response.status, 200, `POST /v1/jobs/lease: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function leaseForRun(runId, workerId) {
  for (let index = 0; index < 50; index += 1) {
    const item = await lease(`${workerId}-${index}`);
    if (item.runId === runId) return item;
    await start(item);
    await complete(item, { state: "failed", outcome: "", reason: "integration_cleanup" });
  }
  assert.fail(`could not lease integration run ${runId}`);
}

function leaseHeaders(item) {
  return {
    Authorization: `Bearer ${item.leaseToken}`,
    "X-Hound-Lease-Epoch": String(item.leaseEpoch),
  };
}

async function waitForLeaseExpiry(item) {
  const remaining = Date.parse(item.leaseExpiresAt) - Date.now();
  if (remaining > -100) await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 250));
}

async function start(item, expected = 200) {
  return request(`/v1/jobs/${item.jobId}/start`, {
    method: "POST",
    expected,
    headers: leaseHeaders(item),
  });
}

async function complete(item, body, expected = 200) {
  return request(`/v1/jobs/${item.jobId}/complete`, {
    method: "POST",
    expected,
    headers: leaseHeaders(item),
    body: JSON.stringify(body),
  });
}

async function emit(item, body, expected = 200) {
  return request(`/v1/jobs/${item.jobId}/events`, {
    method: "POST",
    expected,
    headers: leaseHeaders(item),
    body: JSON.stringify(body),
  });
}

function projection(item, outcome = "no_suspicion") {
  const now = new Date().toISOString();
  const confirmed = outcome === "candidate_only_violation";
  return {
    version: 1,
    kind: "hound-finding-report",
    generatedAt: now,
    runId: item.runId,
    invariant: {
      id: "removed-member-write@1",
      text: "Once a member is removed from a workspace, that member must no longer be able to modify its documents.",
    },
    source: { revision: "unknown", createdAt: now, case: item.case },
    finding: {
      outcome,
      confirmed,
      title: confirmed ? "Removed member retained document write access" : "No candidate-only suspicion observed",
      summary: confirmed ? "Fresh paired replay denied the write on the baseline and reproduced it on the candidate." : "This result is not a security pass. Review the terminal outcome and private journal before drawing a conclusion.",
      ...(confirmed ? { actor: "bob", resource: "document_1" } : {}),
    },
    ...(confirmed ? { comparison: { baseline: { result: "denied", setupEquivalent: true }, candidate: { result: "violation", setupEquivalent: true } } } : {}),
    exploration: {
      startedAt: now,
      finishedAt: now,
      elapsedMs: 0,
      trials: [],
      ...(confirmed ? { planId: "a".repeat(64) } : {}),
      originalActions: confirmed ? [{ index: 0, actor: "bob", kind: "click", description: "submits the document write", probe: true }] : [],
      policy: { provider: "integration", model: "none", reasoning: "none", promptVersion: "integration", simulated: true },
      accounting: { calls: 0, unknownUsageCalls: 0, estimatedCostUsd: 0 },
    },
  };
}

async function putJSON(item, path, value, expected = 200) {
  const body = JSON.stringify(value);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return request(path, { method: "PUT", expected, headers: { ...leaseHeaders(item), "X-Hound-Content-SHA256": sha256 }, body });
}

async function uploadResult(item, value = projection(item), expected = 200) {
  return putJSON(item, `/v1/jobs/${item.jobId}/result`, value, expected);
}

const firstRun = await createRun();
const firstLease = await leaseForRun(firstRun.id, "integration-primary");
assert.equal(firstLease.runId, firstRun.id);
assert.equal(firstLease.attempt, 1);
await start(firstLease);

const occurredAt = new Date().toISOString();
const eventBody = { workerEventId: "trial-1", type: "trial_started", summary: "Started owned positive fixture trial", occurredAt };
const inserted = await emit(firstLease, eventBody);
const repeated = await emit(firstLease, eventBody);
assert.equal(repeated.sequence, inserted.sequence, "identical event retry must be idempotent");
await emit(firstLease, { ...eventBody, summary: "Changed content" }, 409);
const eventList = await request(`/v1/runs/${firstRun.id}/events`);
assert.deepEqual(eventList.events.map((item) => item.sequence), [inserted.sequence]);
await request(`/v1/jobs/${firstLease.jobId}/heartbeat`, {
  method: "POST",
  headers: leaseHeaders(firstLease),
});
await complete(firstLease, { state: "completed", outcome: "cancelled", reason: "" }, 422);
const success = { state: "completed", outcome: "candidate_only_violation", reason: "" };
await complete(firstLease, success, 409);
const plan = { version: 1, id: "a".repeat(64), probeActor: "bob", probeResource: "document_1", steps: [{}] };
await putJSON(firstLease, `/v1/jobs/${firstLease.jobId}/artifacts/replay_plan`, plan);
await putJSON(firstLease, `/v1/jobs/${firstLease.jobId}/artifacts/replay_plan`, plan);
await putJSON(firstLease, `/v1/jobs/${firstLease.jobId}/artifacts/replay_plan`, { ...plan, id: "b".repeat(64) }, 409);
await request(`/v1/runs/${firstRun.id}/artifacts/replay_plan`, { expected: 404 });
const durableProjection = projection(firstLease, "candidate_only_violation");
await uploadResult(firstLease, durableProjection);
await uploadResult(firstLease, durableProjection);
await uploadResult(firstLease, { ...durableProjection, generatedAt: new Date(Date.now() + 1_000).toISOString() }, 409);
await complete(firstLease, success);
await complete(firstLease, success);
await complete(firstLease, { ...success, outcome: "no_suspicion" }, 409);
await uploadResult(firstLease, durableProjection, 409);
await request(`/v1/jobs/${firstLease.jobId}/heartbeat`, {
  method: "POST",
  expected: 409,
  headers: leaseHeaders(firstLease),
});
const finished = await request(`/v1/runs/${firstRun.id}`);
assert.equal(finished.status, "completed");
assert.equal(finished.outcome, "candidate_only_violation");
assert.equal((await request(`/v1/runs/${firstRun.id}/result`)).runId, firstRun.id);
assert.equal((await request(`/v1/runs/${firstRun.id}/artifacts/replay_plan`)).id, plan.id);

const cancelledRun = await createRun("negative");
const cancelledLease = await leaseForRun(cancelledRun.id, "integration-cancel");
assert.equal(cancelledLease.runId, cancelledRun.id);
await start(cancelledLease);
await request(`/v1/runs/${cancelledRun.id}/cancel`, { method: "POST" });
await request(`/v1/runs/${cancelledRun.id}/cancel`, { method: "POST" });
await emit(cancelledLease, { ...eventBody, workerEventId: "after-cancel" }, 409);
const cancelled = await request(`/v1/runs/${cancelledRun.id}`);
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.outcome, "cancelled");

const parallelRuns = await Promise.all([createRun(), createRun("negative")]);
const parallelLeases = await Promise.all([lease("integration-parallel-a"), lease("integration-parallel-b")]);
assert.equal(new Set(parallelLeases.map((item) => item.runId)).size, 2, "parallel claims must lease distinct jobs");
assert.deepEqual(new Set(parallelLeases.map((item) => item.runId)), new Set(parallelRuns.map((item) => item.id)));
await Promise.all(parallelLeases.map((item) => start(item)));
await Promise.all(parallelLeases.map((item) => complete(item, { state: "failed", outcome: "", reason: "integration_cleanup" })));

const retryRun = await createRun();
const staleLease = await leaseForRun(retryRun.id, "integration-expiry-a");
assert.equal(staleLease.runId, retryRun.id);
await start(staleLease);
const stalePlan = { ...plan, id: "c".repeat(64) };
await putJSON(staleLease, `/v1/jobs/${staleLease.jobId}/artifacts/replay_plan`, stalePlan);
const staleProjection = projection(staleLease, "candidate_only_violation");
staleProjection.exploration.planId = stalePlan.id;
await uploadResult(staleLease, staleProjection);
await request(`/v1/runs/${retryRun.id}/result`, { expected: 404 });
await waitForLeaseExpiry(staleLease);
const retryLease = await lease("integration-expiry-b");
assert.equal(retryLease.runId, retryRun.id);
assert.equal(retryLease.attempt, 2);
assert.ok(retryLease.leaseEpoch > staleLease.leaseEpoch);
await request(`/v1/runs/${retryRun.id}/result`, { expected: 404 });
await request(`/v1/runs/${retryRun.id}/artifacts/replay_plan`, { expected: 404 });
await start(staleLease, 409);
await start(retryLease);
await waitForLeaseExpiry(retryLease);
let exhausted;
for (let index = 0; index < 20; index += 1) {
  const unrelated = await leaseMaybe(`integration-reaper-${index}`);
  if (unrelated) {
    await start(unrelated);
    await complete(unrelated, { state: "failed", outcome: "", reason: "integration_cleanup" });
  }
  exhausted = await request(`/v1/runs/${retryRun.id}`);
  if (exhausted.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 150));
}
assert.equal(exhausted.status, "failed");
assert.equal(exhausted.reason, "attempts_exhausted");

const streamRun = await createRun();
const streamLease = await leaseForRun(streamRun.id, "integration-stream");
await start(streamLease);
const streamEvent = await emit(streamLease, { ...eventBody, workerEventId: "stream-1", type: "run_progress", summary: "Streaming lifecycle event" });
await uploadResult(streamLease);
await complete(streamLease, { state: "completed", outcome: "no_suspicion", reason: "" });
const streamResponse = await fetch(`${baseURL}/v1/runs/${streamRun.id}/events?follow=true`, { headers: { Accept: "text/event-stream" } });
assert.equal(streamResponse.status, 200);
const streamText = await streamResponse.text();
assert.match(streamText, new RegExp(`id: ${streamEvent.sequence}\\nevent: run_progress\\n`));
assert.match(streamText, /data: \{"sequence":/);
const recentRuns = await request('/v1/runs?limit=10');
assert.ok(recentRuns.runs.some((item) => item.id === streamRun.id));
await request('/v1/runs?limit=0', { expected: 400 });

console.log(JSON.stringify({
  status: "passed",
  completedRun: firstRun.id,
  cancelledRun: cancelledRun.id,
  exhaustedRun: retryRun.id,
  parallelClaims: parallelLeases.length,
  streamedEvents: 1,
}));
