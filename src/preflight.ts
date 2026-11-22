/**
 * Read-only preflight for one explicitly bound, existing sandbox.
 *
 * The only provider-facing capability this module can reach is
 * `SandboxInspectionClient.inspectBoundSandbox`. There is no create, start,
 * stop, resize, delete, list, or lookup-by-name anywhere in the seam, so a
 * failed check has nothing to fall back to.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BINDING_ENVIRONMENT_KEYS,
  type Binding,
  type BindingProblem,
  parseBinding,
  SOURCE_PINS,
  SUPPORTED_PROFILE,
  UPSTREAM_SEAM,
} from "./profile.ts";

export const FIXTURE_LABEL =
  "SYNTHETIC FIXTURE - invented values, not provider evidence";
/**
 * The upstream contract this client reads: `sandbox-inspection` version 1,
 * `packages/agent-contracts/src/sandbox-inspection.ts` in coven-agents at the
 * pinned revision (landed through coven-agents #311 and #312). Upstream owns
 * the wire shape; Castles conforms here and nowhere else.
 */
export const INSPECTION_CONTRACT_VERSION = 1;
export const PREFLIGHT_JSON_MAX_BYTES = 16_384;
export const DEFAULT_INSPECTION_TIMEOUT_MS = 30_000;
/** The longest delay a Node timer accepts. Node turns a longer one into 1 ms. */
const MAX_INSPECTION_TIMEOUT_MS = 2_147_483_647;
const MAX_REASONS = 16;

// --- The constrained client seam -------------------------------------------

export type InspectionRequest = Readonly<{
  agentId: string;
  expectedGeneration: number;
  sandboxId: string;
  includeProviderMetadata?: true;
}>;

/**
 * What a seam method resolves to: the owning service's HTTP status and its
 * parsed JSON body. A client backed by the upstream route sends
 * `POST /api/agents/{agentId}/sandbox/inspection` with the body
 * `{ expectedGeneration, expectedSandboxId }` and the owner credential the
 * route requires. Upstream answers every refusal except the database-decided
 * and provider-decided ones with a non-200 status and an error envelope, so
 * the status is part of the answer. `body` is `undefined` when there was no
 * JSON body. Both are untrusted input here.
 */
export type InspectionAnswer = Readonly<{ body: unknown; status: number }>;

/**
 * The whole provider surface available to Castles. An implementation must be
 * backed by the existing Coven Agents lifecycle owner, which authenticates
 * the caller, derives the tenant itself, reads its own canonical record, and
 * performs one exact-ID provider read. It should resolve to an
 * `InspectionAnswer`; whatever it resolves to is untrusted input here.
 */
export type SandboxInspectionClient = Readonly<{
  inspectBoundSandbox: (
    request: InspectionRequest,
    options?: Readonly<{ signal: AbortSignal }>
  ) => Promise<unknown>;
}>;

// --- The result shape -------------------------------------------------------

export type PreflightStatus =
  | "ready"
  | "stopped"
  | "unavailable"
  | "incompatible"
  | "unauthorized"
  | "reconciliation-required";

export type PreflightEvidence = "fixture" | "live-provider" | "none";

export type ReasonCode =
  | BindingProblem
  | "ambiguous_lookup"
  | "attempt_fence_held"
  | "binding_lifecycle_pending"
  | "binding_mismatch"
  | "credential_boundary_unverified"
  | "egress_allow_list_unsafe"
  | "egress_unrestricted"
  | "generation_mismatch"
  | "gpu_present"
  | "image_unqualified"
  | "inspection_contract_violation"
  | "lifecycle_auto_archive"
  | "lifecycle_auto_delete"
  | "lifecycle_auto_pause"
  | "lifecycle_auto_stop"
  | "lifecycle_not_settled"
  | "lifecycle_ttl"
  | "linked_sandbox_present"
  | "metadata_missing"
  | "owner_mismatch"
  | "provider_unavailable"
  | "public_exposure"
  | "resources_out_of_policy"
  | "returned_id_mismatch"
  | "sandbox_destroyed"
  | "sandbox_not_found"
  | "sandbox_stopped"
  | "sdk_generation_mismatch"
  | "target_unsupported"
  | "unauthenticated"
  | "upstream_seam_missing"
  | "volumes_present"
  | "warm_pool_member";

/** `field` is always one of this module's own literals, never provider text. */
export type Reason = Readonly<{ code: ReasonCode; field?: string }>;

export type ObservedSandbox = Readonly<{
  attachments: Readonly<{
    linkedSandbox: boolean | null;
    volumes: number | null;
    warmPool: boolean | null;
  }>;
  binding: Readonly<{
    /** Castles' vocabulary: upstream's `none` is echoed as `clear`. */
    attemptFence: string;
    /** Null when the recorded generation is outside the echoed range. */
    generation: number | null;
    lifecycle: string;
  }>;
  /**
   * Upstream withholds the raw allow lists and reports comparisons with the
   * owner's configured policy instead, so these are all Castles can echo.
   */
  exposure: Readonly<{
    domainAllowListConfigured: boolean | null;
    domainAllowListMatchesPolicy: boolean | null;
    networkAllowListConfigured: boolean | null;
    networkBlockAll: boolean | null;
    outboundProxyConfigured: boolean | null;
    public: boolean | null;
  }>;
  /** Upstream's own checks of the sandbox's labels and configuration. */
  identity: Readonly<{
    configuration: string | null;
    credentialBoundary: boolean | null;
    generationLabel: boolean | null;
    ownershipLabels: boolean | null;
  }>;
  image: Readonly<{ snapshot: string | null }>;
  lifecycle: Readonly<{
    autoArchiveInterval: number | null;
    autoDeleteInterval: number | null;
    autoDestroyAt: "absent" | "present" | null;
    autoPauseInterval: number | null;
    autoStopInterval: number | null;
  }>;
  /**
   * Never observed: upstream v1 reports no platform (coven-agents#323). The
   * platform is source policy implied by the qualified snapshot; see
   * `SUPPORTED_PROFILE.platform`.
   */
  platform: Readonly<{ architecture: null; os: null }>;
  resources: Readonly<{
    cpu: number | null;
    diskGiB: number | null;
    gpu: number | null;
    matchesTarget: boolean;
    memoryGiB: number | null;
  }>;
  /** The server-selected SDK version: source policy upstream, not measured. */
  sdk: Readonly<{ version: string | null }>;
  state: string | null;
  target: string | null;
}>;

