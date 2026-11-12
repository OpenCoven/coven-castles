/**
 * Source policy for the one supported sandbox profile, and the operator's
 * binding configuration.
 *
 * Everything in this module is *policy read from pinned source*. It is not an
 * observation of any sandbox and not an attestation of any deployment.
 */

const UPSTREAM_REPOSITORY = "OpenCoven/coven-agents";
const UPSTREAM_SHA = "3a4f3ff4130860d0abda1d2207b43b2f9d372180";

const pin = (path: string) => `${UPSTREAM_REPOSITORY}@${UPSTREAM_SHA}:${path}`;

/** Consumed contracts, each as repo@sha:path. Inspected read-only. */
export const SOURCE_PINS = Object.freeze([
  {
    covers: "toolchain (pnpm 10.32.1, tsx, TypeScript) and @daytona/sdk 0.220.0",
    pin: pin("package.json"),
  },
  {
    covers: "resolved @daytona/sdk 0.220.0 and its API clients",
    pin: pin("pnpm-lock.yaml"),
  },
  {
    covers: "tsx --test and the package tsconfig shape",
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
      "create parameters (private, non-ephemeral), credential-boundary marker, lifecycle mutations",
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
 * Upstream has no read-only seam for one pre-existing sandbox at the pin.
 * This is a blocker for any live check, not something Castles works around.
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
  network: Object.freeze({
    egress: "restricted",
    /**
     * A Castles policy decision with NO upstream pin. Neither
     * `networkAllowList` nor `networkBlockAll` appears in any pinned
     * coven-agents file: the owning service configures a domain allow list
     * only, and its drift inventory compares that list alone. So for network
     * lists and block-all, Castles accepts shapes the owner never produces,
     * under these rules of its own:
     *
     * - each entry is an IPv4 range no wider than `/minIpv4Prefix`;
     * - the list holds at most `maxEntries` entries, because a restriction
     *   is a property of the whole list (256 ranges of /8 are every address);
     * - `networkBlockAll: true` counts as restricted egress.
     *
     * `maxEntries` is 10 because the public Daytona network-limits
     * documentation states that maximum. That figure is unverified against
     * the provider and is not stated in the SDK 0.220.0 types, so it is a
     * Castles bound, not a provider pin. At the bound the widest accepted
     * list is ten /8 ranges, about 4% of IPv4 space.
     */
    networkAllowList: Object.freeze({
      basis: "castles-decision",
      maxEntries: 10,
      minIpv4Prefix: 8,
    }),
    public: false,
  }),
  platform: Object.freeze({
    // No architecture is pinned upstream and the provider sandbox model at
    // this SDK generation reports none. It must be stated by the seam; it is
    // recorded as observed, never assumed.
    architecture: "reported-not-pinned",
    os: "linux",
  }),
  provider: "daytona",
  resources: Object.freeze({
    caps: Object.freeze({ cpu: 4, diskGiB: 10, memoryGiB: 8 }),
    floor: Object.freeze({ cpu: 1, diskGiB: 10, memoryGiB: 1 }),
    target: Object.freeze({ cpu: 2, diskGiB: 10, memoryGiB: 4 }),
  }),
  sdk: Object.freeze({ package: "@daytona/sdk", version: "0.220.0" }),
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
