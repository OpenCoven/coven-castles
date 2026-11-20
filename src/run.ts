/**
 * Castles #3: the run seam for one owner run on the bound sandbox.
 *
 * Castles is not an authority. A run is admitted, executed and limited by
 * the existing lifecycle owner (OpenCoven/coven-agents) through its owner
 * run route, using the owner's own credential. This module only:
 *
 * - plans the exact request from the #2 binding (the caller supplies an
 *   operation ID and the task text, nothing else);
 * - refuses before any run call unless #2 preflight is `ready`, the
 *   observation meets the owner's exact dispatch configuration, and every
 *   upstream capability a canonically authorized run needs is present;
 * - reads an answer shaped like the pinned run contract, strictly;
 * - compares a server-owned verification report with the pinned runtime
 *   manifest (snapshot verification only, coven-agents#300).
 *
 * At this revision several of those upstream capabilities are missing (see
 * `RUN_GATES`), so `runTask` always stops before the run client, and no
 * live client exists. Nothing here is live evidence.
 */
import { createHash } from "node:crypto";

import {
  runPreflight,
  type ObservedSandbox,
  type PreflightEvidence,
  type PreflightStatus,
  type SandboxInspectionClient,
} from "./preflight.ts";
import { parseBinding, type Binding } from "./profile.ts";

// --- Pins ---------------------------------------------------------------------

/**
 * The owner run route at the traced upstream revision. Sources, all in
 * coven-agents at `revision`: the strict start body and snapshot schemas in
 * `packages/agent-contracts/src/index.ts`, the limits in
 * `packages/agent-contracts/fixtures/agent-runner-v1.json`, the start
 * handler in `lib/runner/http.ts` and the error table in
 * `lib/runner/transport.ts`.
 */
export const RUN_CONTRACT = Object.freeze({
  apiVersion: "1.0",
  maxCommandResults: 256,
  maxDetailsLength: 2_000,
  maxFileOperations: 256,
  maxMessageLength: 500,
  maxOutputLength: 100_000,
  maxRequestIdLength: 128,
  maxTaskLength: 40_000,
  revision: "0696af127207fb82cce734cd8c4ffa437d6f3502",
  route: "POST /api/agents/{agentId}/runs",
} as const);

export type RunGate = Readonly<{
  capability: string;
  issue: string;
  status: "missing";
}>;

/**
 * Upstream capabilities a canonically authorized #3 run needs that the
 * pinned revision lacks. Each one blocks the run before the run client is
 * called. A gate is removed only by a reviewed change that pins the
 * revision delivering it.
 *
 * - `read_only_execution`: every owner run at the pin is unrestricted.
 *   Server-selected read-only execution is coven-agents#299, carried by an
 *   unmerged, unreviewed pull request.
 * - `attempt_reference`: the public run contract reports no attempt.
 * - `concurrent_run_denial`: a second bound run is queued, not refused.
 * - `familiar_revision`: admission reads no familiar root or identity
 *   revision; the producer side is OpenCoven/coven#857.
 */
export const RUN_GATES: readonly RunGate[] = Object.freeze([
  Object.freeze({
    capability: "read_only_execution",
    issue: "https://github.com/OpenCoven/coven-agents/issues/299",
    status: "missing",
  } as const),
  Object.freeze({
    capability: "attempt_reference",
    issue: "https://github.com/OpenCoven/coven-agents/issues/326",
    status: "missing",
  } as const),
  Object.freeze({
    capability: "concurrent_run_denial",
    issue: "https://github.com/OpenCoven/coven-agents/issues/326",
    status: "missing",
  } as const),
  Object.freeze({
    capability: "familiar_revision",
    issue: "https://github.com/OpenCoven/coven/issues/857",
    status: "missing",
  } as const),
]);

/**
 * What the owner requires of the bound sandbox at dispatch, at the pin:
 * exact equality, where #2 preflight accepts block-all `true` and values
 * within ranges (PR #18 finding 6; maintainer decision on #2, 2026-11-20).
 * These are upstream's deployment defaults (`resource-policy.ts`) and the
 * bound-sandbox dispatch check (`daytona/sandbox.ts`). A deployment that
 * configures other values is refused here, never admitted: the error is a
 * false refusal, not a false ready. The owner also checks what Castles does
 * not observe at the accepted #2 revision (the domain list, labels, proxy);
 * those stay the owner's decision at dispatch.
 */
