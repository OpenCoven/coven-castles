/**
 * Castles #3: the run seam. Every value here is SYNTHETIC: invented IDs,
 * invented answers, no provider evidence. A pass proves only that the
 * Castles client side behaves as described against fixtures shaped like the
 * pinned upstream run contract (coven-agents 0696af12). It never shows that
 * a run was admitted, executed or read-only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISPATCH_EXPECTATION,
  RUN_CONTRACT,
  RUN_GATES,
  RUNTIME_MANIFEST,
  RUNTIME_MANIFEST_SHA256,
  checkDispatchParity,
  isLiveRun,
  parseRunAnswer,
  planRun,
  runTask,
  verifyRuntime,
  type OwnerRunClient,
  type RunPlan,
} from "../src/run.ts";
import {
  runPreflight,
  type SandboxInspectionClient,
} from "../src/preflight.ts";
import { parseBinding, type Binding } from "../src/profile.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Synthetic canonical UUIDs (version 4, variant 8): invented, not real IDs.
const AGENT = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const OPERATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const RUN_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const SANDBOX = "fixture-sandbox-0001";
const GENERATION = 3;
const TASK = "Diagnose the fixture repository and return one report.";
const CANARY = "CANARY-run-7d1e-do-not-print";

const ENV = Object.freeze({
  CASTLES_OWNER_AGENT_ID: AGENT,
  CASTLES_PROFILE: "castles.daytona-private-linux.v1",
  CASTLES_SANDBOX_GENERATION: String(GENERATION),
  CASTLES_SANDBOX_ID: SANDBOX,
});

function binding(): Binding {
  const parsed = parseBinding(ENV);
  assert.ok(parsed.ok);
  return parsed.binding;
}

/** The accepted #2 ready fixture, re-keyed to the synthetic UUID agent. */
function readyInspection(edit: (sandbox: any) => void = () => undefined): any {
  const fixture = JSON.parse(
    readFileSync(join(root, "fixtures/preflight/cases/ready.json"), "utf8")
  );
  const inspection = fixture.inspection;
  inspection.binding.agentId = AGENT;
  edit(inspection.sandbox);
  return inspection;
}

function inspectionClient(inspection: unknown) {
  const calls: string[] = [];
  const client: SandboxInspectionClient = {
    inspectBoundSandbox: () => {
      calls.push("inspectBoundSandbox");
      return Promise.resolve(inspection);
    },
  };
  return { calls, client };
}

/** A run client whose every method is a tripwire that records the call. */
function runClient(answer: () => unknown = () => ({ body: null, status: 503 })) {
  const calls: string[] = [];
  const client: Record<string, unknown> = {
    startRun: (request: unknown) => {
      calls.push("startRun");
      return Promise.resolve().then(answer);
    },
  };
  for (const name of ["stopRun", "readRun", "createRun", "bindSandbox", "issueCredential"]) {
    client[name] = () => {
      calls.push(name);
      throw new Error(`fixture tripwire: ${name} must never be called`);
    };
  }
  return { calls, client: client as unknown as OwnerRunClient };
}

function plan(): RunPlan {
  const planned = planRun(binding(), { operationId: OPERATION, task: TASK });
  assert.equal(planned.ok, true);
  return (planned as { ok: true; plan: RunPlan }).plan;
}

function snapshot(edit: (run: any) => void = () => undefined): any {
  const run: any = {
    agentId: AGENT,
    apiVersion: "1.0",
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    error: null,
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION,
    output: "",
    startedAt: null,
    status: "queued",
    task: TASK,
  };
  edit(run);
  return run;
}

function accepted(edit: (run: any) => void = () => undefined) {
  return { body: { apiVersion: "1.0", run: snapshot(edit) }, status: 202 };
}

function refusal(status: number, code: string, details?: string) {
  return {
    body: {
      apiVersion: "1.0",
      error: {
        code,
        ...(details === undefined ? {} : { details }),
        message: "Synthetic fixture refusal.",
        retryable: false,
      },
      requestId: "fixture-request-0001",
    },
    status,
  };
}

function codes(result: { reasons: readonly { code: string }[] }) {
  return result.reasons.map((reason) => reason.code);
}

// --- Runtime manifest (snapshot verification only, coven-agents#300) -------