export type PreflightResult = Readonly<{
  evidence: PreflightEvidence;
  /**
   * Provider metadata as reported through the seam. Null whenever the seam
   * refused, the echoed agent record or recorded sandbox ID differs from the
   * binding, or upstream's ownership-label or configuration check failed. A
   * stale generation alone does not withhold it: by then the owning service
   * has authenticated the caller for this exact record and sandbox, and the
   * operator needs the detail to reconcile.
   */
  observed: ObservedSandbox | null;
  providerCalls: Readonly<{ inspect: number }>;
  reasons: readonly Reason[];
  schema: "castles.preflight.v1";
  /** Pinned source policy. Never derived from the sandbox. */
  sourcePolicy: Readonly<{
    image: typeof SUPPORTED_PROFILE.image;
    lifecycle: typeof SUPPORTED_PROFILE.lifecycle;
    network: typeof SUPPORTED_PROFILE.network;
    pins: readonly string[];
    platform: typeof SUPPORTED_PROFILE.platform;
    profile: string;
    resources: typeof SUPPORTED_PROFILE.resources;
    sdk: typeof SUPPORTED_PROFILE.sdk;
  }>;
  status: PreflightStatus;
  target: Readonly<{
    expectedGeneration: number | null;
    ownerAlias: string | null;
    profile: string | null;
    sandboxAlias: string | null;
  }>;
  upstream: Readonly<{ issue: string; seam: "missing" }>;
}>;

// --- Helpers ----------------------------------------------------------------

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Upstream's v1 objects are strict, so a key it does not define means the
 * contract moved. Refusing it keeps a new field, which may be a safety
 * field, from being silently ignored here.
 */
function hasOnly(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Deeper than any v1 answer nests; a deeper value is not v1. */
const PLAIN_DEPTH = 8;
/** More entries than any v1 array carries. */
const PLAIN_ARRAY_MAX = 1_000;
/**
 * More values than any v1 answer holds, counted across the whole copy. The
 * deadline covers the client's call, not this copy, so the copy has its own
 * bound: a graph of shared references is refused before it is walked
 * (third read rv18b-f2bd3f93, finding 4).
 */
const PLAIN_VALUES_MAX = 10_000;
/** What `{}` and `[]` inherit from, taken once at load. */
const PLAIN_OBJECT_BASE = Object.getPrototypeOf({});
const PLAIN_ARRAY_BASE = Object.getPrototypeOf([]);

/**
 * One own, enumerable key's value, read exactly once, or null when the key
 * is absent or not enumerable. A getter runs once; a read that throws is not
 * caught.
 */
function readOwn(value: object, key: string): { value: unknown } | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.enumerable !== true) {
    return null;
  }
  return {
    value: Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : (value as Record<string, unknown>)[key],
  };
}

/**
 * A plain copy of an answer, or null when it is not plain data. An answer
 * held in memory is not JSON: a key can be non-enumerable, inherited or a
 * symbol, and a getter can answer differently on each read (second read
 * rv18-7c3e91a4, findings 2 and 3). Only plain objects (one with no base
 * included) and plain arrays are copied, every own key must be an
 * enumerable string, and each value is read exactly once. Strict-key checks
 * and every later read then see one fixed value. A read that throws is not
 * caught here: the caller's error comes back, as documented.
 */
function plainCopy(
  value: unknown,
  depth: number,
  budget: { left: number }
): { value: unknown } | null {
  budget.left -= 1;
  if (budget.left < 0) {
    return null;
  }
  if (typeof value === "function") {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return { value };
  }
  if (depth >= PLAIN_DEPTH) {
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const keys = Object.getOwnPropertyNames(value);
  const readOnce = (key: string): { value: unknown } | null => {
    const entry = readOwn(value, key);
    return entry === null ? null : plainCopy(entry.value, depth + 1, budget);
  };
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== PLAIN_ARRAY_BASE) {
      return null;
    }
    const { length } = value;
    if (
      !Number.isSafeInteger(length) ||
      length > PLAIN_ARRAY_MAX ||
      keys.length !== length + 1
    ) {
      return null;
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = readOnce(String(index));
      if (item === null) {
        return null;
      }
      items.push(item.value);
    }
    return { value: items };
  }
  const base = Object.getPrototypeOf(value);
  if (base !== PLAIN_OBJECT_BASE && base !== null) {
    return null;
  }
  // A copy with no base object, so an absent key reads as absent even when
  // the shared base object has been given that key (third read
  // rv18b-f2bd3f93, finding 5).
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const entry = readOnce(key);
    if (entry === null) {
      return null;
    }
    // defineProperty, not assignment, so every key stays an own data key
    // and the strict-key check sees it.
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: entry.value,
      writable: true,
    });
  }
  return { value: copy };
}

function alias(prefix: "own" | "sbx", value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const digest = createHash("sha256")
    .update(`castles.${prefix}\0${value}`, "utf8")
    .digest("hex");
  return `${prefix}_${digest.slice(0, 12)}`;
}

/**
 * Echo vocabulary. Provider-supplied text is never copied into a result:
 * `observed` carries only a value from one of these fixed sets, a strict
 * `major.minor.patch` SDK version, `"unrecognised"` for any other string, a
 * boolean, or null for an absent or mistyped value. A field set to a private
 * ID, a credential or any other free text therefore cannot reach human or
 * JSON output. Numbers have their own rule: see `echoedInteger`.
 *
 * Sources, all in coven-agents
 * `packages/agent-contracts/src/sandbox-inspection.ts` at the pinned
 * revision: sandbox states are upstream's seven coarse states; binding
 * lifecycles and configuration identities are its enums. `FENCE_ECHO` maps
 * upstream's three fence values to Castles' own vocabulary.
 */
const UNRECOGNISED = "unrecognised";
const KNOWN = Object.freeze({
  bindingLifecycle: [
    "unprovisioned",
    "provisioning",
    "provisioning_ambiguous",
    "ready",
    "resizing",
    "resetting",
    "decommissioning",
    "decommission_failed",
  ],
  configuration: ["current", "prior", "mismatch"],
  snapshot: [SUPPORTED_PROFILE.image.qualifiedSnapshot],
  state: [
    "started",
    "stopped",
    "archived",
    "transitioning",
    "error",
    "destroyed",
    "unknown",
  ],
  target: SUPPORTED_PROFILE.targets,
} as const satisfies Record<string, readonly string[]>);

/** Upstream fence value to Castles' echo vocabulary. */
const FENCE_ECHO: ReadonlyMap<unknown, string> = new Map([
  ["none", "clear"],
  ["attempt_outstanding", "attempt_outstanding"],
  ["cleanup_required", "cleanup_required"],
]);

/** Three plain decimal components and nothing else. */
const SDK_VERSION =
  /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/;

/** A member of the set, `"unrecognised"` for other text, null if absent. */
function known(value: unknown, set: readonly string[]): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return set.includes(value) ? value : UNRECOGNISED;
}

function sdkVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return SDK_VERSION.test(value) ? value : UNRECOGNISED;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The only integers `observed` may carry. An identifier may be all digits,
 * so a numeric field is a second way for a configured ID to come back from
 * the seam. Every resource and lifecycle reading this profile can accept
 * lies between -1 (auto-delete disabled) and 43,200 (the auto-archive
 * ceiling); the range leaves room to show a reading that is out of policy,
 * and no more.
 *
 * The recorded generation is the one field whose accepted values can lie
 * outside the range: a binding may state up to nine digits. From 100,000 up
 * it is not echoed even when it matches. The match still shows, as the
 * absence of `generation_mismatch` beside `target.expectedGeneration`.
 */
const ECHOED_INTEGER = Object.freeze({ max: 99_999, min: -1 });