export const DISPATCH_EXPECTATION = Object.freeze({
  autoArchiveInterval: 10_080,
  autoStopInterval: 15,
  cpu: 2,
  diskGiB: 10,
  memoryGiB: 4,
  networkBlockAll: false,
  state: "started",
} as const);

/**
 * The pinned runtime manifest. `runtime/manifest.json` is this value, and a
 * test holds the file to it and to `RUNTIME_MANIFEST_SHA256`. Bootstrap is
 * snapshot verification only: Castles installs nothing. Every pin is source
 * policy the owner reports; only the observed snapshot name is measured,
 * from provider metadata, and nothing is measured inside the guest.
 */
export const RUNTIME_MANIFEST = Object.freeze({
  adapterVersion: "daytona-adapter-v1",
  bootstrap: "snapshot-verification-only",
  capabilityContractVersion: "hosted-v1",
  contracts: Object.freeze({
    inspection: Object.freeze({
      path: "packages/agent-contracts/src/sandbox-inspection.ts",
      sha256: "ee64a48644a08cae72cd0c40eb5094b97ff52ee122122c82482515a268f5f5b0",
      version: 1,
    }),
    run: Object.freeze({
      apiVersion: "1.0",
      path: "packages/agent-contracts/src/index.ts",
      sha256: "59ce690c306e526386c57f26124d64c8c939c1109b573ebed277b18c86325611",
    }),
  }),
  credentialBoundaryVersion: "attempt-reset-v1",
  decision: "https://github.com/OpenCoven/coven-agents/issues/300",
  harness: Object.freeze({
    id: "copilot",
    package: "@github/copilot",
    version: "1.0.80",
  }),
  measuredInGuest: false,
  provenance: Object.freeze({
    measured: Object.freeze([
      "observed.snapshot: provider metadata, read by the owner, not from inside the guest",
    ]),
    sourcePolicy: Object.freeze([
      "snapshotName",
      "harness",
      "adapterVersion",
      "capabilityContractVersion",
      "credentialBoundaryVersion",
      "sdkVersion",
    ]),
  }),
  schema: "castles.runtime-manifest.v1",
  sdkVersion: "0.231.1",
  snapshotName: "coven-agents-copilot-2",
  upstream: Object.freeze({
    repository: "OpenCoven/coven-agents",
    revision: "0696af127207fb82cce734cd8c4ffa437d6f3502",
  }),
} as const);

export const RUNTIME_MANIFEST_SHA256 =
  "2339fd8a07d9cc01a1fe842bf2e623f83c26d6b68d39c38a61153721e28bb8b6";

// --- Types --------------------------------------------------------------------

/** The run route's start request, as the owner's client would send it. */
export type StartRunRequest = Readonly<{
  agentId: string;
  body: Readonly<{
    operationId: string;
    sandboxBinding: Readonly<{
      expectedGeneration: number;
      expectedSandboxId: string;
    }>;
    task: string;
  }>;
}>;

/**
 * The constrained client over the owner run route. It answers `{status,
 * body}`: the HTTP status and JSON body. It carries the owner credential and
 * handles transport headers itself; Castles never sees either.
 */
export type OwnerRunClient = Readonly<{
  startRun(
    request: StartRunRequest,
    options: Readonly<{ signal: AbortSignal }>
  ): Promise<unknown> | unknown;
}>;

export type RunPlan = Readonly<{
  request: StartRunRequest;
  /** SHA-256 of the planned request, so a retry can prove it is the same. */
  requestDigest: string;
}>;

export type RunStatus = "admitted" | "blocked" | "refused" | "unavailable";

export type RunReasonCode =
  | "agent_id_not_canonical"
  | "binding_invalid"
  | "binding_refused"
  | "busy"
  | "capability_unsupported"
  | "dispatch_parity_unmet"
  | "lifecycle_conflict"
  | "operation_conflict"
  | "operation_id_invalid"
  | "owner_mismatch"
  | "preflight_not_ready"
  | "rate_limited"
  | "request_field_unsupported"
  | "request_invalid"
  | "request_rejected"
  | "run_contract_violation"
  | "run_identity_mismatch"
  | "subscription_required"
  | "task_invalid"
  | "unauthenticated"
  | "upstream_gate_missing"
  | "upstream_unavailable";

export type RunReason = Readonly<{ code: RunReasonCode; field?: string }>;

