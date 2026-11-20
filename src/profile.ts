/**
 * Source policy for the one supported sandbox profile, and the operator's
 * binding configuration.
 *
 * Everything in this module is *policy read from pinned source*. It is not an
 * observation of any sandbox and not an attestation of any deployment.
 */

const UPSTREAM_REPOSITORY = "OpenCoven/coven-agents";
const UPSTREAM_SHA = "0696af127207fb82cce734cd8c4ffa437d6f3502";

const pin = (path: string) => `${UPSTREAM_REPOSITORY}@${UPSTREAM_SHA}:${path}`;

/** Consumed contracts, each as repo@sha:path. Inspected read-only. */
export const SOURCE_PINS = Object.freeze([
  {
    covers: "toolchain (pnpm 10.32.1, tsx, TypeScript) and @daytona/sdk 0.231.1",
    pin: pin("package.json"),
  },
  {
    covers: "resolved @daytona/sdk 0.231.1 and its API clients",
    pin: pin("pnpm-lock.yaml"),
  },
  {
    covers: "the tsx --test and tsc --noEmit scripts",
    pin: pin("packages/agent-contracts/package.json"),
  },
  {
    covers: "resource defaults (2 vCPU / 4 GiB / 10 GiB) and caps",
    pin: pin("lib/runner/daytona/resource-policy.ts"),
  },
  {
    covers: "auto-stop and auto-archive bounds; TTL 0; auto-delete -1",
    pin: pin("lib/runner/daytona/config.ts"),
  },
  {
    covers:
      "create parameters (private, non-ephemeral), credential-boundary marker, lifecycle mutations, guarded-bind verification (a read)",
    pin: pin("lib/runner/daytona/sandbox.ts"),
  },
  {
    covers: "observed sandbox field set used for drift (inventory item)",
    pin: pin("lib/runner/daytona/resource-inventory.ts"),
  },
  {
    covers: "versioned snapshot naming",
    pin: pin("lib/runner/daytona/snapshot-name.ts"),
  },
  {
    covers:
      "snapshot image base (Linux); snapshot creation (outside the listed mutations)",
    pin: pin("lib/runner/daytona/image.ts"),
  },
  {
    covers: "persistent resource lifecycle contract and sandbox lifecycle states",
    pin: pin("lib/runner/resource-lifecycle.ts"),
  },
  {
    covers: "canonical agent record: sandbox ID, generation, lifecycle",
    pin: pin("lib/runner/types.ts"),
  },
  {
    covers: "resize owner",
    pin: pin("lib/runner/daytona/resource-repair.ts"),
  },
  {
    covers: "recovery delete owner",
    pin: pin("lib/runner/daytona/resource-recovery.ts"),
  },
  {
    covers: "diagnostic sandbox create and delete owner",
    pin: pin("lib/runner/diagnostics.ts"),
  },
  {
    covers: "command execution inside a sandbox (outside the listed mutations)",
    pin: pin("lib/runner/daytona/process.ts"),
  },
  {
    covers: "execution boundary, authority, cleanup fences",
    pin: pin("docs/architecture/adr-002-daytona-execution-boundary.md"),
  },
  {
    covers: "ownership table, qualified snapshot, repeat-run gaps",
    pin: pin("docs/product/cloud-pilot-integration.md"),
  },
  {
    covers: "secret references held by the owning service",
    pin: pin(".env.example"),
  },
  {
    covers:
      "sandbox-inspection v1: request, record, observed fields, source policy and outcomes",
    pin: pin("packages/agent-contracts/src/sandbox-inspection.ts"),
  },
  {
    covers:
      "inspection route: media type, abuse budgets, owner credential scope, status per outcome",
    pin: pin("lib/runner/sandbox-inspection-http.ts"),
  },
  {
    covers: "runner error codes and their HTTP statuses",
    pin: pin("lib/runner/transport.ts"),
  },
  {
    covers:
      "how each observed field, the SDK version and the identity checks are derived",
    pin: pin("lib/runner/daytona/resource-inspection.ts"),
  },
] as const);

/**
 * The existing owner of each sandbox mutation found at the pin. Castles
 * performs none of them; this table exists so a reader can find who does.
 *
 * The first eight rows are the persistent agent sandbox. The last two are a
 * separate, short-lived sandbox: `diagnoseDaytonaSandbox` creates an
 * ephemeral diagnostic sandbox and deletes it itself. It is listed so that
 * "who can create or delete a sandbox" has a complete answer; it never
 * touches the bound sandbox Castles inspects.
 *
 * The table is a reading of the pinned files named in it. It is not a proof
 * that no other call site exists upstream.
 */