test("run: the runtime manifest file is the pinned manifest, byte for byte", () => {
  const bytes = readFileSync(join(root, "runtime/manifest.json"), "utf8");
  assert.deepEqual(JSON.parse(bytes), RUNTIME_MANIFEST);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    RUNTIME_MANIFEST_SHA256
  );
  assert.equal(RUNTIME_MANIFEST.bootstrap, "snapshot-verification-only");
  assert.equal(
    RUNTIME_MANIFEST.upstream.revision,
    "0696af127207fb82cce734cd8c4ffa437d6f3502"
  );
  assert.equal(RUNTIME_MANIFEST.snapshotName, "coven-agents-copilot-2");
  assert.deepEqual(RUNTIME_MANIFEST.harness, {
    id: "copilot",
    package: "@github/copilot",
    version: "1.0.80",
  });
  assert.equal(RUNTIME_MANIFEST.adapterVersion, "daytona-adapter-v1");
  assert.equal(RUNTIME_MANIFEST.capabilityContractVersion, "hosted-v1");
  assert.equal(RUNTIME_MANIFEST.credentialBoundaryVersion, "attempt-reset-v1");
  assert.equal(RUNTIME_MANIFEST.sdkVersion, "0.231.1");
  assert.match(RUNTIME_MANIFEST.contracts.inspection.sha256, /^[0-9a-f]{64}$/u);
  assert.match(RUNTIME_MANIFEST.contracts.run.sha256, /^[0-9a-f]{64}$/u);
  // Second read rv19-c5e229e6, finding 9: the binding schema and the error
  // table live outside the main contract file, so each has its own hash.
  assert.deepEqual(
    Object.keys(RUNTIME_MANIFEST.contracts).sort(),
    ["inspection", "run", "runBinding", "runErrors"]
  );
  assert.equal(RUNTIME_MANIFEST.contracts.runBinding.path, "packages/agent-contracts/src/sandbox-binding.ts");
  assert.equal(RUNTIME_MANIFEST.contracts.runErrors.path, "lib/runner/transport.ts");
  for (const contract of Object.values(RUNTIME_MANIFEST.contracts)) {
    assert.match(contract.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(RUNTIME_MANIFEST.measuredInGuest, false);
});

function report(edit: (value: any) => void = () => undefined): any {
  const value: any = {
    observedSnapshot: "coven-agents-copilot-2",
    policy: {
      adapterVersion: "daytona-adapter-v1",
      capabilityContractVersion: "hosted-v1",
      credentialBoundaryVersion: "attempt-reset-v1",
      harnesses: [{ id: "copilot", package: "@github/copilot", version: "1.0.80" }],
      resources: { cpu: 2, diskGib: 10, memoryGib: 4 },
      sdkVersion: "0.231.1",
      snapshotName: "coven-agents-copilot-2",
      target: "us",
    },
    version: 1,
  };
  edit(value);
  return value;
}

test("run BST-02: verification is repeatable, pure and reports a comparison, not a measurement", () => {
  const input = report();
  const before = JSON.stringify(input);
  const first = verifyRuntime(input);
  const second = verifyRuntime(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.status, "compatible");
  assert.deepEqual(first.mismatches, []);
  assert.equal(first.measuredInGuest, false);
  assert.equal(first.manifestSha256, RUNTIME_MANIFEST_SHA256);
  // A deeply frozen report is read, never written.
  const frozen = report();
  Object.freeze(frozen.policy.harnesses[0]);
  Object.freeze(frozen.policy.harnesses);
  Object.freeze(frozen.policy.resources);
  Object.freeze(frozen.policy);
  Object.freeze(frozen);
  assert.equal(verifyRuntime(frozen).status, "compatible");
});

test("run BST-01/BST-04: a snapshot, harness or contract-version mismatch is incompatible and names the field", () => {
  const cases: [string, (value: any) => void][] = [
    ["observedSnapshot", (v) => (v.observedSnapshot = "coven-agents-copilot-3")],
    ["policy.snapshotName", (v) => (v.policy.snapshotName = "coven-agents-copilot-1")],
    ["policy.harnesses", (v) => (v.policy.harnesses[0].version = "1.0.81")],
    ["policy.harnesses", (v) => (v.policy.harnesses[0].package = "@github/copilot-fork")],
    ["policy.harnesses", (v) => (v.policy.harnesses = [])],
    ["policy.harnesses", (v) => v.policy.harnesses.push({ id: "copilot", package: "@github/copilot", version: "1.0.80" })],
    ["policy.adapterVersion", (v) => (v.policy.adapterVersion = "daytona-adapter-v2")],
    ["policy.capabilityContractVersion", (v) => (v.policy.capabilityContractVersion = "hosted-v2")],
    ["policy.credentialBoundaryVersion", (v) => (v.policy.credentialBoundaryVersion = "attempt-reset-v0")],
    ["policy.sdkVersion", (v) => (v.policy.sdkVersion = "0.220.0")],
  ];
  for (const [field, edit] of cases) {
    const result = verifyRuntime(report(edit));
    assert.equal(result.status, "incompatible", field);
    assert.deepEqual(result.mismatches, [{ field }], field);
  }
  // Every mismatch is reported, in a stable order.
  const several = verifyRuntime(
    report((v) => {
      v.policy.sdkVersion = "0.220.0";
      v.observedSnapshot = "coven-agents-copilot-3";
    })
  );
  assert.deepEqual(several.mismatches, [
    { field: "observedSnapshot" },
    { field: "policy.sdkVersion" },
  ]);
  // A different harness alongside the pinned one is not the pinned runtime.
  const extra = verifyRuntime(
    report((v) => v.policy.harnesses.push({ id: "other", package: "fixture-other", version: "1.0.0" }))
  );
  assert.equal(extra.status, "incompatible");
});

test("run BST-03: an unreadable or partial verification result is never compatible", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["a string", "compatible"],
    ["an array", [report()]],
    ["no version", report((v) => delete v.version)],
    ["version 2", report((v) => (v.version = 2))],
    ["no policy", report((v) => delete v.policy)],
    ["no observed snapshot", report((v) => delete v.observedSnapshot)],
    ["null observed snapshot", report((v) => (v.observedSnapshot = null))],
    ["an extra key", report((v) => (v.status = "compatible"))],
    ["a policy extra key", report((v) => (v.policy.fixtureExtra = 1))],
    ["a policy key missing", report((v) => delete v.policy.sdkVersion)],
    ["an empty pin", report((v) => (v.policy.adapterVersion = ""))],
    ["a number pin", report((v) => (v.policy.sdkVersion = 231))],
    ["harnesses not an array", report((v) => (v.policy.harnesses = {}))],
    ["a harness extra key", report((v) => (v.policy.harnesses[0].fixtureExtra = 1))],
    ["resources missing cpu", report((v) => delete v.policy.resources.cpu)],
    ["a getter", report((v) => Object.defineProperty(v.policy, "sdkVersion", { enumerable: true, get: () => "0.231.1" }))],
  ];
  for (const [label, value] of cases) {
    const result = verifyRuntime(value);
    assert.equal(result.status, "unreadable", label);
    assert.deepEqual(result.mismatches, [], label);
  }
});