/**
 * A reading as it may be printed: the integer itself inside
 * `ECHOED_INTEGER`, null outside it or when it is not an integer. This
 * bounds output only. Policy is always evaluated on the reading itself, so
 * a number that is not echoed still produces its reason code.
 *
 * What this does not do: an ID that is itself an integer inside the range
 * (at most five digits) cannot be told from a reading and is printed when a
 * field reports that number.
 */
function echoedInteger(value: unknown): number | null {
  const reading = integer(value);
  return reading !== null &&
    reading >= ECHOED_INTEGER.min &&
    reading <= ECHOED_INTEGER.max
    ? reading
    : null;
}

/** The most a count in `observed` may say. */
const ECHOED_COUNT_MAX = 999;

/**
 * A reported count: the value when it is an integer from 0 up, otherwise
 * null. Anything else (a negative number, a fraction, `NaN`, a bigint, a
 * string) is not a count, so the volume policy does not read it as "no
 * volume" and the echo does not print it.
 */
function countOf(value: unknown): number | null {
  const reading = integer(value);
  return reading !== null && reading >= 0 ? reading : null;
}

/**
 * A count as it may be printed: an integer from 0 to `ECHOED_COUNT_MAX`,
 * or null when the value is not a count (see `countOf`). Printing a negative
 * or fractional value would be a third way for an all-digit ID to come back.
 */
function echoedCount(value: unknown): number | null {
  const count = countOf(value);
  return count === null ? null : Math.min(count, ECHOED_COUNT_MAX);
}

const PRIORITY: readonly PreflightStatus[] = [
  "unauthorized",
  "reconciliation-required",
  "incompatible",
  "unavailable",
  "stopped",
];

class Findings {
  readonly #reasons: { reason: Reason; status: PreflightStatus }[] = [];

  add(status: PreflightStatus, code: ReasonCode, field?: string): void {
    this.#reasons.push({
      reason: field === undefined ? { code } : { code, field },
      status,
    });
  }

  status(): PreflightStatus {
    return (
      PRIORITY.find((status) =>
        this.#reasons.some((entry) => entry.status === status)
      ) ?? "ready"
    );
  }

  reasons(): readonly Reason[] {
    return PRIORITY.flatMap((status) =>
      this.#reasons
        .filter((entry) => entry.status === status)
        .map((entry) => entry.reason)
    ).slice(0, MAX_REASONS);
  }
}

function sourcePolicy(): PreflightResult["sourcePolicy"] {
  return {
    image: SUPPORTED_PROFILE.image,
    lifecycle: SUPPORTED_PROFILE.lifecycle,
    network: SUPPORTED_PROFILE.network,
    pins: SOURCE_PINS.map((entry) => entry.pin),
    platform: SUPPORTED_PROFILE.platform,
    profile: SUPPORTED_PROFILE.id,
    resources: SUPPORTED_PROFILE.resources,
    sdk: SUPPORTED_PROFILE.sdk,
  };
}

function result(
  findings: Findings,
  partial: Partial<Binding>,
  evidence: PreflightEvidence,
  inspectCalls: number,
  observed: ObservedSandbox | null
): PreflightResult {
  return {
    evidence,
    observed,
    providerCalls: { inspect: inspectCalls },
    reasons: findings.reasons(),
    schema: "castles.preflight.v1",
    sourcePolicy: sourcePolicy(),
    status: findings.status(),
    target: {
      expectedGeneration: partial.expectedGeneration ?? null,
      ownerAlias: alias("own", partial.agentId),
      profile: partial.profile ?? null,
      sandboxAlias: alias("sbx", partial.sandboxId),
    },
    upstream: { issue: UPSTREAM_SEAM.issue, seam: UPSTREAM_SEAM.status },
  };
}

// --- Parsing the v1 answer --------------------------------------------------

type ObservedEnvelope = Readonly<{
  identity: UnknownRecord;
  observed: UnknownRecord;
  policy: UnknownRecord;
  record: Readonly<{
    agentId: string;
    fence: string;
    generation: number;
    lifecycle: string;
    sandboxId: string | null;
  }>;
}>;

type Inspection =
  | Readonly<{ kind: "observed"; value: ObservedEnvelope }>
  | Readonly<{ code: ReasonCode; kind: "refused"; status: PreflightStatus }>;

function refused(status: PreflightStatus, code: ReasonCode): Inspection {
  return { code, kind: "refused", status };
}

const VIOLATION = refused("unavailable", "inspection_contract_violation");

/**
 * Upstream's non-200 refusals. The status decides, and the body is neither
 * read nor copied (third read rv18b-f2bd3f93, finding 3).
 * Maintainer decision (coven-castles#2, 2026-11-20): 403 is a missing
 * subscription or a refused origin, and 404 is a missing agent or another
 * tenant's, which upstream makes indistinguishable; both refuse as
 * `owner_mismatch`. 429 (rate limited, with retry-after) and 503 (provider,
 * runner or abuse control unavailable) refuse as `provider_unavailable`,
 * and Castles never retries. So does 500, upstream's retryable internal
 * error (second read rv18-7c3e91a4, finding 4). Every other status is a
 * contract violation, the gateway statuses 502 and 504 included. Known and
 * accepted imprecision: a 403 for a missing subscription reads as
 * `owner_mismatch`.
 */
const HTTP_REFUSALS: ReadonlyMap<number, Inspection> = new Map([
  [401, refused("unauthorized", "unauthenticated")],
  [403, refused("unauthorized", "owner_mismatch")],
  [404, refused("unauthorized", "owner_mismatch")],
  [429, refused("unavailable", "provider_unavailable")],
  [500, refused("unavailable", "provider_unavailable")],
  [503, refused("unavailable", "provider_unavailable")],
]);

/** v1's database-decided ambiguity never discloses the recorded ID. */
const AMBIGUOUS_FROM_DATABASE: ReadonlySet<unknown> = new Set([
  "generation_mismatch",
  "no_recorded_sandbox",
  "pending_lifecycle",
  "sandbox_id_mismatch",
]);

const UNAVAILABLE_SOURCES: ReadonlySet<unknown> = new Set(["database", "provider"]);

/** Upstream's ambiguous reasons, each mapped to an existing Castles code. */
const AMBIGUOUS: ReadonlyMap<unknown, Inspection> = new Map([
  ["generation_mismatch", refused("reconciliation-required", "generation_mismatch")],
  ["no_recorded_sandbox", refused("reconciliation-required", "ambiguous_lookup")],
  ["pending_lifecycle", refused("reconciliation-required", "binding_lifecycle_pending")],
  ["returned_id_mismatch", refused("reconciliation-required", "returned_id_mismatch")],
  ["sandbox_id_mismatch", refused("unauthorized", "binding_mismatch")],
]);

const RECORD_KEYS = ["agentId", "fence", "generation", "lifecycle", "sandboxId"];
const OBSERVED_KEYS = [
  "autoArchiveInterval",
  "autoDeleteInterval",
  "autoDestroyAtConfigured",
  "autoPauseInterval",
  "autoStopInterval",
  "cpu",
  "diskGib",
  "domainAllowListConfigured",
  "domainAllowListMatchesPolicy",
  "gpu",
  "identity",
  "linkedSandbox",
  "memoryGib",
  "networkAllowListConfigured",
  "networkBlockAll",
  "outboundProxyConfigured",
  "public",
  "snapshot",
  "state",
  "target",
  "volumes",
  "warmPool",
];
const IDENTITY_KEYS = [
  "configuration",
  "credentialBoundary",
  "generationLabel",
  "ownershipLabels",
];
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