/**
 * Canonical references for #4/#5. `attemptId` is always null: the pinned
 * run contract reports no attempt (coven-agents#326).
 */
export type RunReference = Readonly<{
  attemptId: null;
  operationId: string;
  runId: string;
  status: string;
}>;

export type RunOutcome =
  | Readonly<{ kind: "admitted"; run: RunReference }>
  | Readonly<{
      code: RunReasonCode;
      field?: string;
      kind: "refused";
      status: RunStatus;
    }>;

export type RunResult = Readonly<{
  calls: Readonly<{ inspect: number; startRun: number }>;
  evidence: PreflightEvidence;
  preflight: Readonly<{ status: PreflightStatus | null }>;
  reasons: readonly RunReason[];
  requestDigest: string | null;
  run: RunReference | null;
  schema: "castles.run.v1";
  status: RunStatus;
}>;

export type RuntimeVerification = Readonly<{
  manifestSha256: string;
  measuredInGuest: false;
  mismatches: readonly Readonly<{ field: string }>[];
  schema: "castles.runtime-verification.v1";
  status: "compatible" | "incompatible" | "unreadable";
}>;

// --- Plain data ---------------------------------------------------------------

/** What `{}` and `[]` inherit from, taken once at load. */
const OBJECT_BASE = Object.getPrototypeOf({});
const ARRAY_BASE = Object.getPrototypeOf([]);

/**
 * The own entries of a plain object, or null. Only an object whose base is
 * a plain object's (or none), with no symbol key and only enumerable data
 * properties, is plain: an accessor is refused unread, so every value read
 * here is fixed.
 */
function plainEntries(value: unknown): Map<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const base = Object.getPrototypeOf(value);
  if (base !== OBJECT_BASE && base !== null) {
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const entries = new Map<string, unknown>();
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    entries.set(key, descriptor.value);
  }
  return entries;
}

/** A plain object with exactly the required keys and optional extras. */
function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Map<string, unknown> | null {
  const entries = plainEntries(value);
  if (entries === null) {
    return null;
  }
  for (const key of entries.keys()) {
    if (!required.includes(key) && !optional.includes(key)) {
      return null;
    }
  }
  return required.every((key) => entries.has(key)) ? entries : null;
}

/** The items of a plain, dense array of at most `max` items, or null. */
function plainArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== ARRAY_BASE) {
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const { length } = value;
  if (length > max || Object.getOwnPropertyNames(value).length !== length + 1) {
    return null;
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    items.push(descriptor.value);
  }
  return items;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

/** Upstream's bounded string: already trimmed, 1 to `max` characters. */
function isBounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    value.trim() === value
  );
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

// --- Planning -----------------------------------------------------------------

const REQUEST_KEYS = ["operationId", "task"];

/**
 * Plans the one start request. The caller supplies only an operation ID
 * (reused on any retry, so the owner returns the existing run) and the task
 * text. Everything else comes from the #2 binding: a familiar, sandbox,
 * permission, credential or account offered by the caller is refused, never
 * forwarded (ADM-06). The task must already be upstream's trimmed form, so
 * the planned text is the text the owner digests.
 */
export function planRun(
  binding: Binding,
  request: unknown
):
  | Readonly<{ ok: true; plan: RunPlan }>
  | Readonly<{ ok: false; reason: RunReason }> {
  const refuse = (reason: RunReason) => ({ ok: false as const, reason });
  const entries = plainEntries(request);
  if (entries === null) {
    return refuse({ code: "request_invalid" });
  }
  const unsupported = [...entries.keys()]
    .filter((key) => !REQUEST_KEYS.includes(key))
    .sort();
  if (unsupported.length > 0) {
    return refuse({ code: "request_field_unsupported", field: unsupported[0] });
  }
  const operationId = entries.get("operationId");
  if (!isCanonicalUuid(operationId)) {
    return refuse({ code: "operation_id_invalid" });
  }
  const task = entries.get("task");
  if (!isBounded(task, RUN_CONTRACT.maxTaskLength)) {
    return refuse({ code: "task_invalid" });
  }
  if (!isCanonicalUuid(binding.agentId)) {
    // The owner route takes a canonical UUID agent ID; #2's binding allows
    // other identifiers, which can never name an owner run.
    return refuse({ code: "agent_id_not_canonical" });
  }
  const body = Object.freeze({
    operationId,
    sandboxBinding: Object.freeze({
      expectedGeneration: binding.expectedGeneration,
      expectedSandboxId: binding.sandboxId,
    }),
    task,
  });
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify([
        "castles.run-request.v1",
        binding.agentId,
        operationId,
        task,
        binding.sandboxId,
        binding.expectedGeneration,
      ])
    )
    .digest("hex");
  return {
    ok: true,
    plan: Object.freeze({
      request: Object.freeze({ agentId: binding.agentId, body }),
      requestDigest,
    }),
  };
}

