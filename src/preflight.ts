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
} from "./profile";

export const FIXTURE_LABEL =
  "SYNTHETIC FIXTURE - invented values, not provider evidence";
/**
 * The inspection result Castles needs from the seam requested upstream. A
 * proposal carried by fixtures only; it becomes a pin when the seam lands.
 * v1 adds `binding.agentId`: the seam echoes the agent record it read, so a
 * response about a different record is detectable here as well as upstream.
 */
export const INSPECTION_CONTRACT = "castles.fixture.sandbox-inspection.v1";
export const PREFLIGHT_JSON_MAX_BYTES = 16_384;
export const DEFAULT_INSPECTION_TIMEOUT_MS = 30_000;
const MAX_REASONS = 16;

// --- The constrained client seam -------------------------------------------

export type InspectionRequest = Readonly<{
  agentId: string;
  expectedGeneration: number;
  sandboxId: string;
}>;

/**
 * The whole provider surface available to Castles. An implementation must be
 * backed by the existing Coven Agents lifecycle owner, which authenticates
 * the caller, derives the tenant itself, reads its own canonical record, and
 * performs one exact-ID provider read. The response is untrusted input here.
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
  | "platform_unsupported"
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
    linkedSandbox: boolean;
    volumes: number | null;
    warmPool: boolean;
  }>;
  binding: Readonly<{
    attemptFence: string;
    generation: number;
    lifecycle: string;
  }>;
  exposure: Readonly<{
    egressAllowListEntries: number;
    networkBlockAll: boolean | null;
    public: boolean | null;
  }>;
  image: Readonly<{ snapshot: string | null }>;
  lifecycle: Readonly<{
    autoArchiveInterval: number | null;
    autoDeleteInterval: number | null;
    autoDestroyAt: "absent" | "present";
    autoPauseInterval: number | null;
    autoStopInterval: number | null;
  }>;
  platform: Readonly<{ architecture: string | null; os: string | null }>;
  resources: Readonly<{
    cpu: number | null;
    diskGiB: number | null;
    gpu: number | null;
    matchesTarget: boolean;
    memoryGiB: number | null;
  }>;
  sdk: Readonly<{ version: string | null }>;
  state: string | null;
  target: string | null;
}>;

export type PreflightResult = Readonly<{
  evidence: PreflightEvidence;
  /**
   * Provider metadata as reported through the seam. Null whenever the seam
   * refused, or the echoed agent record, recorded sandbox ID or returned
   * sandbox ID differs from the binding. A stale generation alone does not
   * withhold it: by then the owning service has authenticated the caller for
   * this exact record and sandbox, and the operator needs the detail to
   * reconcile.
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
 * `major.minor.patch` SDK version, `"unrecognised"` for any other string, or
 * null for an absent or non-string value. A field set to a private ID, a
 * credential or any other free text therefore cannot reach human or JSON
 * output.
 *
 * Sources: sandbox states are the `SandboxState` values of the public
 * `@daytona/api-client` 0.220.0 package; binding lifecycles are
 * `RunnerSandboxLifecycle` in the pinned coven-agents `lib/runner/types.ts`.
 * Attempt-fence values and the architecture list are Castles' own: the
 * first belongs to the proposed inspection shape, and no architecture is
 * pinned upstream.
 */
const UNRECOGNISED = "unrecognised";
const KNOWN = Object.freeze({
  architecture: ["x86_64", "amd64", "aarch64", "arm64"],
  attemptFence: ["clear", "cleanup_required"],
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
  os: [SUPPORTED_PROFILE.platform.os],
  snapshot: [SUPPORTED_PROFILE.image.qualifiedSnapshot],
  state: [
    "creating",
    "restoring",
    "destroyed",
    "destroying",
    "started",
    "stopped",
    "starting",
    "stopping",
    "error",
    "build_failed",
    "pending_build",
    "building_snapshot",
    "unknown",
    "pulling_snapshot",
    "archived",
    "archiving",
    "resizing",
    "snapshotting",
    "forking",
    "pausing",
    "paused",
    "resuming",
  ],
  target: SUPPORTED_PROFILE.targets,
} as const satisfies Record<string, readonly string[]>);