// --- Planning: the request is built from the binding, never from the caller -

test("run: the planned request is exactly the pinned body, bound to the configured sandbox", () => {
  const planned = plan();
  assert.deepEqual(planned.request, {
    agentId: AGENT,
    body: {
      operationId: OPERATION,
      sandboxBinding: { expectedGeneration: GENERATION, expectedSandboxId: SANDBOX },
      task: TASK,
    },
  });
  assert.match(planned.requestDigest, /^[0-9a-f]{64}$/u);
  assert.equal(RUN_CONTRACT.route, "POST /api/agents/{agentId}/runs");
  assert.equal(RUN_CONTRACT.maxTaskLength, 40_000);
});

test("run OUT-12/ADM-09: the same operation and payload plan identically; any change to the task is a different digest", () => {
  const base = plan();
  assert.deepEqual(plan(), base);
  const changedTask = planRun(binding(), { operationId: OPERATION, task: `${TASK}!` });
  const changedByte = planRun(binding(), { operationId: OPERATION, task: TASK.replace("one", "One") });
  for (const changed of [changedTask, changedByte]) {
    assert.equal(changed.ok, true);
    const other = (changed as { ok: true; plan: RunPlan }).plan;
    assert.equal(other.request.body.operationId, OPERATION);
    assert.notEqual(other.requestDigest, base.requestDigest);
  }
});

test("run ADM-06: a caller cannot supply authority, a familiar, a sandbox or a permission", () => {
  const offered: [string, Record<string, unknown>][] = [
    ["familiar", { familiarId: "builder" }],
    ["familiar revision", { familiarRevision: "fixture-revision" }],
    ["sandbox", { sandboxId: "fixture-sandbox-9999" }],
    ["binding", { sandboxBinding: { expectedGeneration: 0, expectedSandboxId: "x" } }],
    ["permission", { executionPermission: "unrestricted" }],
    ["account", { accountLogin: "fixture-login" }],
    ["subscription", { subscription: "active" }],
    ["credential", { authorization: CANARY }],
  ];
  for (const [label, extra] of offered) {
    const planned = planRun(binding(), { operationId: OPERATION, task: TASK, ...extra });
    assert.equal(planned.ok, false, label);
    assert.deepEqual(
      (planned as { ok: false; reason: { code: string } }).reason,
      { code: "request_field_unsupported", field: Object.keys(extra)[0] },
      label
    );
  }
});