// --- Dispatch parity ----------------------------------------------------------

/**
 * The fields of a `ready` observation the owner would still refuse at
 * dispatch. An absent or null value fails: parity is shown, never assumed.
 */
export function checkDispatchParity(
  observed: ObservedSandbox | null
): RunReason[] {
  if (observed === null) {
    return [{ code: "dispatch_parity_unmet", field: "observed" }];
  }
  const expected = DISPATCH_EXPECTATION;
  const checks: [string, unknown, unknown][] = [
    ["state", observed.state, expected.state],
    ["exposure.networkBlockAll", observed.exposure?.networkBlockAll, expected.networkBlockAll],
    ["lifecycle.autoStopInterval", observed.lifecycle?.autoStopInterval, expected.autoStopInterval],
    ["lifecycle.autoArchiveInterval", observed.lifecycle?.autoArchiveInterval, expected.autoArchiveInterval],
    ["resources.cpu", observed.resources?.cpu, expected.cpu],
    ["resources.diskGiB", observed.resources?.diskGiB, expected.diskGiB],
    ["resources.memoryGiB", observed.resources?.memoryGiB, expected.memoryGiB],
  ];
  return checks
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([field]) => ({ code: "dispatch_parity_unmet" as const, field }));
}

// --- Reading an answer --------------------------------------------------------

const VIOLATION: RunOutcome = Object.freeze({
  code: "run_contract_violation",
  kind: "refused",
  status: "unavailable",
});

function refusedAs(status: RunStatus, code: RunReasonCode, field?: string): RunOutcome {
  return field === undefined
    ? { code, kind: "refused", status }
    : { code, field, kind: "refused", status };
}

/**
 * The start route's refusals at the pin: each upstream code with the one
 * HTTP status the error table gives it, and its Castles meaning. Castles
 * makes one call and never retries; `busy`, `rate_limited` and the 5xx
 * codes are `unavailable`, for the operator to retry with the same
 * operation ID. A 404 is a missing agent or another tenant's, which
 * upstream makes indistinguishable. A code the start route cannot emit, or
 * a code on another status, is a contract violation.
 */
const START_REFUSALS: ReadonlyMap<string, Readonly<{ http: number; outcome: RunOutcome }>> =
  new Map([
    ["invalid_request", { http: 400, outcome: refusedAs("refused", "request_rejected") }],
    ["unsupported_media_type", { http: 400, outcome: refusedAs("refused", "request_rejected") }],
    ["harness_unsupported", { http: 400, outcome: refusedAs("refused", "capability_unsupported") }],
    ["unauthorized", { http: 401, outcome: refusedAs("refused", "unauthenticated") }],
    ["subscription_required", { http: 403, outcome: refusedAs("refused", "subscription_required") }],
    ["origin_rejected", { http: 403, outcome: refusedAs("refused", "unauthenticated") }],
    ["not_found", { http: 404, outcome: refusedAs("refused", "owner_mismatch") }],
    ["operation_conflict", { http: 409, outcome: refusedAs("refused", "operation_conflict") }],
    ["busy", { http: 409, outcome: refusedAs("unavailable", "busy") }],
    ["agent_decommissioning", { http: 409, outcome: refusedAs("refused", "lifecycle_conflict") }],
    ["sandbox_binding_refused", { http: 409, outcome: VIOLATION }],
    ["body_too_large", { http: 413, outcome: refusedAs("refused", "request_rejected") }],
    ["rate_limited", { http: 429, outcome: refusedAs("unavailable", "rate_limited") }],
    ["internal_error", { http: 500, outcome: refusedAs("unavailable", "upstream_unavailable") }],
    ["runner_unavailable", { http: 503, outcome: refusedAs("unavailable", "upstream_unavailable") }],
    ["admission_unavailable", { http: 503, outcome: refusedAs("unavailable", "upstream_unavailable") }],
    ["abuse_control_unavailable", { http: 503, outcome: refusedAs("unavailable", "upstream_unavailable") }],
  ]);

