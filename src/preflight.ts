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
 */
export const INSPECTION_CONTRACT = "castles.fixture.sandbox-inspection.v0";
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
  /** Provider metadata as reported through the seam. Null unless identity held. */
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

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** A short, single-line, allowlisted token, or nothing. */
function token(value: unknown): string | null {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function allowListEntries(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return value.split(",").filter((entry) => entry.trim() !== "").length;
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
  if (
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
  if (token(platform.architecture) === null) {
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
      attemptFence: token(binding.attemptFence) ?? "unrecognised",
      generation: binding.generation,
      lifecycle: token(binding.lifecycle) ?? "unrecognised",
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
    image: { snapshot: token(sandbox.snapshot) },
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
      architecture: token(platform.architecture),
      os: token(platform.os),
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
    sdk: { version: token(sdk.version) },
    state: token(sandbox.state),
    target: token(sandbox.target),
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

export type PreflightOptions = Readonly<{
  evidence: PreflightEvidence;
  timeoutMs?: number;
}>;

/**
 * Checks the one configured sandbox. Passing `null` for the client means no
 * seam is available: the binding is still validated, and the result names the
 * upstream blocker instead of guessing an endpoint.
 */
export async function runPreflight(
  environment: Readonly<Record<string, string | undefined>>,
  client: SandboxInspectionClient | null,
  options: PreflightOptions
): Promise<PreflightResult> {
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
    return result(findings, parsed.partial, options.evidence, 0, null);
  }
  const { binding } = parsed;
  if (client === null) {
    findings.add("unavailable", "upstream_seam_missing");
    return result(findings, binding, options.evidence, 0, null);
  }

  const inspection = await inspectOnce(
    client,
    binding,
    options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS
  );
  if (inspection.kind === "refused") {
    findings.add(inspection.status, inspection.code);
    return result(findings, binding, options.evidence, 1, null);
  }
  const envelope = inspection.value;

  // Identity first. The configured ID is the only acceptable target: a
  // different recorded or returned sandbox is never adopted, whatever its
  // name or labels say, and nothing about it is disclosed.
  let identityHeld = true;
  if (envelope.binding.sandboxId !== binding.sandboxId) {
    findings.add("unauthorized", "binding_mismatch", "binding.sandboxId");
    identityHeld = false;
  }
  if (envelope.sandbox.id !== binding.sandboxId) {
    findings.add("reconciliation-required", "returned_id_mismatch", "sandbox.id");
    identityHeld = false;
  }
  if (!identityHeld) {
    return result(findings, binding, options.evidence, 1, null);
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
  return result(findings, binding, options.evidence, 1, observe(envelope));
}

// --- Rendering --------------------------------------------------------------

/** Bounded by construction: every string is a literal, alias, or safe token. */
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