test("run: an operation ID, task or agent ID outside the pinned contract refuses before any call", () => {
  const operations = ["", "not-a-uuid", OPERATION.toUpperCase(), "1a2b3c4d-5e6f-6a7b-8c9d-0e1f2a3b4c5d", 7, null, undefined];
  for (const operationId of operations) {
    const planned = planRun(binding(), { operationId, task: TASK });
    assert.deepEqual(planned, { ok: false, reason: { code: "operation_id_invalid" } }, String(operationId));
  }
  const tasks = ["", " ", ` ${TASK}`, `${TASK}\n`, "x".repeat(40_001), 5, null];
  for (const task of tasks) {
    const planned = planRun(binding(), { operationId: OPERATION, task });
    assert.deepEqual(planned, { ok: false, reason: { code: "task_invalid" } }, JSON.stringify(task).slice(0, 40));
  }
  assert.equal(planRun(binding(), { operationId: OPERATION, task: "x".repeat(40_000) }).ok, true);
  for (const request of [null, undefined, "task", [OPERATION, TASK]]) {
    assert.deepEqual(planRun(binding(), request), { ok: false, reason: { code: "request_invalid" } });
  }
  const legacy = parseBinding({ ...ENV, CASTLES_OWNER_AGENT_ID: "fixture-agent-0001" });
  assert.ok(legacy.ok);
  assert.deepEqual(planRun(legacy.binding, { operationId: OPERATION, task: TASK }), {
    ok: false,
    reason: { code: "agent_id_not_canonical" },
  });
});

// --- Dispatch parity (PR #18 finding 6; maintainer decision on #2) -----------

async function readyPreflight(edit: (sandbox: any) => void = () => undefined) {
  return runPreflight(ENV, inspectionClient(readyInspection(edit)).client);
}

test("run: the dispatch expectation is the owner's exact configuration at the pin", () => {
  assert.deepEqual(DISPATCH_EXPECTATION, {
    autoArchiveInterval: 10_080,
    autoStopInterval: 15,
    cpu: 2,
    diskGiB: 10,
    memoryGiB: 4,
    networkBlockAll: false,
    state: "started",
    target: "us",
  });
});

test("run: a Castles ready the owner would refuse at dispatch fails dispatch parity", async () => {
  const cases: [string, (sandbox: any) => void, string][] = [
    ["block-all true", (s) => { s.networkBlockAll = true; s.domainAllowList = null; }, "exposure.networkBlockAll"],
    ["auto-stop 30, inside Castles' range", (s) => (s.autoStopInterval = 30), "lifecycle.autoStopInterval"],
    ["auto-archive 60, inside Castles' range", (s) => (s.autoArchiveInterval = 60), "lifecycle.autoArchiveInterval"],
    ["auto-archive 43,200, inside Castles' range", (s) => (s.autoArchiveInterval = 43_200), "lifecycle.autoArchiveInterval"],
  ];
  for (const [label, edit, field] of cases) {
    const preflight = await readyPreflight(edit);
    assert.equal(preflight.status, "ready", label);
    assert.deepEqual(checkDispatchParity(preflight.observed), [{ code: "dispatch_parity_unmet", field }], label);
  }
  const control = await readyPreflight();
  assert.equal(control.status, "ready");
  assert.deepEqual(checkDispatchParity(control.observed), []);
});

test("run: every dispatch-parity field refuses on its own (second read rv19-c5e229e6, findings 1 and 3)", async () => {
  const control = (await readyPreflight()).observed;
  assert.ok(control);
  const changes: [string, (o: any) => void][] = [
    ["state", (o) => (o.state = "stopped")],
    ["target", (o) => (o.target = "eu")],
    ["exposure.networkBlockAll", (o) => (o.exposure.networkBlockAll = true)],
    ["lifecycle.autoStopInterval", (o) => (o.lifecycle.autoStopInterval = 14)],
    ["lifecycle.autoArchiveInterval", (o) => (o.lifecycle.autoArchiveInterval = 10_081)],
    ["resources.cpu", (o) => (o.resources.cpu = 3)],
    ["resources.diskGiB", (o) => (o.resources.diskGiB = 9)],
    ["resources.memoryGiB", (o) => (o.resources.memoryGiB = 5)],
  ];
  for (const [field, change] of changes) {
    const observed = structuredClone(control) as any;
    change(observed);
    assert.deepEqual(checkDispatchParity(observed), [{ code: "dispatch_parity_unmet", field }], field);
  }
  // `eu` is a target #2 accepts; the owner's default target is `us`.
  const eu = await readyPreflight((s) => (s.target = "eu"));
  assert.equal(eu.status, "ready");
  assert.deepEqual(checkDispatchParity(eu.observed), [{ code: "dispatch_parity_unmet", field: "target" }]);
  assert.equal(DISPATCH_EXPECTATION.target, "us");
});