export const MUTATION_OWNERS = Object.freeze([
  {
    castles: "never",
    mutation: "create",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "ensureDaytonaSandbox / ensureDaytonaSandboxForDispatch",
  },
  {
    castles: "never",
    mutation: "start",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "ensureDaytonaSandbox* (start or recover on attach)",
  },
  {
    castles: "never",
    mutation: "stop",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "provider auto-stop policy set at create; no application stop call at this pin",
  },
  {
    castles: "never",
    mutation: "archive",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "provider auto-archive policy set at create; no application archive call at this pin",
  },
  {
    castles: "never",
    mutation: "resize",
    owner: pin("lib/runner/daytona/resource-repair.ts"),
    via: "RunnerPersistentResourceLifecycle.repair",
  },
  {
    castles: "never",
    mutation: "delete",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "RunnerPersistentResourceLifecycle.decommission / recover (also resource-recovery.ts)",
  },
  {
    castles: "never",
    mutation: "reset",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "RunnerPersistentResourceLifecycle.reset",
  },
  {
    castles: "never",
    mutation: "adopt-policy",
    owner: pin("lib/runner/daytona/sandbox.ts"),
    via: "adoptDaytonaSandboxPolicy (labels, auto-stop, auto-archive)",
  },
  {
    castles: "never",
    mutation: "diagnostic-create",
    owner: pin("lib/runner/diagnostics.ts"),
    via: "diagnoseDaytonaSandbox (its own ephemeral diagnostic sandbox, 5 minute TTL)",
  },
  {
    castles: "never",
    mutation: "diagnostic-delete",
    owner: pin("lib/runner/diagnostics.ts"),
    via: "diagnoseDaytonaSandbox / runEphemeralDiagnostic (deletes the sandbox it created)",
  },
] as const);

/**
 * Provider operations that change something but are not sandbox lifecycle
 * mutations, and so are outside the table above. Castles performs neither.
 * Named here so their absence from the table is a statement, not a gap.
 */
export const OUTSIDE_LISTED_MUTATIONS = Object.freeze([
  {
    at: pin("lib/runner/daytona/process.ts"),
    castles: "never",
    operation: "command execution inside a sandbox",
  },
  {
    at: pin("lib/runner/daytona/image.ts"),
    castles: "never",
    operation: "snapshot creation",
  },
] as const);

/**
 * The upstream read-only seam for one pre-existing sandbox landed at the pin
 * (coven-agents #296, closed through #311). What is still missing is a live
 * Castles client for it, which needs the owner credential and explicit
 * authorization for a live check. Until then none is possible, and Castles
 * does not work around that. The `missing` value and the link are kept as they were,
 * because the acceptance notes cite this blocker; renaming it to "live
 * client missing" is left to the maintainer.
 */
export const UPSTREAM_SEAM = Object.freeze({
  issue: "https://github.com/OpenCoven/coven-agents/issues/296",
  status: "missing",
} as const);

/** The single supported profile. Source policy, not observed metadata. */
export const SUPPORTED_PROFILE = Object.freeze({
  credentialBoundaryVersion: "attempt-reset-v1",
  id: "castles.daytona-private-linux.v1",
  image: Object.freeze({
    base: "node:22-bookworm-slim",
    qualifiedSnapshot: "coven-agents-copilot-2",
  }),
  lifecycle: Object.freeze({
    autoArchiveMinutes: Object.freeze({ max: 43_200, min: 60 }),
    autoDeleteInterval: -1,
    autoPauseInterval: 0,
    autoStopMinutes: Object.freeze({ max: 60, min: 5 }),
    ttl: "disabled",
  }),
  /**
   * Upstream sandbox-inspection v1 withholds the raw allow lists, so Castles'
   * earlier per-entry rules (plain ASCII domains only; at most ten IPv4
   * ranges no wider than /8) cannot run. Pending maintainer decision
   * (coven-castles#2), egress is restricted when:
   *
   * - the domain allow list equals the owner's configured policy, as
   *   upstream compares it (exact string equality; both absent match);
   * - no network allow list and no outbound proxy is configured: the owner
   *   policy sets neither, and upstream's own guarded dispatch treats a
   *   proxy as drift;
   * - and either a domain list is configured or block-all is true.
   *
   * The owner's domain rule also accepts a single leading `*.` label, which
   * Castles used to refuse. That is the one place this is looser.
   */
  network: Object.freeze({
    domainAllowList: Object.freeze({ basis: "owner-policy-equality" }),
    egress: "restricted",
    networkAllowList: Object.freeze({
      basis: "owner-policy-sets-none",
      configured: "refused",
    }),
    outboundProxy: Object.freeze({
      basis: "owner-policy-sets-none",
      configured: "refused",
    }),
    public: false,
  }),
  platform: Object.freeze({
    // Maintainer decision (coven-castles#2, 2026-11-20). Upstream
    // inspection v1 reports no platform (asked in coven-agents#323), so the
    // operating system is source policy implied by the qualified snapshot,
    // whose pinned base image is Linux. It is accepted only when the observed
    // snapshot equals that pin. No architecture is pinned anywhere upstream,
    // so none is required; it is never reported as observed.
    architecture: "not-pinned",
    basis: "qualified-snapshot",
    os: "linux",
  }),
  provider: "daytona",
  resources: Object.freeze({
    caps: Object.freeze({ cpu: 4, diskGiB: 10, memoryGiB: 8 }),
    floor: Object.freeze({ cpu: 1, diskGiB: 10, memoryGiB: 1 }),
    target: Object.freeze({ cpu: 2, diskGiB: 10, memoryGiB: 4 }),
  }),
  sdk: Object.freeze({ package: "@daytona/sdk", version: "0.231.1" }),
  targets: Object.freeze(["us", "eu"] as const),
} as const);