const HARNESS_KEYS = ["id", "package", "version"];
const RESOURCE_KEYS = ["cpu", "diskGib", "memoryGib"];
const PIN_MAX = 256;
const POLICY_TARGET_MAX = 64;
const HARNESSES_MAX = 16;
const RESOURCE_MAX = 4_096;

function isPin(value: unknown, max = PIN_MAX): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isResource(value: unknown): boolean {
  const count = countOf(value);
  return count !== null && count <= RESOURCE_MAX;
}

/**
 * The policy has v1's shape (third read rv18b-f2bd3f93, finding 1). The six
 * fields Castles does not read are always checked: an answer upstream's
 * schema refuses is a contract violation, not a policy Castles can score.
 * On an observed answer the two fields Castles reads, `sdkVersion` and
 * `credentialBoundaryVersion`, keep their own reason codes; a refusal has no
 * such codes, so `complete` checks them here too.
 */
function isPolicy(value: unknown, complete: boolean): value is UnknownRecord {
  if (!isRecord(value) || !hasOnly(value, POLICY_KEYS)) {
    return false;
  }
  const { harnesses, resources } = value;
  return (
    isPin(value.adapterVersion) &&
    isPin(value.capabilityContractVersion) &&
    isPin(value.snapshotName) &&
    isPin(value.target, POLICY_TARGET_MAX) &&
    Array.isArray(harnesses) &&
    harnesses.length <= HARNESSES_MAX &&
    harnesses.every(
      (harness) =>
        isRecord(harness) &&
        hasOnly(harness, HARNESS_KEYS) &&
        isPin(harness.id) &&
        isPin(harness.package) &&
        isPin(harness.version)
    ) &&
    isRecord(resources) &&
    hasOnly(resources, RESOURCE_KEYS) &&
    isResource(resources.cpu) &&
    isResource(resources.diskGib) &&
    isResource(resources.memoryGib) &&
    (!complete ||
      (isPin(value.sdkVersion) && isPin(value.credentialBoundaryVersion)))
  );
}

/** v1's identifier rule for the record's agent and sandbox IDs. */
const V1_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function isV1Identifier(value: unknown): boolean {
  return typeof value === "string" && V1_IDENTIFIER.test(value);
}

/**
 * A refusal's record matches v1 exactly (third read rv18b-f2bd3f93, finding
 * 2). An observed record keeps the type check in `parseRecord`: there an
 * unknown lifecycle or fence refuses with its own reason code.
 */
function isV1Record(record: ObservedEnvelope["record"]): boolean {
  return (
    isV1Identifier(record.agentId) &&
    (record.sandboxId === null || isV1Identifier(record.sandboxId)) &&
    (KNOWN.bindingLifecycle as readonly string[]).includes(record.lifecycle) &&
    FENCE_ECHO.has(record.fence)
  );
}

/**
 * A refusal about another agent, or about a sandbox other than the
 * configured one, is never read as this binding's (third read
 * rv18b-f2bd3f93, finding 2). A null recorded ID discloses nothing and is
 * not compared.
 */
function foreignRecord(
  record: ObservedEnvelope["record"],
  binding: Binding
): Inspection | null {
  if (record.agentId !== binding.agentId) {
    return refused("unauthorized", "owner_mismatch");
  }
  if (record.sandboxId !== null && record.sandboxId !== binding.sandboxId) {
    return refused("unauthorized", "binding_mismatch");
  }
  return null;
}

function parseRecord(value: unknown): ObservedEnvelope["record"] | null {
  if (!isRecord(value) || !hasOnly(value, RECORD_KEYS)) {
    return null;
  }
  const generation = countOf(value.generation);
  if (
    typeof value.agentId !== "string" ||
    !(value.sandboxId === null || typeof value.sandboxId === "string") ||
    generation === null ||
    typeof value.lifecycle !== "string" ||
    typeof value.fence !== "string"
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    fence: value.fence,
    generation,
    lifecycle: value.lifecycle,
    sandboxId: value.sandboxId,
  };
}

const PROVIDER_METADATA_KEYS = [
  "autoDestroyAtConfigured", "linkedSandbox", "platform", "volumes", "warmPool",
];

/** The exact opt-in shape at coven-agents 6dedc26; unknown is explicit null. */
function isProviderMetadata(value: unknown): value is UnknownRecord {
  if (!isRecord(value) || !hasOnly(value, PROVIDER_METADATA_KEYS)) {
    return false;
  }
  for (const key of ["autoDestroyAtConfigured", "linkedSandbox", "warmPool"]) {
    if (value[key] !== null && typeof value[key] !== "boolean") {
      return false;
    }
  }
  const count = value.volumes;
  if (count !== null && !(typeof count === "number" && Number.isInteger(count)
    && count >= 0 && count <= 1024)) {
    return false;
  }
  if (!isRecord(value.platform)) {
    return false;
  }
  const { architecture, os, ...extraPlatformKeys } = value.platform;
  if (Object.keys(extraPlatformKeys).length !== 0) {
    return false;
  }
  return [architecture, os].every(
    v => v === null || (typeof v === "string" && v.length >= 1 && v.length <= 64)
  );
}

function parseBody(body: unknown, binding: Binding, details: boolean): Inspection {
  if (!isRecord(body) || body.version !== INSPECTION_CONTRACT_VERSION) {
    return VIOLATION;
  }
  switch (body.outcome) {
    // Each refusal must carry the keys v1 requires for it (second read
    // rv18-7c3e91a4, finding 5), in v1's exact shape, and must be about this
    // binding (third read rv18b-f2bd3f93, finding 2). Its record and policy
    // are checked, never disclosed.
    case "not_found": {
      const record = parseRecord(body.record);
      if (
        !hasOnly(body, ["outcome", "policy", "record", "version"]) ||
        record === null ||
        !isV1Record(record) ||
        !isPolicy(body.policy, true)
      ) {
        return VIOLATION;
      }
      return (
        foreignRecord(record, binding) ??
        refused("unavailable", "sandbox_not_found")
      );
    }
    case "ambiguous": {
      const record = parseRecord(body.record);
      if (
        !hasOnly(body, ["outcome", "reason", "record", "version"]) ||
        record === null ||
        !isV1Record(record) ||
        (AMBIGUOUS_FROM_DATABASE.has(body.reason) && record.sandboxId !== null)
      ) {
        return VIOLATION;
      }
      const mapped = AMBIGUOUS.get(body.reason);
      if (mapped === undefined) {
        return VIOLATION;
      }
      return foreignRecord(record, binding) ?? mapped;
    }
    case "unauthorized":
      return hasOnly(body, ["outcome", "version"])
        ? refused("unauthorized", "owner_mismatch")
        : VIOLATION;
    case "unavailable":
      return hasOnly(body, ["outcome", "source", "version"]) &&
        UNAVAILABLE_SOURCES.has(body.source)
        ? refused("unavailable", "provider_unavailable")
        : VIOLATION;
    case "observed":
      break;
    default:
      return VIOLATION;
  }
  if (!hasOnly(body, ["observed", "outcome", "policy", "record", "version"])) {
    return VIOLATION;
  }
  const record = parseRecord(body.record);
  const { observed, policy } = body;
  if (
    record === null ||
    !isRecord(observed) ||
    !hasOnly(observed, details ? [...OBSERVED_KEYS, "providerMetadata"] : OBSERVED_KEYS) ||
    !isRecord(observed.identity) ||
    !hasOnly(observed.identity, IDENTITY_KEYS) ||
    !isPolicy(policy, false)
  ) {
    return VIOLATION;
  }
  // The copy already has no base object. Update only these four own values;
  // creating an ordinary object here would reintroduce inherited metadata.
  if (details) {
    const metadata = observed.providerMetadata;
    if (!isProviderMetadata(metadata)) {
      return VIOLATION;
    }
    const effective = observed as Record<string, unknown>;
    for (const key of ["autoDestroyAtConfigured", "linkedSandbox", "volumes", "warmPool"]) {
      effective[key] = metadata[key];
    }
  }
  return {
    kind: "observed",
    value: { identity: observed.identity, observed, policy, record },
  };
}