/** Three plain decimal components and nothing else. */
const SDK_VERSION =
  /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/;

function isKnown(value: unknown, set: readonly string[]): value is string {
  return typeof value === "string" && set.includes(value);
}

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

function allowListItems(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function allowListEntries(value: unknown): number {
  return allowListItems(value).length;
}

/**
 * One allowed domain: a plain multi-label name and nothing else. No wildcard
 * in any position (`*`, `*.tld`, `*.example.test`), no scheme, port or path.
 *
 * ASCII only. The character classes spell out both cases and the pattern has
 * no `i` or `u` flag, so no Unicode case folding applies: a look-alike such
 * as U+017F or U+212A is refused rather than read as a letter. The final
 * label must start with a letter, which refuses every IP literal
 * (`127.0.0.1`, `10.1`, `1.0x7f`): an address belongs in the network list,
 * where its range is examined.
 *
 * This is deliberately stricter than the owning service, whose
 * `daytonaDomainAllowList` (coven-agents `lib/runner/daytona/config.ts` at
 * the pinned revision) also accepts a single leading `*.` label. A sandbox
 * configured with such an entry is reported incompatible here.
 */
const DOMAIN_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const FINAL_DOMAIN_LABEL = "[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const ALLOWED_DOMAIN = new RegExp(
  `^(?:${DOMAIN_LABEL}\\.)+${FINAL_DOMAIN_LABEL}$`
);
const IPV4_CIDR =
  /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\/([0-9]{1,2})$/;
/** Castles decisions with no upstream pin; see `SUPPORTED_PROFILE.network`. */
const NETWORK_ALLOW_LIST = SUPPORTED_PROFILE.network.networkAllowList;

function isAllowedDomain(entry: string): boolean {
  return entry.length <= 253 && ALLOWED_DOMAIN.test(entry);
}

/**
 * A bounded IPv4 range: canonical octets and a prefix from /8 to /32. An
 * any-address range (`0.0.0.0/0`), a range wider than /8, a bare address and
 * every IPv6 form are refused: no IPv6 egress policy is pinned for this
 * profile, so an IPv6 entry is unrecognised rather than assumed safe.
 */
function isBoundedIpv4Range(entry: string): boolean {
  const match = IPV4_CIDR.exec(entry);
  if (!match) {
    return false;
  }
  const parts = match.slice(1);
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
    return false;
  }
  const [a, b, c, d, prefix] = parts.map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    [a, b, c, d].every((octet) => octet <= 255) &&
    prefix >= NETWORK_ALLOW_LIST.minIpv4Prefix &&
    prefix <= 32
  );
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

// --- Evaluation -------------------------------------------------------------

type ObservedEnvelope = Readonly<{
  binding: Readonly<{
    agentId: string;
    attemptFence: string;
    generation: number;
    lifecycle: string;
    sandboxId: string;
  }>;
  platform: UnknownRecord;
  sandbox: UnknownRecord & Readonly<{ id: string }>;
  sdk: UnknownRecord;
}>;

type Inspection =
  | Readonly<{ kind: "observed"; value: ObservedEnvelope }>
  | Readonly<{ code: ReasonCode; kind: "refused"; status: PreflightStatus }>;

const VIOLATION: Inspection = {
  code: "inspection_contract_violation",
  kind: "refused",
  status: "unavailable",
};