export const BINDING_ENVIRONMENT_KEYS = [
  "CASTLES_PROFILE",
  "CASTLES_SANDBOX_ID",
  "CASTLES_OWNER_AGENT_ID",
  "CASTLES_SANDBOX_GENERATION",
] as const;

/**
 * What the operator configures. The sandbox ID is a *target*, not
 * authorization: ownership is decided by the owning service from its
 * authenticated caller, never from these values.
 */
export type Binding = Readonly<{
  /** The Coven Agents agent record that canonically owns the sandbox. */
  agentId: string;
  expectedGeneration: number;
  profile: typeof SUPPORTED_PROFILE.id;
  sandboxId: string;
}>;

export type BindingProblem =
  | "generation_invalid"
  | "generation_missing"
  | "owner_binding_invalid"
  | "owner_binding_missing"
  | "profile_missing"
  | "sandbox_id_invalid"
  | "sandbox_id_missing"
  | "unknown_profile";

export type BindingResult =
  | Readonly<{ binding: Binding; ok: true }>
  | Readonly<{
      ok: false;
      /** Values that did parse, kept only so output can alias them. */
      partial: Partial<Binding>;
      problem: BindingProblem;
    }>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const GENERATION = /^(?:0|[1-9]\d{0,8})$/u;

/**
 * Parses the binding from an environment-shaped record. Exact values only:
 * no defaults, no trimming into validity, no lookup by name or label.
 *
 * An environment that is `null`, `undefined`, a primitive or a function
 * configures nothing: it is reported as a missing sandbox ID, the same
 * finding as an empty record, not as an exception. Any other object is
 * read, an array included. A property whose read throws is not handled: the
 * caller's error propagates.
 */
export function parseBinding(
  environment: Readonly<Record<string, string | undefined>>
): BindingResult {
  const partial: { -readonly [Key in keyof Binding]?: Binding[Key] } = {};
  const fail = (problem: BindingProblem): BindingResult => ({
    ok: false,
    partial,
    problem,
  });
  if (typeof environment !== "object" || environment === null) {
    return fail("sandbox_id_missing");
  }

  const sandboxId = environment.CASTLES_SANDBOX_ID;
  if (!sandboxId) {
    return fail("sandbox_id_missing");
  }
  if (!IDENTIFIER.test(sandboxId)) {
    return fail("sandbox_id_invalid");
  }
  partial.sandboxId = sandboxId;

  const profile = environment.CASTLES_PROFILE;
  if (!profile) {
    return fail("profile_missing");
  }
  if (profile !== SUPPORTED_PROFILE.id) {
    return fail("unknown_profile");
  }
  partial.profile = SUPPORTED_PROFILE.id;

  const agentId = environment.CASTLES_OWNER_AGENT_ID;
  if (!agentId) {
    return fail("owner_binding_missing");
  }
  if (!IDENTIFIER.test(agentId)) {
    return fail("owner_binding_invalid");
  }
  partial.agentId = agentId;

  const generation = environment.CASTLES_SANDBOX_GENERATION;
  if (!generation) {
    return fail("generation_missing");
  }
  if (!GENERATION.test(generation)) {
    return fail("generation_invalid");
  }
  partial.expectedGeneration = Number(generation);

  return {
    binding: {
      agentId,
      expectedGeneration: Number(generation),
      profile: SUPPORTED_PROFILE.id,
      sandboxId,
    },
    ok: true,
  };
}