test("run: dispatch parity fails closed on a missing or partial observation", () => {
  assert.deepEqual(checkDispatchParity(null), [{ code: "dispatch_parity_unmet", field: "observed" }]);
  const partial: any = {
    exposure: { networkBlockAll: null },
    lifecycle: { autoArchiveInterval: null, autoStopInterval: 15 },
    resources: { cpu: 2, diskGiB: null, memoryGiB: 4 },
    state: "started",
    target: "us",
  };
  assert.deepEqual(codes({ reasons: checkDispatchParity(partial) }), [
    "dispatch_parity_unmet",
    "dispatch_parity_unmet",
    "dispatch_parity_unmet",
  ]);
});

// --- runTask: the only path that can reach the run client --------------------

test("run ADM-04/ADM-11: the run gates name every capability missing at the pin", () => {
  assert.deepEqual(
    RUN_GATES.map((gate) => [gate.capability, gate.status]),
    [
      ["read_only_execution", "missing"],
      ["attempt_reference", "missing"],
      ["concurrent_run_denial", "missing"],
      ["familiar_revision", "missing"],
      // Second read rv19-c5e229e6, finding 5: BST-03 needs a compatible
      // runtime verification before a run, and the accepted #2 seam cannot
      // read the inspection v1 policy block it compares.
      ["runtime_verification", "missing"],
    ]
  );
  for (const gate of RUN_GATES) {
    assert.match(
      gate.issue,
      /^https:\/\/github\.com\/OpenCoven\/coven(?:-agents|-castles)?\/(?:issues|pull)\/\d+$/u
    );
  }
});