function parseInspection(response: unknown): Inspection {
  if (!isRecord(response) || response.contract !== INSPECTION_CONTRACT) {
    return VIOLATION;
  }
  switch (response.outcome) {
    case "not_found":
      return { code: "sandbox_not_found", kind: "refused", status: "unavailable" };
    case "ambiguous":
      return {
        code: "ambiguous_lookup",
        kind: "refused",
        status: "reconciliation-required",
      };
    case "unavailable":
      return {
        code: "provider_unavailable",
        kind: "refused",
        status: "unavailable",
      };
    case "unauthorized":
      return {
        code:
          response.reason === "owner_mismatch"
            ? "owner_mismatch"
            : "unauthenticated",
        kind: "refused",
        status: "unauthorized",
      };
    case "observed":
      break;
    default:
      return VIOLATION;
  }
  const { binding, sandbox, sdk } = response;
  if (
    !isRecord(binding) ||
    !isRecord(sandbox) ||
    !isRecord(sdk) ||
    typeof binding.agentId !== "string" ||
    typeof binding.sandboxId !== "string" ||
    typeof binding.lifecycle !== "string" ||
    typeof binding.attemptFence !== "string" ||
    integer(binding.generation) === null ||
    typeof sandbox.id !== "string"
  ) {
    return VIOLATION;
  }
  return {
    kind: "observed",
    value: {
      binding: binding as ObservedEnvelope["binding"],
      platform: isRecord(response.platform) ? response.platform : {},
      sandbox: sandbox as ObservedEnvelope["sandbox"],
      sdk,
    },
  };
}

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
  const { platform, sandbox, sdk } = envelope;
  const policy = SUPPORTED_PROFILE;
  const missing = (field: string) =>
    findings.add("incompatible", "metadata_missing", field);
  const fail = (code: ReasonCode, field: string) =>
    findings.add("incompatible", code, field);

  if (
    sdk.package !== policy.sdk.package ||
    sdk.version !== policy.sdk.version
  ) {
    fail("sdk_generation_mismatch", "sdk");
  }

  if (typeof sandbox.state !== "string") {
    missing("state");
  }

  if (typeof sandbox.public !== "boolean") {
    missing("public");
  } else if (sandbox.public) {
    fail("public_exposure", "public");
  }

  if (typeof sandbox.networkBlockAll !== "boolean") {
    missing("networkBlockAll");
  }
  // An allow list only restricts egress if every entry does AND the list as
  // a whole does. One wildcard or any-address entry opens the list; so does
  // a network list split into many ranges, which is why its length is
  // bounded. Block-all or a second, safe list does not excuse an unsafe one.
  // The domain rule is stricter than the owning service; the network-list
  // and block-all rules are Castles decisions with no upstream pin.
  let allowListsUsable = true;
  for (const [field, accepts, maxEntries] of [
    ["domainAllowList", isAllowedDomain, Number.POSITIVE_INFINITY],
    ["networkAllowList", isBoundedIpv4Range, NETWORK_ALLOW_LIST.maxEntries],
  ] as const) {
    const value = sandbox[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      missing(field);
      allowListsUsable = false;
    } else if (
      allowListItems(value).length > maxEntries ||
      !allowListItems(value).every(accepts)
    ) {
      fail("egress_allow_list_unsafe", field);
      allowListsUsable = false;
    }
  }
  if (
    allowListsUsable &&
    sandbox.networkBlockAll !== true &&
    allowListEntries(sandbox.domainAllowList) === 0 &&
    allowListEntries(sandbox.networkAllowList) === 0
  ) {
    fail("egress_unrestricted", "egress");
  }

  const autoStop = integer(sandbox.autoStopInterval);
  if (autoStop === null) {
    missing("autoStopInterval");
  } else if (!withinRange(autoStop, policy.lifecycle.autoStopMinutes)) {
    fail("lifecycle_auto_stop", "autoStopInterval");
  }
  const autoArchive = integer(sandbox.autoArchiveInterval);
  if (autoArchive === null) {
    missing("autoArchiveInterval");
  } else if (!withinRange(autoArchive, policy.lifecycle.autoArchiveMinutes)) {
    fail("lifecycle_auto_archive", "autoArchiveInterval");
  }
  const autoDelete = integer(sandbox.autoDeleteInterval);
  if (autoDelete === null) {
    missing("autoDeleteInterval");
  } else if (autoDelete !== policy.lifecycle.autoDeleteInterval) {
    fail("lifecycle_auto_delete", "autoDeleteInterval");
  }
  const autoPause = integer(sandbox.autoPauseInterval);
  if (autoPause === null) {
    missing("autoPauseInterval");
  } else if (autoPause !== policy.lifecycle.autoPauseInterval) {
    fail("lifecycle_auto_pause", "autoPauseInterval");
  }
  // Stated decision: `autoDestroyAt`, `volumes`, `warmPoolId` and
  // `linkedSandboxId` are optional in the provider model, and the owning
  // service's drift inventory reads an absent key as "not set" (pinned
  // resource-inventory.ts). An absent or null key is therefore not missing
  // metadata; any present value fails.
  if (sandbox.autoDestroyAt !== undefined && sandbox.autoDestroyAt !== null) {
    fail("lifecycle_ttl", "autoDestroyAt");
  }

  if (typeof sandbox.snapshot !== "string") {
    missing("snapshot");
  } else if (sandbox.snapshot !== policy.image.qualifiedSnapshot) {
    fail("image_unqualified", "snapshot");
  }

  if (typeof sandbox.target !== "string") {
    missing("target");
  } else if (!(policy.targets as readonly string[]).includes(sandbox.target)) {
    fail("target_unsupported", "target");
  }

  const cpu = integer(sandbox.cpu);
  const memory = integer(sandbox.memory);
  const disk = integer(sandbox.disk);
  if (cpu === null) {
    missing("cpu");
  }
  if (memory === null) {
    missing("memory");
  }
  if (disk === null) {
    missing("disk");
  }
  if (cpu !== null && memory !== null && disk !== null) {
    const { caps, floor } = policy.resources;
    if (
      !withinRange(cpu, { max: caps.cpu, min: floor.cpu }) ||
      !withinRange(memory, { max: caps.memoryGiB, min: floor.memoryGiB }) ||
      !withinRange(disk, { max: caps.diskGiB, min: floor.diskGiB })
    ) {
      fail("resources_out_of_policy", "resources");
    }
  }
  const gpu = integer(sandbox.gpu);
  if (gpu === null) {
    missing("gpu");
  } else if (gpu !== 0) {
    fail("gpu_present", "gpu");
  }

  if (sandbox.volumes !== undefined && sandbox.volumes !== null) {
    if (!Array.isArray(sandbox.volumes) || sandbox.volumes.length > 0) {
      fail("volumes_present", "volumes");
    }
  }
  if (sandbox.warmPoolId !== undefined && sandbox.warmPoolId !== null) {
    fail("warm_pool_member", "warmPoolId");
  }
  if (
    sandbox.linkedSandboxId !== undefined &&
    sandbox.linkedSandboxId !== null
  ) {
    fail("linked_sandbox_present", "linkedSandboxId");
  }

  if (typeof platform.os !== "string") {
    missing("platform.os");
  } else if (platform.os !== policy.platform.os) {
    fail("platform_unsupported", "platform.os");
  }
  // No architecture is pinned, so none is required; but it must be stated,
  // and stated as a value Castles knows. Anything else reads as not stated.
  if (!isKnown(platform.architecture, KNOWN.architecture)) {
    missing("platform.architecture");
  }
}