/** The admission-time binding refusals at the pin (`lib/runner/store.ts`). */
const BINDING_REFUSALS: ReadonlySet<unknown> = new Set([
  "fence_outstanding",
  "generation_mismatch",
  "lifecycle_not_ready",
  "no_recorded_sandbox",
  "sandbox_id_mismatch",
]);

const RUN_STATUSES: ReadonlySet<unknown> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/** The run error object, as the snapshot and the refusal envelope carry it. */
function runError(value: unknown): Map<string, unknown> | null {
  const error = strictRecord(value, ["code", "message", "retryable"], ["details"]);
  if (
    error === null ||
    !isBounded(error.get("code"), 64) ||
    !isBounded(error.get("message"), RUN_CONTRACT.maxMessageLength) ||
    typeof error.get("retryable") !== "boolean" ||
    (error.has("details") &&
      !isBounded(error.get("details"), RUN_CONTRACT.maxDetailsLength))
  ) {
    return null;
  }
  return error;
}

function evidenceList(value: unknown, max: number): boolean {
  const items = plainArray(value, max);
  return items !== null && items.every((item) => plainEntries(item) !== null);
}

const SNAPSHOT_KEYS = [
  "agentId",
  "apiVersion",
  "commandEvidence",
  "completedAt",
  "createdAt",
  "fileEvidence",
  "id",
  "operationId",
  "output",
  "startedAt",
  "status",
  "task",
];

function parseAccepted(body: unknown, plan: RunPlan): RunOutcome {
  const envelope = strictRecord(body, ["apiVersion", "run"]);
  if (envelope === null || envelope.get("apiVersion") !== RUN_CONTRACT.apiVersion) {
    return VIOLATION;
  }
  const run = strictRecord(envelope.get("run"), SNAPSHOT_KEYS, ["error", "executedSandbox"]);
  if (run === null) {
    return VIOLATION;
  }
  const instantOrNull = (value: unknown) =>
    value === null || (typeof value === "string" && ISO_INSTANT.test(value));
  const executed = run.has("executedSandbox")
    ? strictRecord(run.get("executedSandbox"), ["bindingDigest", "generation"])
    : undefined;
  if (
    !isCanonicalUuid(run.get("agentId")) ||
    run.get("apiVersion") !== RUN_CONTRACT.apiVersion ||
    !evidenceList(run.get("commandEvidence"), RUN_CONTRACT.maxCommandResults) ||
    !evidenceList(run.get("fileEvidence"), RUN_CONTRACT.maxFileOperations) ||
    !instantOrNull(run.get("completedAt")) ||
    !instantOrNull(run.get("startedAt")) ||
    typeof run.get("createdAt") !== "string" ||
    !ISO_INSTANT.test(run.get("createdAt") as string) ||
    (run.has("error") && run.get("error") !== null && runError(run.get("error")) === null) ||
    !isCanonicalUuid(run.get("id")) ||
    !isCanonicalUuid(run.get("operationId")) ||
    typeof run.get("output") !== "string" ||
    (run.get("output") as string).length > RUN_CONTRACT.maxOutputLength ||
    !RUN_STATUSES.has(run.get("status")) ||
    !isBounded(run.get("task"), RUN_CONTRACT.maxTaskLength) ||
    executed === null ||
    (executed !== undefined &&
      (typeof executed.get("bindingDigest") !== "string" ||
        !DIGEST.test(executed.get("bindingDigest") as string) ||
        !isCount(executed.get("generation"), Number.MAX_SAFE_INTEGER)))
  ) {
    return VIOLATION;
  }
  // An answer about another agent, operation, task or sandbox generation is
  // never adopted as this run (ADM-05, ADM-08).
  const { agentId, body: planned } = plan.request;
  if (run.get("agentId") !== agentId) {
    return refusedAs("refused", "run_identity_mismatch", "run.agentId");
  }
  if (run.get("operationId") !== planned.operationId) {
    return refusedAs("refused", "run_identity_mismatch", "run.operationId");
  }
  if (run.get("task") !== planned.task) {
    return refusedAs("refused", "run_identity_mismatch", "run.task");
  }
  if (
    executed !== undefined &&
    executed.get("generation") !== planned.sandboxBinding.expectedGeneration
  ) {
    return refusedAs("refused", "run_identity_mismatch", "run.executedSandbox.generation");
  }
  return {
    kind: "admitted",
    run: Object.freeze({
      attemptId: null,
      operationId: run.get("operationId") as string,
      runId: run.get("id") as string,
      status: run.get("status") as string,
    }),
  };
}