test("run: a ready, parity-meeting binding is blocked by the missing gates and never calls the run client", async () => {
  const inspection = inspectionClient(readyInspection());
  const runs = runClient();
  const result = await runTask(
    ENV,
    { inspection: inspection.client, runs: runs.client },
    { operationId: OPERATION, task: TASK }
  );
  assert.equal(result.schema, "castles.run.v1");
  assert.equal(result.status, "blocked");
  assert.deepEqual(
    result.reasons,
    RUN_GATES.map((gate) => ({ code: "upstream_gate_missing", field: gate.capability }))
  );
  assert.equal(result.preflight.status, "ready");
  assert.deepEqual(result.calls, { inspect: 1, startRun: 0 });
  assert.deepEqual(runs.calls, []);
  assert.equal(result.run, null);
  assert.match(result.requestDigest ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(result.evidence, "fixture");
  assert.equal(isLiveRun(result), false);
});

test("run BND-07/BND-08: a preflight that is not ready refuses the run with no run call", async () => {
  const cases: [string, unknown, string][] = [
    ["stopped", readyInspection((s) => (s.state = "stopped")), "stopped"],
    ["public", readyInspection((s) => (s.public = true)), "incompatible"],
    ["held fence", (() => { const i = readyInspection(); i.binding.attemptFence = "cleanup_required"; return i; })(), "reconciliation-required"],
  ];
  for (const [label, answer, status] of cases) {
    const inspection = inspectionClient(answer);
    const runs = runClient();
    const result = await runTask(
      ENV,
      { inspection: inspection.client, runs: runs.client },
      { operationId: OPERATION, task: TASK }
    );
    assert.equal(result.status, "refused", label);
    assert.deepEqual(result.reasons, [{ code: "preflight_not_ready" }], label);
    assert.equal(result.preflight.status, status, label);
    assert.deepEqual(result.calls, { inspect: 1, startRun: 0 }, label);
    assert.deepEqual(runs.calls, [], label);
  }
  const none = await runTask(ENV, { inspection: null, runs: runClient().client }, { operationId: OPERATION, task: TASK });
  assert.equal(none.status, "refused");
  assert.equal(none.preflight.status, "unavailable");
  assert.deepEqual(none.calls, { inspect: 0, startRun: 0 });
  assert.equal(none.evidence, "none");
});

test("run: a Castles ready failing dispatch parity is refused before the gates and the run client", async () => {
  const inspection = inspectionClient(readyInspection((s) => { s.networkBlockAll = true; s.domainAllowList = null; }));
  const runs = runClient();
  const result = await runTask(
    ENV,
    { inspection: inspection.client, runs: runs.client },
    { operationId: OPERATION, task: TASK }
  );
  assert.equal(result.preflight.status, "ready");
  assert.equal(result.status, "refused");
  assert.deepEqual(result.reasons, [{ code: "dispatch_parity_unmet", field: "exposure.networkBlockAll" }]);
  assert.deepEqual(runs.calls, []);
});

test("run: an invalid request or binding refuses before inspection", async () => {
  const inspection = inspectionClient(readyInspection());
  const runs = runClient();
  const bad = await runTask(ENV, { inspection: inspection.client, runs: runs.client }, { operationId: "x", task: TASK });
  assert.equal(bad.status, "refused");
  assert.deepEqual(bad.reasons, [{ code: "operation_id_invalid" }]);
  assert.deepEqual(bad.calls, { inspect: 0, startRun: 0 });
  assert.equal(bad.preflight.status, null);
  const unbound = await runTask({}, { inspection: inspection.client, runs: runs.client }, { operationId: OPERATION, task: TASK });
  assert.equal(unbound.status, "refused");
  assert.deepEqual(unbound.reasons, [{ code: "binding_invalid", field: "sandbox_id_missing" }]);
  assert.deepEqual(inspection.calls, []);
  assert.deepEqual(runs.calls, []);
});

test("run: the environment is read once, so preflight inspects exactly the planned binding (second read rv19-c5e229e6, finding 4)", async () => {
  const reads: Record<string, number> = {};
  const sandboxes = [SANDBOX, "fixture-sandbox-9999"];
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(ENV)) {
    Object.defineProperty(environment, key, {
      enumerable: true,
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        return key === "CASTLES_SANDBOX_ID" ? sandboxes[Math.min(reads[key] - 1, 1)] : value;
      },
    });
  }
  const requests: unknown[] = [];
  const inspection: SandboxInspectionClient = {
    inspectBoundSandbox: (request) => {
      requests.push(request);
      return Promise.resolve(readyInspection());
    },
  };
  const result = await runTask(environment, { inspection, runs: runClient().client }, { operationId: OPERATION, task: TASK });
  assert.equal(result.preflight.status, "ready");
  assert.deepEqual(requests, [{ agentId: AGENT, expectedGeneration: GENERATION, sandboxId: SANDBOX }]);
  for (const key of Object.keys(ENV)) {
    assert.equal(reads[key], 1, key);
  }
});

test("run RED-01: no credential, task text or configured ID reaches the result", async () => {
  const runs = runClient();
  const result = await runTask(
    { ...ENV, CASTLES_FIXTURE_TOKEN: CANARY } as any,
    { inspection: inspectionClient(readyInspection()).client, runs: runs.client },
    { operationId: OPERATION, task: `${TASK} ${CANARY}` }
  );
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /CANARY/u);
  assert.ok(!text.includes(SANDBOX));
  assert.ok(!text.includes(AGENT));
  assert.ok(!text.includes(TASK));
});

// --- parseRunAnswer: conformance to the pinned run contract ------------------

test("run: a conforming 202 is admitted with canonical run references and no attempt reference", () => {
  const outcome = parseRunAnswer(accepted(), plan());
  assert.deepEqual(outcome, {
    kind: "admitted",
    run: { attemptId: null, operationId: OPERATION, runId: RUN_ID, status: "queued" },
  });
  for (const status of ["running", "completed", "failed", "cancelled"]) {
    const later = parseRunAnswer(accepted((r) => (r.status = status)), plan());
    assert.equal(later.kind, "admitted", status);
  }
  const started = parseRunAnswer(
    accepted((r) => (r.executedSandbox = { bindingDigest: "a".repeat(64), generation: GENERATION })),
    plan()
  );
  assert.equal(started.kind, "admitted");
});