/**
 * The answer's HTTP status first; only a 200 has a body worth reading. The
 * answer itself must be a plain object whose only keys are `status` and
 * `body`, checked without reading the body. The status is read once; the
 * body of a 200 is then copied as plain data, and any other body is never
 * touched (third read rv18b-f2bd3f93, finding 3).
 */
function parseInspection(received: unknown, binding: Binding, details: boolean): Inspection {
  if (
    typeof received !== "object" ||
    received === null ||
    Array.isArray(received)
  ) {
    return VIOLATION;
  }
  const base = Object.getPrototypeOf(received);
  if (
    (base !== PLAIN_OBJECT_BASE && base !== null) ||
    Object.getOwnPropertySymbols(received).length > 0
  ) {
    return VIOLATION;
  }
  const keys = Object.getOwnPropertyNames(received);
  if (
    !keys.every(
      (key) =>
        (key === "body" || key === "status") &&
        Object.getOwnPropertyDescriptor(received, key)?.enumerable === true
    )
  ) {
    return VIOLATION;
  }
  const status = integer(readOwn(received, "status")?.value);
  if (status === null) {
    return VIOLATION;
  }
  const refusal = HTTP_REFUSALS.get(status);
  if (refusal) {
    return refusal;
  }
  if (status !== 200) {
    return VIOLATION;
  }
  const body = plainCopy(readOwn(received, "body")?.value, 1, {
    left: PLAIN_VALUES_MAX,
  });
  return body === null ? VIOLATION : parseBody(body.value, binding, details);
}

// --- Evaluation -------------------------------------------------------------

function withinRange(
  value: number,
  range: Readonly<{ max: number; min: number }>
): boolean {
  return value >= range.min && value <= range.max;
}

function evaluateCompatibility(
  envelope: ObservedEnvelope,
  findings: Findings
): void {
  const { observed, policy } = envelope;
  const profile = SUPPORTED_PROFILE;
  const missing = (field: string) =>
    findings.add("incompatible", "metadata_missing", field);
  const fail = (code: ReasonCode, field: string) =>
    findings.add("incompatible", code, field);

  // The server-selected version, compared with the version Castles pins.
  if (policy.sdkVersion !== profile.sdk.version) {
    fail("sdk_generation_mismatch", "policy.sdkVersion");
  }

  if (typeof observed.state !== "string") {
    missing("state");
  }

  if (typeof observed.public !== "boolean") {
    missing("public");
  } else if (observed.public) {
    fail("public_exposure", "public");
  }

  if (typeof observed.networkBlockAll !== "boolean") {
    missing("networkBlockAll");
  }
  // Upstream withholds the raw lists, so Castles' own per-entry rules cannot
  // run (maintainer decision, coven-castles#2, 2026-11-20). What it checks:
  // the domain list equals the owner's configured policy, which upstream
  // compares exactly; the owner policy sets no network list and no outbound
  // proxy, so either one is drift. Block-all excuses neither. Each
  // comparison must be stated; an unstated one is missing metadata and also
  // keeps egress from being called unrestricted: it is unknown, not empty.
  let egressKnown = true;
  for (const field of [
    "domainAllowListConfigured",
    "domainAllowListMatchesPolicy",
    "networkAllowListConfigured",
    "outboundProxyConfigured",
  ] as const) {
    if (typeof observed[field] !== "boolean") {
      missing(field);
      egressKnown = false;
    }
  }
  if (observed.domainAllowListMatchesPolicy === false) {
    fail("egress_allow_list_unsafe", "domainAllowList");
    egressKnown = false;
  }
  if (observed.networkAllowListConfigured === true) {
    fail("egress_allow_list_unsafe", "networkAllowList");
    egressKnown = false;
  }
  if (observed.outboundProxyConfigured === true) {
    fail("egress_allow_list_unsafe", "outboundProxy");
    egressKnown = false;
  }
  if (
    egressKnown &&
    observed.networkBlockAll !== true &&
    observed.domainAllowListConfigured === false &&
    observed.networkAllowListConfigured === false
  ) {
    fail("egress_unrestricted", "egress");
  }

  const autoStop = integer(observed.autoStopInterval);
  if (autoStop === null) {
    missing("autoStopInterval");
  } else if (!withinRange(autoStop, profile.lifecycle.autoStopMinutes)) {
    fail("lifecycle_auto_stop", "autoStopInterval");
  }
  const autoArchive = integer(observed.autoArchiveInterval);
  if (autoArchive === null) {
    missing("autoArchiveInterval");
  } else if (!withinRange(autoArchive, profile.lifecycle.autoArchiveMinutes)) {
    fail("lifecycle_auto_archive", "autoArchiveInterval");
  }
  const autoDelete = integer(observed.autoDeleteInterval);
  if (autoDelete === null) {
    missing("autoDeleteInterval");
  } else if (autoDelete !== profile.lifecycle.autoDeleteInterval) {
    fail("lifecycle_auto_delete", "autoDeleteInterval");
  }
  const autoPause = integer(observed.autoPauseInterval);
  if (autoPause === null) {
    missing("autoPauseInterval");
  } else if (autoPause !== profile.lifecycle.autoPauseInterval) {
    fail("lifecycle_auto_pause", "autoPauseInterval");
  }
  // Legacy v1 keeps the accepted fold. In negotiated detail mode parsing
  // replaces these four fields with the validated nullable observations.
  // Null remains missing metadata; it is never coalesced to legacy absence.
  if (typeof observed.autoDestroyAtConfigured !== "boolean") {
    missing("autoDestroyAtConfigured");
  } else if (observed.autoDestroyAtConfigured) {
    fail("lifecycle_ttl", "autoDestroyAtConfigured");
  }

  if (typeof observed.snapshot !== "string") {
    missing("snapshot");
  } else if (observed.snapshot !== profile.image.qualifiedSnapshot) {
    fail("image_unqualified", "snapshot");
  }

  if (typeof observed.target !== "string") {
    missing("target");
  } else if (!(profile.targets as readonly string[]).includes(observed.target)) {
    fail("target_unsupported", "target");
  }

  const cpu = integer(observed.cpu);
  const memory = integer(observed.memoryGib);
  const disk = integer(observed.diskGib);
  if (cpu === null) {
    missing("cpu");
  }
  if (memory === null) {
    missing("memoryGib");
  }
  if (disk === null) {
    missing("diskGib");
  }
  if (cpu !== null && memory !== null && disk !== null) {
    const { caps, floor } = profile.resources;
    if (
      !withinRange(cpu, { max: caps.cpu, min: floor.cpu }) ||
      !withinRange(memory, { max: caps.memoryGiB, min: floor.memoryGiB }) ||
      !withinRange(disk, { max: caps.diskGiB, min: floor.diskGiB })
    ) {
      fail("resources_out_of_policy", "resources");
    }
  }
  const gpu = integer(observed.gpu);
  if (gpu === null) {
    missing("gpu");
  } else if (gpu !== 0) {
    fail("gpu_present", "gpu");
  }

  // Zero is "no volume". Absent or null is unknown; any other value is an
  // attachment, including one that is not a count.
  if (observed.volumes === undefined || observed.volumes === null) {
    missing("volumes");
  } else if (countOf(observed.volumes) !== 0) {
    fail("volumes_present", "volumes");
  }
  if (typeof observed.warmPool !== "boolean") {
    missing("warmPool");
  } else if (observed.warmPool) {
    fail("warm_pool_member", "warmPool");
  }
  if (typeof observed.linkedSandbox !== "boolean") {
    missing("linkedSandbox");
  } else if (observed.linkedSandbox) {
    fail("linked_sandbox_present", "linkedSandbox");
  }
  // Platform: maintainer decision (coven-castles#2, 2026-11-20). Upstream
  // reports none (coven-agents#323), so the operating system is source
  // policy implied by the qualified snapshot, whose base image is pinned.
  // The snapshot check above is what makes that inference safe: without the
  // qualified snapshot the result is never ready.
}