function parseRefusal(http: number, body: unknown): RunOutcome {
  const envelope = strictRecord(body, ["apiVersion", "error", "requestId"]);
  if (
    envelope === null ||
    envelope.get("apiVersion") !== RUN_CONTRACT.apiVersion ||
    !isBounded(envelope.get("requestId"), RUN_CONTRACT.maxRequestIdLength)
  ) {
    return VIOLATION;
  }
  const error = runError(envelope.get("error"));
  if (error === null) {
    return VIOLATION;
  }
  const known = START_REFUSALS.get(error.get("code") as string);
  if (known === undefined || known.http !== http) {
    return VIOLATION;
  }
  if (error.get("code") === "sandbox_binding_refused") {
    const details = error.get("details");
    return BINDING_REFUSALS.has(details)
      ? refusedAs("refused", "binding_refused", details as string)
      : VIOLATION;
  }
  return known.outcome;
}

/**
 * Reads one start answer, `{status, body}`, against the pinned run contract.
 * Pure: it reads plain data only, and returns no upstream text except an
 * enumerated binding reason. A 202 is the only admission.
 */
export function parseRunAnswer(answer: unknown, plan: RunPlan): RunOutcome {
  const wrapper = strictRecord(answer, ["body", "status"]);
  if (wrapper === null) {
    return VIOLATION;
  }
  const http = wrapper.get("status");
  if (typeof http !== "number" || !Number.isSafeInteger(http)) {
    return VIOLATION;
  }
  if (http === 202) {
    return parseAccepted(wrapper.get("body"), plan);
  }
  const listed = [...START_REFUSALS.values()].some((entry) => entry.http === http);
  return listed ? parseRefusal(http, wrapper.get("body")) : VIOLATION;
}

// --- Runtime verification -----------------------------------------------------

const PIN_MAX = 256;
const POLICY_KEYS = [
  "adapterVersion",
  "capabilityContractVersion",
  "credentialBoundaryVersion",
  "harnesses",
  "resources",
  "sdkVersion",
  "snapshotName",
  "target",
];

function verification(
  status: RuntimeVerification["status"],
  mismatches: readonly Readonly<{ field: string }>[] = []
): RuntimeVerification {
  return {
    manifestSha256: RUNTIME_MANIFEST_SHA256,
    measuredInGuest: false,
    mismatches,
    schema: "castles.runtime-verification.v1",
    status,
  };
}

/**
 * Compares a server-owned verification report with the pinned manifest.
 * The report is `{version, policy, observedSnapshot}`: an inspection v1
 * answer's `policy` block and its observed snapshot name, as the owner
 * returns them. Pure and read-only: it installs, resets, starts and writes
 * nothing, and the same report always gives the same result (BST-02). A
 * report that is not v1's exact shape is `unreadable`, never compatible
 * (BST-03); a pin that differs is `incompatible` and names the field
 * (BST-01, BST-04). It is a comparison with source policy, not a
 * measurement of the guest.
 */