test("run ADM-05/ADM-08: a 202 about another agent, operation, task or generation is never adopted", () => {
  const cases: [string, (run: any) => void, string][] = [
    ["agent", (r) => (r.agentId = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"), "run.agentId"],
    ["operation", (r) => (r.operationId = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"), "run.operationId"],
    ["task", (r) => (r.task = "A different task."), "run.task"],
    ["generation", (r) => (r.executedSandbox = { bindingDigest: "b".repeat(64), generation: 4 }), "run.executedSandbox.generation"],
  ];
  for (const [label, edit, field] of cases) {
    assert.deepEqual(
      parseRunAnswer(accepted(edit), plan()),
      { code: "run_identity_mismatch", field, kind: "refused", status: "refused" },
      label
    );
  }
});

test("run: a 202 outside the pinned snapshot schema is a contract violation", () => {
  const violation = { code: "run_contract_violation", kind: "refused", status: "unavailable" };
  const cases: [string, unknown][] = [
    ["not an object", "accepted"],
    ["extra wrapper key", { ...accepted(), headers: {} }],
    ["no body", { status: 202 }],
    ["api version", { body: { apiVersion: "2.0", run: snapshot() }, status: 202 }],
    ["envelope extra key", { body: { apiVersion: "1.0", extra: 1, run: snapshot() }, status: 202 }],
    ["snapshot extra key (PR #320 shape before the pin moves)", accepted((r) => (r.executionPermission = "workspace_read"))],
    ["snapshot key missing", accepted((r) => delete r.createdAt)],
    ["status outside the enum", accepted((r) => (r.status = "admitted"))],
    ["run ID not canonical", accepted((r) => (r.id = RUN_ID.toUpperCase()))],
    ["output too long", accepted((r) => (r.output = "x".repeat(100_001)))],
    ["too much command evidence", accepted((r) => (r.commandEvidence = Array.from({ length: 257 }, () => ({}))))],
    ["evidence not an array", accepted((r) => (r.fileEvidence = {}))],
    ["binding digest not hex", accepted((r) => (r.executedSandbox = { bindingDigest: "z".repeat(64), generation: GENERATION }))],
    ["a getter", Object.defineProperty({ body: accepted().body }, "status", { enumerable: true, get: () => 202 })],
    ["status 200", { ...accepted(), status: 200 }],
  ];
  for (const [label, answer] of cases) {
    assert.deepEqual(parseRunAnswer(answer, plan()), violation, label);
  }
});

test("run: snapshot evidence and instants are checked to the pinned schema (second read rv19-c5e229e6, finding 7)", () => {
  const command = { command: "rg TODO", exitCode: 0, stderr: "", stdout: "" };
  const file = { operation: "modify", path: "src/tide.mjs" };
  const fine = parseRunAnswer(
    accepted((r) => {
      r.status = "completed";
      r.startedAt = "2026-11-20T00:00:01.000Z";
      r.completedAt = "2026-11-20T00:00:02Z";
      r.commandEvidence = [
        command,
        { ...command, completedAt: "2026-11-20T00:00:02Z", exitCode: null, startedAt: "2026-11-20T00:00:01Z" },
      ];
      r.fileEvidence = [file, { ...file, byteLength: 0, occurredAt: "2026-11-20T00:00:01Z", operation: "create" }];
    }),
    plan()
  );
  assert.equal(fine.kind, "admitted");
  const violation = { code: "run_contract_violation", kind: "refused", status: "unavailable" };
  const cases: [string, (run: any) => void][] = [
    ["command with an extra key", (r) => (r.commandEvidence = [{ ...command, shell: "sh" }])],
    ["command without stdout", (r) => { const c: any = { ...command }; delete c.stdout; r.commandEvidence = [c]; }],
    ["command empty", (r) => (r.commandEvidence = [{ ...command, command: "" }])],
    ["command too long", (r) => (r.commandEvidence = [{ ...command, command: "x".repeat(8_001) }])],
    ["exit code text", (r) => (r.commandEvidence = [{ ...command, exitCode: "0" }])],
    ["exit code fractional", (r) => (r.commandEvidence = [{ ...command, exitCode: 0.5 }])],
    ["stdout too long", (r) => (r.commandEvidence = [{ ...command, stdout: "x".repeat(100_001) }])],
    ["command completed before it started", (r) => (r.commandEvidence = [{ ...command, completedAt: "2026-11-20T00:00:01Z", startedAt: "2026-11-20T00:00:02Z" }])],
    ["file operation outside the enum", (r) => (r.fileEvidence = [{ ...file, operation: "rename" }])],
    ["file path too long", (r) => (r.fileEvidence = [{ ...file, path: "p".repeat(1_025) }])],
    ["file byte length negative", (r) => (r.fileEvidence = [{ ...file, byteLength: -1 }])],
    ["file with an extra key", (r) => (r.fileEvidence = [{ ...file, digest: "a" }])],
    ["an impossible date", (r) => (r.createdAt = "2026-02-30T00:00:00Z")],
    ["an impossible hour", (r) => (r.startedAt = "2026-11-20T24:00:00Z")],
    ["an offset instead of Z", (r) => (r.createdAt = "2026-11-20T00:00:00+00:00")],
  ];
  for (const [label, edit] of cases) {
    assert.deepEqual(parseRunAnswer(accepted(edit), plan()), violation, label);
  }
});

test("run ADM-04/ADM-09: each pinned refusal maps to one Castles code", () => {
  const table: [number, string, string, string][] = [
    [400, "invalid_request", "refused", "request_rejected"],
    [400, "unsupported_media_type", "refused", "request_rejected"],
    [400, "harness_unsupported", "refused", "capability_unsupported"],
    [401, "unauthorized", "refused", "unauthenticated"],
    [403, "subscription_required", "refused", "subscription_required"],
    [403, "origin_rejected", "refused", "unauthenticated"],
    [404, "not_found", "refused", "owner_mismatch"],
    [409, "operation_conflict", "refused", "operation_conflict"],
    [409, "busy", "unavailable", "busy"],
    [409, "agent_decommissioning", "refused", "lifecycle_conflict"],
    [413, "body_too_large", "refused", "request_rejected"],
    [429, "rate_limited", "unavailable", "rate_limited"],
    [500, "internal_error", "unavailable", "upstream_unavailable"],
    [503, "runner_unavailable", "unavailable", "upstream_unavailable"],
    [503, "admission_unavailable", "unavailable", "upstream_unavailable"],
    [503, "abuse_control_unavailable", "unavailable", "upstream_unavailable"],
  ];
  for (const [status, code, expected, mapped] of table) {
    assert.deepEqual(
      parseRunAnswer(refusal(status, code), plan()),
      { code: mapped, kind: "refused", status: expected },
      `${status} ${code}`
    );
  }
});

test("run ADM-05: each binding refusal reason is named; another reason is a violation", () => {
  for (const reason of ["no_recorded_sandbox", "sandbox_id_mismatch", "generation_mismatch", "lifecycle_not_ready", "fence_outstanding"]) {
    assert.deepEqual(
      parseRunAnswer(refusal(409, "sandbox_binding_refused", reason), plan()),
      { code: "binding_refused", field: reason, kind: "refused", status: "refused" },
      reason
    );
  }
  for (const details of [undefined, "returned_id_mismatch", CANARY]) {
    assert.deepEqual(
      parseRunAnswer(refusal(409, "sandbox_binding_refused", details), plan()),
      { code: "run_contract_violation", kind: "refused", status: "unavailable" },
      String(details)
    );
  }
});

test("run: a refusal outside the pinned error contract is a violation and its text is never echoed", () => {
  const violation = { code: "run_contract_violation", kind: "refused", status: "unavailable" };
  const cases: [string, unknown][] = [
    ["code on the wrong status", refusal(503, "operation_conflict")],
    ["unknown code", refusal(409, "fixture_unknown")],
    ["unlisted status", refusal(418, "invalid_request")],
    ["a code the start route never emits", refusal(409, "stale_version")],
    ["error extra key", (() => { const r: any = refusal(401, "unauthorized"); r.body.error.raw = CANARY; return r; })()],
    ["envelope missing requestId", (() => { const r: any = refusal(401, "unauthorized"); delete r.body.requestId; return r; })()],
    ["message empty", (() => { const r: any = refusal(401, "unauthorized"); r.body.error.message = ""; return r; })()],
    ["retryable not boolean", (() => { const r: any = refusal(401, "unauthorized"); r.body.error.retryable = "no"; return r; })()],
    ["body null", { body: null, status: 401 }],
    ["status text", { body: refusal(401, "unauthorized").body, status: "401" }],
  ];
  for (const [label, answer] of cases) {
    const outcome = parseRunAnswer(answer, plan());
    assert.deepEqual(outcome, violation, label);
    assert.doesNotMatch(JSON.stringify(outcome), /CANARY/u, label);
  }
});

test("run: the run seam is pinned to the traced upstream revision", () => {
  assert.equal(RUN_CONTRACT.revision, "0696af127207fb82cce734cd8c4ffa437d6f3502");
  assert.equal(RUN_CONTRACT.apiVersion, "1.0");
  assert.equal(RUNTIME_MANIFEST.contracts.run.apiVersion, RUN_CONTRACT.apiVersion);
});