function evaluateState(envelope: ObservedEnvelope, findings: Findings): void {
  const { state } = envelope.observed;
  if (typeof state !== "string" || state === "started") {
    return;
  }
  if (state === "stopped" || state === "archived") {
    findings.add("stopped", "sandbox_stopped", "state");
  } else if (state === "destroyed") {
    findings.add("unavailable", "sandbox_destroyed", "state");
  } else {
    findings.add("unavailable", "lifecycle_not_settled", "state");
  }
}

function observe(envelope: ObservedEnvelope): ObservedSandbox {
  const { identity, observed, policy, record } = envelope;
  const { target } = SUPPORTED_PROFILE.resources;
  const ttl = bool(observed.autoDestroyAtConfigured);
  return {
    attachments: {
      linkedSandbox: bool(observed.linkedSandbox),
      volumes: observed.providerMetadata !== undefined
        ? typeof observed.volumes === "number" ? observed.volumes : null
        : echoedCount(observed.volumes),
      warmPool: bool(observed.warmPool),
    },
    binding: {
      attemptFence: FENCE_ECHO.get(record.fence) ?? UNRECOGNISED,
      generation: echoedInteger(record.generation),
      lifecycle: known(record.lifecycle, KNOWN.bindingLifecycle) ?? UNRECOGNISED,
    },
    exposure: {
      domainAllowListConfigured: bool(observed.domainAllowListConfigured),
      domainAllowListMatchesPolicy: bool(observed.domainAllowListMatchesPolicy),
      networkAllowListConfigured: bool(observed.networkAllowListConfigured),
      networkBlockAll: bool(observed.networkBlockAll),
      outboundProxyConfigured: bool(observed.outboundProxyConfigured),
      public: bool(observed.public),
    },
    identity: {
      configuration: known(identity.configuration, KNOWN.configuration),
      credentialBoundary: bool(identity.credentialBoundary),
      generationLabel: bool(identity.generationLabel),
      ownershipLabels: bool(identity.ownershipLabels),
    },
    image: { snapshot: known(observed.snapshot, KNOWN.snapshot) },
    lifecycle: {
      autoArchiveInterval: echoedInteger(observed.autoArchiveInterval),
      autoDeleteInterval: echoedInteger(observed.autoDeleteInterval),
      autoDestroyAt: ttl === null ? null : ttl ? "present" : "absent",
      autoPauseInterval: echoedInteger(observed.autoPauseInterval),
      autoStopInterval: echoedInteger(observed.autoStopInterval),
    },
    platform: { architecture: null, os: null },
    resources: {
      cpu: echoedInteger(observed.cpu),
      diskGiB: echoedInteger(observed.diskGib),
      gpu: echoedInteger(observed.gpu),
      matchesTarget:
        observed.cpu === target.cpu &&
        observed.memoryGib === target.memoryGiB &&
        observed.diskGib === target.diskGiB,
      memoryGiB: echoedInteger(observed.memoryGib),
    },
    sdk: { version: sdkVersion(policy.sdkVersion) },
    state: known(observed.state, KNOWN.state),
    target: known(observed.target, KNOWN.target),
  };
}

type Inspect = SandboxInspectionClient["inspectBoundSandbox"];

/**
 * Invokes a seam method with its client as the receiver, reading no
 * property of the method: `invokeSeam(method, client, request, options)`.
 * It is the built-in call operation, taken once from a function this module
 * owns and bound to that same operation. Writing `method.call(...)` would
 * read `call` from the method, so a method without the built-in one could
 * not be invoked, and a method carrying its own would be bypassed.
 *
 * Taken at module load, so it is whatever the built-in `call` and `bind`
 * of functions were then. "No property of the method is read" and "one
 * inspection is counted exactly when the method was invoked" hold in a
 * realm whose built-ins were intact when this module was imported.
 */
const builtInCall = seamOf.call as (
  this: unknown,
  ...args: unknown[]
) => unknown;
const invokeSeam = builtInCall.bind(builtInCall) as (
  method: Inspect,
  client: unknown,
  ...args: Parameters<Inspect>
) => ReturnType<Inspect>;

/**
 * The seam method of a usable client, bound to that client, or null when
 * there is none. A client is any value whose `inspectBoundSandbox` is
 * callable; `null`, `undefined` and everything else are no client. The
 * property is read once, here, so what was judged usable is what gets
 * invoked, and a read that throws means no client. Nothing else is read
 * from the client or from the method.
 */
function seamOf(client: unknown): Inspect | null {
  if (client === null || client === undefined) {
    return null;
  }
  try {
    const method: unknown = (client as Partial<SandboxInspectionClient>)
      .inspectBoundSandbox;
    if (typeof method !== "function") {
      return null;
    }
    const seam = method as Inspect;
    return (request, options) => invokeSeam(seam, client, request, options);
  } catch {
    return null;
  }
}