export function verifyRuntime(report: unknown): RuntimeVerification {
  const manifest = RUNTIME_MANIFEST;
  const top = strictRecord(report, ["observedSnapshot", "policy", "version"]);
  if (
    top === null ||
    top.get("version") !== manifest.contracts.inspection.version ||
    !isBounded(top.get("observedSnapshot"), PIN_MAX)
  ) {
    return verification("unreadable");
  }
  const policy = strictRecord(top.get("policy"), POLICY_KEYS);
  if (policy === null) {
    return verification("unreadable");
  }
  const pins = [
    "adapterVersion",
    "capabilityContractVersion",
    "credentialBoundaryVersion",
    "sdkVersion",
    "snapshotName",
  ];
  if (
    !pins.every((key) => isBounded(policy.get(key), PIN_MAX)) ||
    !isBounded(policy.get("target"), 64)
  ) {
    return verification("unreadable");
  }
  const resources = strictRecord(policy.get("resources"), ["cpu", "diskGib", "memoryGib"]);
  if (resources === null || ![...resources.values()].every((value) => isCount(value, 4_096))) {
    return verification("unreadable");
  }
  const harnessItems = plainArray(policy.get("harnesses"), 16);
  if (harnessItems === null) {
    return verification("unreadable");
  }
  const harnesses: Map<string, unknown>[] = [];
  for (const item of harnessItems) {
    const harness = strictRecord(item, ["id", "package", "version"]);
    if (harness === null || ![...harness.values()].every((value) => isBounded(value, PIN_MAX))) {
      return verification("unreadable");
    }
    harnesses.push(harness);
  }

  const mismatches: { field: string }[] = [];
  if (top.get("observedSnapshot") !== manifest.snapshotName) {
    mismatches.push({ field: "observedSnapshot" });
  }
  if (policy.get("snapshotName") !== manifest.snapshotName) {
    mismatches.push({ field: "policy.snapshotName" });
  }
  const [only] = harnesses;
  if (
    harnesses.length !== 1 ||
    only === undefined ||
    only.get("id") !== manifest.harness.id ||
    only.get("package") !== manifest.harness.package ||
    only.get("version") !== manifest.harness.version
  ) {
    mismatches.push({ field: "policy.harnesses" });
  }
  for (const key of [
    "adapterVersion",
    "capabilityContractVersion",
    "credentialBoundaryVersion",
    "sdkVersion",
  ] as const) {
    if (policy.get(key) !== manifest[key]) {
      mismatches.push({ field: `policy.${key}` });
    }
  }
  return mismatches.length === 0
    ? verification("compatible")
    : verification("incompatible", mismatches);
}

// --- Running ------------------------------------------------------------------

export type RunClients = Readonly<{
  inspection: SandboxInspectionClient | null;
  runs: OwnerRunClient | null;
}>;

export type RunOptions = Readonly<{ timeoutMs?: number }>;

function result(
  status: RunStatus,
  reasons: readonly RunReason[],
  fields: Partial<Pick<RunResult, "calls" | "evidence" | "preflight" | "requestDigest">> = {}
): RunResult {
  return {
    calls: fields.calls ?? { inspect: 0, startRun: 0 },
    evidence: fields.evidence ?? "none",
    preflight: fields.preflight ?? { status: null },
    reasons,
    requestDigest: fields.requestDigest ?? null,
    run: null,
    schema: "castles.run.v1",
    status,
  };
}

/**
 * Runs one task on the bound sandbox, or says exactly why not. In order,
 * and stopping at the first refusal:
 *
 * 1. the #2 binding and the request are checked, with no call;
 * 2. #2 preflight runs (one read-only inspection) and must be `ready`;
 * 3. the observation must meet the owner's exact dispatch configuration;
 * 4. every upstream gate must be present.
 *
 * While any gate is missing the run client is never called, whatever it
 * is: the result is `blocked` and names each missing capability. The one
 * bounded start call, and reading its answer with `parseRunAnswer`, is added
 * by the reviewed change that clears the last gate. The result never
 * carries the task text, the configured IDs or upstream text.
 */
export async function runTask(
  environment: Readonly<Record<string, string | undefined>>,
  clients: RunClients,
  request: unknown,
  options: RunOptions = {}
): Promise<RunResult> {
  const parsed = parseBinding(environment);
  if (!parsed.ok) {
    return result("refused", [{ code: "binding_invalid", field: parsed.problem }]);
  }
  const planned = planRun(parsed.binding, request);
  if (!planned.ok) {
    return result("refused", [planned.reason]);
  }
  const { requestDigest } = planned.plan;
  const preflight = await runPreflight(
    environment,
    clients.inspection,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
  );
  const fields = {
    calls: { inspect: preflight.providerCalls.inspect, startRun: 0 },
    evidence: preflight.evidence,
    preflight: { status: preflight.status },
    requestDigest,
  };
  if (preflight.status !== "ready") {
    return result("refused", [{ code: "preflight_not_ready" }], fields);
  }
  const parity = checkDispatchParity(preflight.observed);
  if (parity.length > 0) {
    return result("refused", parity, fields);
  }
  const missing = RUN_GATES.filter((gate) => gate.status === "missing");
  return result(
    "blocked",
    missing.map((gate) => ({ code: "upstream_gate_missing", field: gate.capability })),
    fields
  );
}

/**
 * No live run client exists at this revision, and every result stops
 * before the run client, so no result is live evidence of a run.
 */
export function isLiveRun(_value: RunResult): false {
  return false;
}