function evaluateState(envelope: ObservedEnvelope, findings: Findings): void {
  const { state } = envelope.sandbox;
  if (typeof state !== "string" || state === "started") {
    return;
  }
  if (state === "stopped" || state === "archived") {
    findings.add("stopped", "sandbox_stopped", "state");
  } else if (state === "destroyed" || state === "destroying") {
    findings.add("unavailable", "sandbox_destroyed", "state");
  } else {
    findings.add("unavailable", "lifecycle_not_settled", "state");
  }
}

function observe(envelope: ObservedEnvelope): ObservedSandbox {
  const { binding, platform, sandbox, sdk } = envelope;
  const cpu = integer(sandbox.cpu);
  const memoryGiB = integer(sandbox.memory);
  const diskGiB = integer(sandbox.disk);
  const { target } = SUPPORTED_PROFILE.resources;
  return {
    attachments: {
      linkedSandbox:
        sandbox.linkedSandboxId !== undefined &&
        sandbox.linkedSandboxId !== null,
      volumes: Array.isArray(sandbox.volumes)
        ? Math.min(sandbox.volumes.length, 999)
        : sandbox.volumes === undefined
          ? 0
          : null,
      warmPool: sandbox.warmPoolId !== undefined && sandbox.warmPoolId !== null,
    },
    binding: {
      attemptFence: known(binding.attemptFence, KNOWN.attemptFence) ?? UNRECOGNISED,
      generation: binding.generation,
      lifecycle: known(binding.lifecycle, KNOWN.bindingLifecycle) ?? UNRECOGNISED,
    },
    exposure: {
      egressAllowListEntries: Math.min(
        allowListEntries(sandbox.domainAllowList) +
          allowListEntries(sandbox.networkAllowList),
        999
      ),
      networkBlockAll:
        typeof sandbox.networkBlockAll === "boolean"
          ? sandbox.networkBlockAll
          : null,
      public: typeof sandbox.public === "boolean" ? sandbox.public : null,
    },
    image: { snapshot: known(sandbox.snapshot, KNOWN.snapshot) },
    lifecycle: {
      autoArchiveInterval: integer(sandbox.autoArchiveInterval),
      autoDeleteInterval: integer(sandbox.autoDeleteInterval),
      autoDestroyAt:
        sandbox.autoDestroyAt === undefined || sandbox.autoDestroyAt === null
          ? "absent"
          : "present",
      autoPauseInterval: integer(sandbox.autoPauseInterval),
      autoStopInterval: integer(sandbox.autoStopInterval),
    },
    platform: {
      architecture: known(platform.architecture, KNOWN.architecture),
      os: known(platform.os, KNOWN.os),
    },
    resources: {
      cpu,
      diskGiB,
      gpu: integer(sandbox.gpu),
      matchesTarget:
        cpu === target.cpu &&
        memoryGiB === target.memoryGiB &&
        diskGiB === target.diskGiB,
      memoryGiB,
    },
    sdk: { version: sdkVersion(sdk.version) },
    state: known(sandbox.state, KNOWN.state),
    target: known(sandbox.target, KNOWN.target),
  };
}