/**
 * The deadline for the one inspection call. Options that are not an object
 * (`null`, a primitive, a function) or that are an array are no options.
 *
 * One stated value is replaced: a number above the longest delay a timer
 * accepts, `Infinity` included. Node turns such a delay into 1 ms, so a
 * caller asking for a long wait would have every provider reported as
 * unavailable; it means the default and is never handed to a timer.
 *
 * Every other stated value is handed to the timer as given, as it always
 * was, and Node decides: 1 ms for a number below 1 or `NaN`, a conversion
 * for a value that is not a number (so a string or a boxed number above the
 * limit still becomes 1 ms), an exception for a bigint or a symbol, which
 * `inspectOnce` flattens to `provider_unavailable`. What such a value should
 * mean is an open question for the maintainer, not decided here; hence the
 * cast.
 */
function inspectionDeadline(options: unknown): number {
  const stated = isRecord(options) ? options.timeoutMs : undefined;
  if (stated === undefined || stated === null) {
    return DEFAULT_INSPECTION_TIMEOUT_MS;
  }
  return typeof stated === "number" && stated > MAX_INSPECTION_TIMEOUT_MS
    ? DEFAULT_INSPECTION_TIMEOUT_MS
    : (stated as number);
}

/** One bounded inspection call. Any failure is flattened; nothing is kept. */
async function inspectOnce(
  inspect: Inspect,
  binding: Binding,
  timeoutMs: number,
  details: boolean
): Promise<Inspection> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: unknown;
  try {
    response = await Promise.race([
      Promise.resolve().then(() =>
        inspect(
          {
            agentId: binding.agentId,
            expectedGeneration: binding.expectedGeneration,
            sandboxId: binding.sandboxId,
            ...(details ? { includeProviderMetadata: true as const } : {}),
          },
          { signal: controller.signal }
        )
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), timeoutMs);
      }),
    ]);
  } catch {
    // The original error can carry a provider URL, identifier, or credential.
    return {
      code: "provider_unavailable",
      kind: "refused",
      status: "unavailable",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  // Parsed outside the try: a response whose read throws rejects with the
  // caller's own error, as documented, rather than reading as a provider
  // failure. The deadline does not cover this parse; the copy's size bound
  // does.
  return parseInspection(response, binding, details);
}

export type PreflightOptions = Readonly<{ timeoutMs?: number; includeProviderMetadata?: true }>;

/**
 * The evidence class is a fact about the client, so it is derived here and
 * cannot be supplied by a caller. The upstream seam has landed, but no live
 * client exists at this head: one needs the owner credential and an
 * authorized live check. So nothing this library returns is
 * `live-provider`: no usable client means no inspection, and every usable
 * client, whoever built it and whatever properties it carries, is non-live.
 * The live client factory, when it is added to this module, becomes the only
 * source of `live-provider`.
 */
function evidenceOf(inspect: Inspect | null): PreflightEvidence {
  return inspect === null ? "none" : "fixture";
}

/**
 * Checks the one configured sandbox. Passing `null` for the client means no
 * seam is available: the binding is still validated, and the result names the
 * upstream blocker instead of guessing an endpoint.
 *
 * For plain values, the edges a caller can reach from plain JavaScript are
 * decided here, not left to an exception or to a timer:
 * - a client that is `undefined`, or any value without a callable
 *   `inspectBoundSandbox`, is the same as `null`: evidence `none`, no call
 *   counted, `upstream_seam_missing`. The property is read once, before the
 *   binding is validated, because the evidence class depends on it;
 * - `providerCalls.inspect` is 1 exactly when the seam method was invoked;
 * - an environment that is `null`, `undefined`, a primitive or a function
 *   configures nothing (`sandbox_id_missing`); options that are `null`, a
 *   primitive, a function or an array are no options. Any other object is
 *   read, whatever built it;
 * - a `timeoutMs` that is a number above 2,147,483,647 means the default
 *   deadline; every other stated value goes to the timer as given.
 *
 * Not handled: a property whose read throws. An accessor that throws on the
 * environment, the options or a response held in memory still rejects this
 * call with the caller's own error. Only the read of the client's
 * `inspectBoundSandbox` is caught.
 */
export async function runPreflight(
  environment: Readonly<Record<string, string | undefined>>,
  client: SandboxInspectionClient | null,
  options: PreflightOptions = {}
): Promise<PreflightResult> {
  const inspect = seamOf(client);
  const evidence = evidenceOf(inspect);
  const findings = new Findings();
  // Optional literal-true negotiation is strict even for untyped callers.
  // Other options retain their established timeout behavior.
  const detailOption = isRecord(options) ? readOwn(options, "includeProviderMetadata") : null;
  if (detailOption !== null && detailOption.value !== true && detailOption.value !== undefined) {
    findings.add("unavailable", "inspection_contract_violation");
    return result(findings, {}, evidence, 0, null);
  }
  const details = detailOption?.value === true;
  const parsed = parseBinding(environment);
  if (!parsed.ok) {
    findings.add(
      parsed.problem === "unknown_profile" ||
        parsed.problem === "profile_missing"
        ? "incompatible"
        : "unavailable",
      parsed.problem
    );
    return result(findings, parsed.partial, evidence, 0, null);
  }
  const { binding } = parsed;
  if (inspect === null) {
    findings.add("unavailable", "upstream_seam_missing");
    return result(findings, binding, evidence, 0, null);
  }

  const inspection = await inspectOnce(
    inspect,
    binding,
    inspectionDeadline(options),
    details
  );
  if (inspection.kind === "refused") {
    findings.add(inspection.status, inspection.code);
    return result(findings, binding, evidence, 1, null);
  }
  const envelope = inspection.value;

  // Identity first. The configured ID is the only acceptable target: a
  // different recorded sandbox is never adopted, whatever its name or labels
  // say, and nothing about it is disclosed. Upstream compares the returned
  // provider ID itself and answers `returned_id_mismatch`; it withholds that
  // ID, so Castles relies on that answer and on the echoed record.
  const { identity, policy, record } = envelope;
  let identityHeld = true;
  if (record.agentId !== binding.agentId) {
    // Defence in depth: the owning service decides ownership, but a response
    // about another agent's record must never be read as this binding's.
    findings.add("unauthorized", "owner_mismatch", "record.agentId");
    identityHeld = false;
  }
  if (record.sandboxId !== binding.sandboxId) {
    // Upstream's schema allows a null recorded ID on an observed answer.
    // Castles requires the configured ID, so null is a mismatch too.
    findings.add("unauthorized", "binding_mismatch", "record.sandboxId");
    identityHeld = false;
  }
  // Maintainer decision (coven-castles#2, 2026-11-20): upstream's own label and
  // configuration checks refuse with existing codes. A sandbox whose
  // ownership labels or configuration do not match is not this binding's.
  if (identity.ownershipLabels !== true) {
    findings.add("unauthorized", "owner_mismatch", "identity.ownershipLabels");
    identityHeld = false;
  }
  if (
    identity.configuration !== "current" &&
    identity.configuration !== "prior"
  ) {
    findings.add("unauthorized", "binding_mismatch", "identity.configuration");
    identityHeld = false;
  }
  if (!identityHeld) {
    return result(findings, binding, evidence, 1, null);
  }

  if (record.generation !== binding.expectedGeneration) {
    findings.add(
      "reconciliation-required",
      "generation_mismatch",
      "record.generation"
    );
  }
  if (identity.generationLabel !== true) {
    findings.add(
      "reconciliation-required",
      "generation_mismatch",
      "identity.generationLabel"
    );
  }
  if (record.lifecycle !== "ready") {
    findings.add(
      "reconciliation-required",
      "binding_lifecycle_pending",
      "record.lifecycle"
    );
  }
  if (record.fence !== "none") {
    findings.add("reconciliation-required", "attempt_fence_held", "record.fence");
  }
  // The marker is a compatibility gate only. It never grants ownership.
  // Upstream withholds the raw labels and reports its own check, so both its
  // check and its policy's version must agree with the profile.
  if (identity.credentialBoundary !== true) {
    findings.add(
      "reconciliation-required",
      "credential_boundary_unverified",
      "identity.credentialBoundary"
    );
  }
  if (
    policy.credentialBoundaryVersion !==
    SUPPORTED_PROFILE.credentialBoundaryVersion
  ) {
    findings.add(
      "reconciliation-required",
      "credential_boundary_unverified",
      "policy.credentialBoundaryVersion"
    );
  }

  evaluateCompatibility(envelope, findings);
  evaluateState(envelope, findings);
  return result(findings, binding, evidence, 1, observe(envelope));
}

/**
 * The only result that may be treated as readiness. A fixture replay that
 * reports `ready` is not: consumers must gate on this, never on `status`
 * alone. It reads two fields and so also works on a parsed JSON result; it
 * cannot detect a result object that a caller built or altered by hand.
 */
export function isLiveReady(value: PreflightResult): boolean {
  return value.status === "ready" && value.evidence === "live-provider";
}

// --- Rendering --------------------------------------------------------------

/**
 * Bounded by construction: every string is a literal, an alias, a member of
 * a fixed set, or a strict three-part version; every observed number is a
 * count from 0 to 1024 or an integer inside `ECHOED_INTEGER`. The volume
 * count uses the detail contract bound or the legacy `echoedCount` bound.
 */
export function renderJson(value: PreflightResult): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const EVIDENCE_LINE: Readonly<Record<PreflightEvidence, string>> = {
  fixture: "FIXTURE (synthetic input; not provider evidence)",
  "live-provider": "live provider read through the owning service",
  none: "none (no inspection was made)",
};

export function renderHuman(value: PreflightResult): string {
  const lines = [
    `castles preflight - status: ${value.status}`,
    `evidence: ${EVIDENCE_LINE[value.evidence]}`,
    `target: sandbox ${value.target.sandboxAlias ?? "(not configured)"}, owner ${value.target.ownerAlias ?? "(not configured)"}, generation ${value.target.expectedGeneration ?? "(not configured)"}, profile ${value.target.profile ?? "(not configured)"}`,
  ];
  if (value.reasons.length > 0) {
    lines.push("reasons:");
    for (const reason of value.reasons) {
      lines.push(
        `  - ${reason.code}${reason.field ? ` (${reason.field})` : ""}`
      );
    }
  }
  const observed = value.observed;
  if (observed) {
    const { exposure, identity } = observed;
    lines.push(
      "observed (as reported through the seam):",
      `  state ${observed.state ?? "?"}; ${observed.resources.cpu ?? "?"} vCPU / ${observed.resources.memoryGiB ?? "?"} GiB RAM / ${observed.resources.diskGiB ?? "?"} GiB disk; snapshot ${observed.image.snapshot ?? "?"}; platform not reported (policy: ${value.sourcePolicy.platform.os} from the qualified snapshot); server sdk ${observed.sdk.version ?? "?"}`,
      `  public ${exposure.public ?? "?"}; domain allow list configured ${exposure.domainAllowListConfigured ?? "?"}, matches policy ${exposure.domainAllowListMatchesPolicy ?? "?"}; network allow list ${exposure.networkAllowListConfigured ?? "?"}; outbound proxy ${exposure.outboundProxyConfigured ?? "?"}; block-all ${exposure.networkBlockAll ?? "?"}`,
      `  auto-stop ${observed.lifecycle.autoStopInterval ?? "?"} min; auto-archive ${observed.lifecycle.autoArchiveInterval ?? "?"} min; auto-delete ${observed.lifecycle.autoDeleteInterval ?? "?"}; ttl ${observed.lifecycle.autoDestroyAt ?? "?"}; volumes ${observed.attachments.volumes ?? "?"}; warm pool ${observed.attachments.warmPool ?? "?"}; linked sandbox ${observed.attachments.linkedSandbox ?? "?"}`,
      `  binding generation ${observed.binding.generation ?? "?"}, lifecycle ${observed.binding.lifecycle}, attempt fence ${observed.binding.attemptFence}`,
      `  identity configuration ${identity.configuration ?? "?"}; credential boundary ${identity.credentialBoundary ?? "?"}; ownership labels ${identity.ownershipLabels ?? "?"}; generation label ${identity.generationLabel ?? "?"}`
    );
  } else {
    lines.push("observed: nothing disclosed");
  }
  const { resources, sdk } = value.sourcePolicy;
  lines.push(
    "source policy (pinned; not an observation):",
    `  profile ${value.sourcePolicy.profile}; target ${resources.target.cpu} vCPU / ${resources.target.memoryGiB} GiB / ${resources.target.diskGiB} GiB; ${sdk.package}@${sdk.version}; ${value.sourcePolicy.pins.length} source pins (see --json)`,
    `provider calls: inspect ${value.providerCalls.inspect}; mutations 0 (the client seam has none)`,
    `upstream seam: ${value.upstream.seam} - ${value.upstream.issue}`
  );
  return `${lines.join("\n")}\n`;
}

// --- Labelled fixtures ------------------------------------------------------

export type FixtureCase = Readonly<{
  case: string;
  env: Readonly<Record<string, string>>;
  expect: Readonly<{
    inspectCalls: number;
    reasons: readonly string[];
    status: PreflightStatus;
  }>;
  fixture: typeof FIXTURE_LABEL;
  inspection: unknown;
}>;

/**
 * Loads one synthetic case. A file without the exact label is refused, so a
 * captured provider response cannot be passed off as a fixture or vice versa.
 */
export function loadFixtureCase(path: string): FixtureCase {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.fixture !== FIXTURE_LABEL) {
    throw new Error("Refusing a fixture file without the synthetic label.");
  }
  if (!isRecord(parsed.env) || !isRecord(parsed.expect)) {
    throw new Error("Synthetic fixture is missing its env or expect block.");
  }
  const env: Record<string, string> = {};
  for (const key of BINDING_ENVIRONMENT_KEYS) {
    const value = parsed.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return {
    case: typeof parsed.case === "string" ? parsed.case : "unnamed",
    env,
    expect: parsed.expect as FixtureCase["expect"],
    fixture: FIXTURE_LABEL,
    inspection: parsed.inspection,
  };
}

/** A client that replays one synthetic case. Reaches no provider. */
export function createFixtureInspectionClient(
  fixture: FixtureCase
): SandboxInspectionClient {
  return {
    inspectBoundSandbox: () => Promise.resolve(fixture.inspection),
  };
}