/** One bounded inspection call. Any failure is flattened; nothing is kept. */
async function inspectOnce(
  client: SandboxInspectionClient,
  binding: Binding,
  timeoutMs: number
): Promise<Inspection> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() =>
        client.inspectBoundSandbox(
          {
            agentId: binding.agentId,
            expectedGeneration: binding.expectedGeneration,
            sandboxId: binding.sandboxId,
          },
          { signal: controller.signal }
        )
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), timeoutMs);
      }),
    ]);
    return parseInspection(response);
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
}

export type PreflightOptions = Readonly<{ timeoutMs?: number }>;

/**
 * The evidence class is a fact about the client, so it is derived here and
 * cannot be supplied by a caller. No live client exists at this head (the
 * upstream seam is missing), so nothing this library returns is
 * `live-provider`: no client means no inspection, and every client object,
 * whoever built it and whatever properties it carries, is non-live. When the
 * seam lands, the live client factory added to this module becomes the only
 * source of `live-provider`.
 */
function evidenceOf(client: SandboxInspectionClient | null): PreflightEvidence {
  return client === null ? "none" : "fixture";
}

/**
 * Checks the one configured sandbox. Passing `null` for the client means no
 * seam is available: the binding is still validated, and the result names the
 * upstream blocker instead of guessing an endpoint.
 */
export async function runPreflight(
  environment: Readonly<Record<string, string | undefined>>,
  client: SandboxInspectionClient | null,
  options: PreflightOptions = {}
): Promise<PreflightResult> {
  const evidence = evidenceOf(client);
  const findings = new Findings();
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
  if (client === null) {
    findings.add("unavailable", "upstream_seam_missing");
    return result(findings, binding, evidence, 0, null);
  }

  const inspection = await inspectOnce(
    client,
    binding,
    options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  );
  if (inspection.kind === "refused") {
    findings.add(inspection.status, inspection.code);
    return result(findings, binding, evidence, 1, null);
  }
  const envelope = inspection.value;

  // Identity first. The configured ID is the only acceptable target: a
  // different recorded or returned sandbox is never adopted, whatever its
  // name or labels say, and nothing about it is disclosed.
  let identityHeld = true;
  if (envelope.binding.agentId !== binding.agentId) {
    // Defence in depth: the owning service decides ownership, but a response
    // about another agent's record must never be read as this binding's.
    findings.add("unauthorized", "owner_mismatch", "binding.agentId");
    identityHeld = false;
  }
  if (envelope.binding.sandboxId !== binding.sandboxId) {
    findings.add("unauthorized", "binding_mismatch", "binding.sandboxId");
    identityHeld = false;
  }
  if (envelope.sandbox.id !== binding.sandboxId) {
    findings.add("reconciliation-required", "returned_id_mismatch", "sandbox.id");
    identityHeld = false;
  }
  if (!identityHeld) {
    return result(findings, binding, evidence, 1, null);
  }

  if (envelope.binding.generation !== binding.expectedGeneration) {
    findings.add(
      "reconciliation-required",
      "generation_mismatch",
      "binding.generation"
    );
  }
  if (envelope.binding.lifecycle !== "ready") {
    findings.add(
      "reconciliation-required",
      "binding_lifecycle_pending",
      "binding.lifecycle"
    );
  }
  if (envelope.binding.attemptFence !== "clear") {
    findings.add(
      "reconciliation-required",
      "attempt_fence_held",
      "binding.attemptFence"
    );
  }
  const labels = envelope.sandbox.labels;
  if (
    !isRecord(labels) ||
    labels.credentialBoundaryVersion !==
      SUPPORTED_PROFILE.credentialBoundaryVersion
  ) {
    // A marker is a compatibility gate only. It never grants ownership.
    findings.add(
      "reconciliation-required",
      "credential_boundary_unverified",
      "labels.credentialBoundaryVersion"
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
 * a fixed set, or a strict three-part version.
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
    lines.push(
      "observed (as reported through the seam):",
      `  state ${observed.state ?? "?"}; ${observed.resources.cpu ?? "?"} vCPU / ${observed.resources.memoryGiB ?? "?"} GiB RAM / ${observed.resources.diskGiB ?? "?"} GiB disk; snapshot ${observed.image.snapshot ?? "?"}; ${observed.platform.os ?? "?"}/${observed.platform.architecture ?? "?"}; sdk ${observed.sdk.version ?? "?"}`,
      `  public ${observed.exposure.public ?? "?"}; egress allow-list entries ${observed.exposure.egressAllowListEntries}; auto-stop ${observed.lifecycle.autoStopInterval ?? "?"} min; auto-archive ${observed.lifecycle.autoArchiveInterval ?? "?"} min; auto-delete ${observed.lifecycle.autoDeleteInterval ?? "?"}; ttl ${observed.lifecycle.autoDestroyAt}`,
      `  binding generation ${observed.binding.generation}, lifecycle ${observed.binding.lifecycle}, attempt fence ${observed.binding.attemptFence}`
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
