import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFixtureInspectionClient,
  DEFAULT_INSPECTION_TIMEOUT_MS,
  FIXTURE_LABEL,
  isLiveReady,
  loadFixtureCase,
  PREFLIGHT_JSON_MAX_BYTES,
  type PreflightResult,
  renderHuman,
  renderJson,
  runPreflight,
  type SandboxInspectionClient,
} from "../src/preflight";
import {
  BINDING_ENVIRONMENT_KEYS,
  MUTATION_OWNERS,
  OUTSIDE_LISTED_MUTATIONS,
  parseBinding,
  SOURCE_PINS,
  SUPPORTED_PROFILE,
  UPSTREAM_SEAM,
} from "../src/profile";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const casesDirectory = join(root, "fixtures", "preflight", "cases");
const casePath = (name: string) => join(casesDirectory, `${name}.json`);

const MUTATIONS = [
  "create",
  "start",
  "stop",
  "archive",
  "delete",
  "resize",
  "update",
  "setLabels",
  "setAutostopInterval",
  "setAutoArchiveInterval",
  "list",
  "findOne",
  "executeCommand",
] as const;

/**
 * A provider-shaped tripwire: every mutation (and every non-exact lookup) is
 * present and recorded, so a preflight that reached for one would be caught.
 */
function tripwireClient(respond: () => unknown) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const client: Record<string, unknown> = {
    inspectBoundSandbox(request: unknown) {
      calls.push("inspectBoundSandbox");
      requests.push(request);
      return Promise.resolve().then(respond);
    },
  };
  for (const name of MUTATIONS) {
    client[name] = () => {
      calls.push(name);
      throw new Error(`fixture tripwire: ${name} must never be called`);
    };
  }
  return {
    calls,
    client: client as unknown as SandboxInspectionClient,
    requests,
  };
}

async function runCase(name: string) {
  const fixture = loadFixtureCase(casePath(name));
  const wire = tripwireClient(() => fixture.inspection);
  const result = await runPreflight(fixture.env, wire.client);
  return { fixture, result, wire };
}

const codes = (result: PreflightResult) =>
  result.reasons.map((reason) => reason.code);

// --- Missing ID: the first fixture (#2 "Next action") ----------------------

test("missing sandbox ID fails closed with zero provider effects", async () => {
  const { result, wire } = await runCase("missing-id");
  assert.equal(result.status, "unavailable");
  assert.deepEqual(codes(result), ["sandbox_id_missing"]);
  assert.deepEqual(wire.calls, []);
  assert.equal(result.providerCalls.inspect, 0);
  assert.equal(result.observed, null);
  assert.equal(result.target.sandboxAlias, null);
});

// --- One fixture per fail-closed case in #2's acceptance list --------------

const FAIL_CLOSED_CASES = [
  "missing-id",
  "wrong-owner",
  "wrong-generation",
  "unknown-profile",
  "unsafe-lifecycle",
  "public-exposure",
  "unavailable-provider",
  "mismatched-returned-id",
  // Beyond the acceptance list, same rule.
  "missing-sandbox",
  "ambiguous-lookup",
  "binding-mismatch",
  "metadata-missing",
  "unrestricted-egress",
  "allow-all-egress",
  "unresolved-attempt",
] as const;

for (const name of FAIL_CLOSED_CASES) {
  test(`fail-closed fixture: ${name}`, async () => {
    const { fixture, result, wire } = await runCase(name);
    assert.notEqual(result.status, "ready");
    assert.equal(result.status, fixture.expect.status);
    assert.deepEqual(codes(result), fixture.expect.reasons);
    assert.equal(result.providerCalls.inspect, fixture.expect.inspectCalls);
    assert.deepEqual(
      wire.calls,
      Array.from(
        { length: fixture.expect.inspectCalls },
        () => "inspectBoundSandbox"
      )
    );
  });
}

test("every fixture case file is exercised and carries the synthetic label", () => {
  const files = readdirSync(casesDirectory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/u, ""))
    .sort();
  assert.deepEqual(files, [...FAIL_CLOSED_CASES, "ready", "stopped"].sort());
  for (const name of files) {
    assert.equal(loadFixtureCase(casePath(name)).fixture, FIXTURE_LABEL);
  }
});

test("a fixture file without the synthetic label is refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "castles-label-"));
  try {
    const unlabelled = join(directory, "case.json");
    const original = JSON.parse(readFileSync(casePath("ready"), "utf8"));
    writeFileSync(
      unlabelled,
      JSON.stringify({ ...original, fixture: "looks real" })
    );
    assert.throws(() => loadFixtureCase(unlabelled), /synthetic/iu);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// --- Positive and stopped --------------------------------------------------

test("ready fixture reports ready and asks for exactly the configured binding", async () => {
  const { result, wire } = await runCase("ready");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
  assert.deepEqual(wire.requests, [
    {
      agentId: "fixture-agent-0001",
      expectedGeneration: 3,
      sandboxId: "fixture-sandbox-0001",
    },
  ]);
  assert.equal(result.evidence, "fixture");
});

test("a stopped sandbox is reported as stopped and is never woken", async () => {
  const { result, wire } = await runCase("stopped");
  assert.equal(result.status, "stopped");
  assert.deepEqual(codes(result), ["sandbox_stopped"]);
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);

  const archived = await withArchivedState();
  assert.equal(archived.status, "stopped");
  assert.deepEqual(codes(archived), ["sandbox_stopped"]);
});

async function withArchivedState() {
  const fixture = loadFixtureCase(casePath("stopped"));
  const inspection = structuredClone(fixture.inspection) as {
    body: { observed: Record<string, unknown> };
  };
  inspection.body.observed.state = "archived";
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client);
}

// --- Missing sandbox / ambiguity: no replacement, no adoption --------------

test("a missing sandbox causes zero create/start/update/delete calls", async () => {
  const { result, wire } = await runCase("missing-sandbox");
  assert.equal(result.status, "unavailable");
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
  assert.equal(result.observed, null);
});

test("an ambiguous lookup triggers no replacement, adoption, or second lookup", async () => {
  const { result, wire } = await runCase("ambiguous-lookup");
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
  assert.equal(result.observed, null);
});

test("a substituted sandbox is never adopted and its metadata is not disclosed", async () => {
  for (const name of ["mismatched-returned-id", "binding-mismatch"]) {
    const { result, wire } = await runCase(name);
    assert.notEqual(result.status, "ready");
    assert.equal(result.observed, null);
    assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
    assert.doesNotMatch(renderJson(result), /fixture-sandbox-9999/u);
  }
});

test("matching labels or name on the wrong ID grant nothing", async () => {
  // Upstream withholds names and raw labels. Its own label checks passing
  // on an answer about another recorded sandbox grant nothing.
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as any;
  inspection.body.record.sandboxId = "fixture-sandbox-9999";
  inspection.body.observed.identity = {
    configuration: "current",
    credentialBoundary: true,
    generationLabel: true,
    ownershipLabels: true,
  };
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client);
  assert.equal(result.status, "unauthorized");
  assert.deepEqual(codes(result), ["binding_mismatch"]);
  assert.equal(result.observed, null);
  assert.doesNotMatch(renderJson(result), /fixture-sandbox-9999/u);
});

// --- Provider failure handling ---------------------------------------------

const CANARY = "CANARY-9f2c-do-not-print";

test("a throwing provider is unavailable and its raw error never surfaces", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const wire = tripwireClient(() => {
    throw new Error(
      `401 from https://provider.invalid/api/sandbox/fixture-sandbox-0001 token=${CANARY}`
    );
  });
  const result = await runPreflight(fixture.env, wire.client);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(codes(result), ["provider_unavailable"]);
  for (const output of [renderJson(result), renderHuman(result)]) {
    assert.doesNotMatch(output, new RegExp(CANARY, "u"));
    assert.doesNotMatch(output, /provider\.invalid/u);
  }
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
});

test("a provider that never answers is bounded by the deadline", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const client: SandboxInspectionClient = {
    inspectBoundSandbox: () => new Promise(() => undefined),
  };
  const result = await runPreflight(fixture.env, client, { timeoutMs: 20 });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(codes(result), ["provider_unavailable"]);
});

test("a response outside the inspection contract fails closed", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  for (const response of [
    undefined,
    null,
    "started",
    [],
    {},
    { outcome: "ready" },
    { contract: "something-else", outcome: "observed" },
    // The earlier fixture-only shape, without an HTTP status.
    { contract: "castles.fixture.sandbox-inspection.v1", outcome: "observed" },
    { status: 200 },
    { body: (fixture.inspection as any).body },
    { status: 200, body: { outcome: "observed" } },
    {
      ...(fixture.inspection as any),
      body: { ...(fixture.inspection as any).body, observed: null },
    },
  ]) {
    const wire = tripwireClient(() => response);
    const result = await runPreflight(fixture.env, wire.client);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(codes(result), ["inspection_contract_violation"]);
    assert.equal(result.observed, null);
  }
});

test("an unsettled or unrecognised lifecycle state is never ready", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  for (const state of [
    "transitioning",
    "error",
    "unknown",
    "destroyed",
    "starting",
    "paused",
    "not-a-state",
    undefined,
  ]) {
    const inspection = structuredClone(fixture.inspection) as {
      body: { observed: Record<string, unknown> };
    };
    inspection.body.observed.state = state;
    const wire = tripwireClient(() => inspection);
    const result = await runPreflight(fixture.env, wire.client);
    assert.notEqual(result.status, "ready", String(state));
    assert.notEqual(result.status, "stopped", String(state));
  }
});

test("each unsafe policy field fails on its own", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const edits: Record<string, [string, unknown]> = {
    lifecycle_auto_archive: ["autoArchiveInterval", 5],
    lifecycle_auto_delete: ["autoDeleteInterval", 30],
    lifecycle_auto_pause: ["autoPauseInterval", 10],
    lifecycle_auto_stop: ["autoStopInterval", 0],
    lifecycle_ttl: ["autoDestroyAtConfigured", true],
    image_unqualified: ["snapshot", "fixture-other-image"],
    linked_sandbox_present: ["linkedSandbox", true],
    resources_out_of_policy: ["cpu", 16],
    gpu_present: ["gpu", 1],
    volumes_present: ["volumes", 1],
    warm_pool_member: ["warmPool", true],
  };
  for (const [code, [field, value]] of Object.entries(edits)) {
    const inspection = structuredClone(fixture.inspection) as {
      body: { observed: Record<string, unknown> };
    };
    inspection.body.observed[field] = value;
    const wire = tripwireClient(() => inspection);
    const result = await runPreflight(fixture.env, wire.client);
    assert.equal(result.status, "incompatible", code);
    assert.deepEqual(codes(result), [code]);
  }
});

// --- Egress: an allow list must actually restrict (review finding B1) -------
// Upstream v1 withholds the raw lists, so the per-entry rules that used to
// live here cannot run; see the v1 egress test. These keep the rules that
// still can.

/** Edits the observed block of the ready v1 answer. */
async function withSandbox(edit: (sandbox: Record<string, unknown>) => void) {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as {
    body: { observed: Record<string, unknown> };
  };
  edit(inspection.body.observed);
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client);
}

test("an unsafe allow list is not excused by block-all or by a second safe list", async () => {
  const blockAll = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = true;
    sandbox.domainAllowListMatchesPolicy = false;
  });
  assert.equal(blockAll.status, "incompatible");
  assert.deepEqual(codes(blockAll), ["egress_allow_list_unsafe"]);

  const mixed = await withSandbox((sandbox) => {
    sandbox.networkAllowListConfigured = true;
  });
  assert.equal(mixed.status, "incompatible");
  assert.deepEqual(codes(mixed), ["egress_allow_list_unsafe"]);
});

test("an allow list that is present but not a string is missing metadata", async () => {
  // Upstream reports each list as a boolean comparison; one that is not a
  // boolean is not a statement.
  for (const field of [
    "domainAllowListConfigured",
    "domainAllowListMatchesPolicy",
    "networkAllowListConfigured",
    "outboundProxyConfigured",
  ]) {
    const result = await withSandbox((sandbox) => {
      sandbox[field] = ["*"];
    });
    assert.equal(result.status, "incompatible", field);
    assert.ok(codes(result).includes("metadata_missing"), field);
    assert.notEqual(result.status, "ready");
  }
});

test("the egress policy is recorded as these literals", async () => {
  // Literals on purpose: a loosened constant must turn this red.
  const network = {
    domainAllowList: { basis: "owner-policy-equality" },
    egress: "restricted",
    networkAllowList: { basis: "owner-policy-sets-none", configured: "refused" },
    outboundProxy: { basis: "owner-policy-sets-none", configured: "refused" },
    public: false,
  };
  assert.deepEqual(SUPPORTED_PROFILE.network, network);
  const { result } = await runCase("ready");
  assert.deepEqual(
    JSON.parse(renderJson(result)).sourcePolicy.network,
    network
  );
});

// --- Gates that had no test (review N1) ------------------------------------

/** Edits the body of the ready v1 answer. */
async function withInspection(edit: (inspection: any) => void) {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as { body: unknown };
  edit(inspection.body);
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client);
}

test("a missing or different credential-boundary marker needs reconciliation", async () => {
  // Upstream withholds the raw labels and reports its own check, beside the
  // credential-boundary version in its source policy.
  for (const edit of [
    (inspection: any) => (inspection.observed.identity.credentialBoundary = false),
    (inspection: any) => (inspection.observed.identity.credentialBoundary = null),
    (inspection: any) => (inspection.observed.identity.credentialBoundary = "true"),
    (inspection: any) => delete inspection.observed.identity.credentialBoundary,
    (inspection: any) => (inspection.policy.credentialBoundaryVersion = "attempt-reset-v0"),
    (inspection: any) => (inspection.policy.credentialBoundaryVersion = ["attempt-reset-v1"]),
    (inspection: any) => delete inspection.policy.credentialBoundaryVersion,
  ]) {
    const result = await withInspection(edit);
    assert.equal(result.status, "reconciliation-required");
    assert.deepEqual(codes(result), ["credential_boundary_unverified"]);
  }
});

test("a binding whose lifecycle is not ready needs reconciliation", async () => {
  for (const lifecycle of ["provisioning", "resetting", "failed", ""]) {
    const result = await withInspection((inspection) => {
      inspection.record.lifecycle = lifecycle;
    });
    assert.equal(result.status, "reconciliation-required", lifecycle);
    assert.deepEqual(codes(result), ["binding_lifecycle_pending"]);
  }
});

test("an unsupported target is incompatible, and no platform can be smuggled in", async () => {
  const target = await withInspection((inspection) => {
    inspection.observed.target = "fixture-region";
  });
  assert.equal(target.status, "incompatible");
  assert.deepEqual(codes(target), ["target_unsupported"]);

  // v1 reports no platform. A platform block is a key v1 does not define,
  // so it is a contract violation rather than an observation.
  const platform = await withInspection((inspection) => {
    inspection.observed.platform = { architecture: "x86_64", os: "fixture-os" };
  });
  assert.equal(platform.status, "unavailable");
  assert.deepEqual(codes(platform), ["inspection_contract_violation"]);
});

test("each resource bound fails on its own, above and below", async () => {
  const { caps, floor } = SUPPORTED_PROFILE.resources;
  const edits: [string, number][] = [
    ["cpu", caps.cpu + 1],
    ["cpu", floor.cpu - 1],
    ["memoryGib", caps.memoryGiB + 1],
    ["memoryGib", floor.memoryGiB - 1],
    ["diskGib", caps.diskGiB + 1],
    ["diskGib", floor.diskGiB - 1],
  ];
  for (const [field, value] of edits) {
    const result = await withInspection((inspection) => {
      inspection.observed[field] = value;
    });
    assert.equal(result.status, "incompatible", `${field}=${value}`);
    assert.deepEqual(codes(result), ["resources_out_of_policy"]);
  }
  for (const [field, value] of [
    ["cpu", caps.cpu],
    ["cpu", floor.cpu],
    ["memoryGib", caps.memoryGiB],
    ["memoryGib", floor.memoryGiB],
  ] as const) {
    const result = await withInspection((inspection) => {
      inspection.observed[field] = value;
    });
    assert.equal(result.status, "ready", `${field}=${value}`);
  }
});

test("JSON output carries every source pin", async () => {
  const { result } = await runCase("ready");
  const parsed = JSON.parse(renderJson(result));
  assert.deepEqual(
    parsed.sourcePolicy.pins,
    SOURCE_PINS.map((entry) => entry.pin)
  );
  assert.equal(parsed.sourcePolicy.pins.length, 22);
});

// --- Owner echo, disclosure and stated decisions (review N4 to N6) ---------

test("a response about a different agent record is refused and not disclosed", async () => {
  const result = await withInspection((inspection) => {
    inspection.record.agentId = "fixture-agent-9999";
  });
  assert.equal(result.status, "unauthorized");
  assert.deepEqual(codes(result), ["owner_mismatch"]);
  assert.equal(result.observed, null);
  assert.doesNotMatch(renderJson(result), /fixture-agent-9999/u);

  const absent = await withInspection((inspection) => {
    delete inspection.record.agentId;
  });
  assert.equal(absent.status, "unavailable");
  assert.deepEqual(codes(absent), ["inspection_contract_violation"]);
  assert.equal(absent.observed, null);
});

test("a stale generation is reported with the observed metadata, by decision", async () => {
  const result = await withInspection((inspection) => {
    inspection.record.generation = 9;
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(codes(result), ["generation_mismatch"]);
  assert.notEqual(result.observed, null);
  assert.equal(result.observed?.binding.generation, 9);
});

test("false TTL and attachment flags read as not set; absent ones are missing metadata", async () => {
  // v1 states these as booleans and a count. Upstream folds "not reported"
  // into false or 0 (coven-agents#322); an absent or null key is still
  // missing metadata here.
  const keys = ["autoDestroyAtConfigured", "volumes", "warmPool", "linkedSandbox"];
  const stated = await withInspection((inspection) => {
    for (const key of keys) {
      inspection.observed[key] = key === "volumes" ? 0 : false;
    }
  });
  assert.equal(stated.status, "ready");
  assert.deepEqual(stated.reasons, []);
  for (const edit of [
    (observed: any, key: string) => delete observed[key],
    (observed: any, key: string) => (observed[key] = null),
  ]) {
    const absent = await withInspection((inspection) => {
      for (const key of keys) {
        edit(inspection.observed, key);
      }
    });
    assert.equal(absent.status, "incompatible");
    assert.deepEqual(absent.reasons, [
      { code: "metadata_missing", field: "autoDestroyAtConfigured" },
      { code: "metadata_missing", field: "volumes" },
      { code: "metadata_missing", field: "warmPool" },
      { code: "metadata_missing", field: "linkedSandbox" },
    ]);
  }
  const noVolumes = await withInspection((inspection) => {
    delete inspection.observed.volumes;
  });
  assert.equal(noVolumes.status, "incompatible");
  assert.deepEqual(noVolumes.reasons, [{ code: "metadata_missing", field: "volumes" }]);
});

// --- Fixture readiness is never live readiness (review N3) -----------------

test("only a live-provider ready result counts as readiness", async () => {
  const { result } = await runCase("ready");
  assert.equal(result.status, "ready");
  assert.equal(result.evidence, "fixture");
  assert.equal(isLiveReady(result), false);
  assert.equal(isLiveReady({ ...result, evidence: "none" }), false);
  assert.equal(isLiveReady({ ...result, evidence: "live-provider" }), true);
  assert.equal(
    isLiveReady({ ...result, evidence: "live-provider", status: "stopped" }),
    false
  );
});

test("the evidence class comes from the client, never from the caller (review N3)", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const forged = [
    { evidence: "live-provider" },
    { evidence: "none" },
    { evidence: "live-provider", timeoutMs: 1000 },
  ] as unknown[] as Parameters<typeof runPreflight>[2][];
  for (const options of [undefined, ...forged]) {
    for (const client of [
      createFixtureInspectionClient(fixture),
      tripwireClient(() => fixture.inspection).client,
      { ...createFixtureInspectionClient(fixture) },
      Object.create(createFixtureInspectionClient(fixture)),
    ] as SandboxInspectionClient[]) {
      const result = await runPreflight(fixture.env, client, options);
      assert.equal(result.status, "ready");
      assert.equal(result.evidence, "fixture");
      assert.equal(isLiveReady(result), false);
      assert.equal(result.providerCalls.inspect, 1);
    }
    const none = await runPreflight(fixture.env, null, options);
    assert.equal(none.evidence, "none");
    assert.equal(none.status, "unavailable");
    assert.equal(none.providerCalls.inspect, 0);
    assert.equal(isLiveReady(none), false);
  }
  // The class describes the client, so it holds even when a binding problem
  // stops the check before the client is consulted.
  const unbound = await runPreflight(
    {},
    createFixtureInspectionClient(fixture),
    forged[0]
  );
  assert.equal(unbound.evidence, "fixture");
  assert.equal(unbound.providerCalls.inspect, 0);
  assert.equal((await runPreflight({}, null, forged[0])).evidence, "none");
});

test("a client cannot label itself live", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const selfLabelled = {
    evidence: "live-provider",
    inspectBoundSandbox: () => Promise.resolve(fixture.inspection),
    kind: "live-provider",
    live: true,
  } as SandboxInspectionClient;
  const result = await runPreflight(fixture.env, selfLabelled);
  assert.equal(result.status, "ready");
  assert.equal(result.evidence, "fixture");
  assert.equal(isLiveReady(result), false);
});

test("a different SDK generation is incompatible, not best-effort", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as {
    body: { policy: Record<string, unknown> };
  };
  inspection.body.policy.sdkVersion = "0.232.0";
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client);
  assert.equal(result.status, "incompatible");
  assert.deepEqual(codes(result), ["sdk_generation_mismatch"]);
});

test("identity failures outrank compatibility findings", async () => {
  const fixture = loadFixtureCase(casePath("public-exposure"));
  const inspection = structuredClone(fixture.inspection) as {
    body: { record: Record<string, unknown> };
  };
  inspection.body.record.generation = 9;
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client);
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(codes(result), ["generation_mismatch", "public_exposure"]);
});

// --- Output: bounded, redacted, policy vs. observation ---------------------

test("JSON output separates source policy from observed metadata", async () => {
  const { result } = await runCase("ready");
  const parsed = JSON.parse(renderJson(result));
  assert.equal(parsed.schema, "castles.preflight.v1");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.evidence, "fixture");
  assert.equal(parsed.sourcePolicy.profile, SUPPORTED_PROFILE.id);
  assert.equal(parsed.sourcePolicy.sdk.version, "0.231.1");
  assert.deepEqual(parsed.sourcePolicy.resources.target, {
    cpu: 2,
    diskGiB: 10,
    memoryGiB: 4,
  });
  assert.deepEqual(parsed.observed.resources, {
    cpu: 2,
    diskGiB: 10,
    gpu: 0,
    matchesTarget: true,
    memoryGiB: 4,
  });
  assert.equal(parsed.observed.state, "started");
  assert.equal(parsed.observed.exposure.public, false);
  assert.ok(Array.isArray(parsed.sourcePolicy.pins));
  assert.equal(parsed.providerCalls.inspect, 1);
});

test("output uses redacted aliases, never the configured private IDs", async () => {
  for (const name of [...FAIL_CLOSED_CASES, "ready", "stopped"]) {
    const { result } = await runCase(name);
    for (const output of [renderJson(result), renderHuman(result)]) {
      assert.doesNotMatch(output, /fixture-sandbox-\d+/u, name);
      assert.doesNotMatch(output, /fixture-agent-\d+/u, name);
      assert.doesNotMatch(output, /fixture\.invalid/u, name);
    }
  }
  const { result } = await runCase("ready");
  assert.match(String(result.target.sandboxAlias), /^sbx_[0-9a-f]{12}$/u);
  assert.match(String(result.target.ownerAlias), /^own_[0-9a-f]{12}$/u);
});

test("JSON output stays bounded and clean under hostile provider metadata", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as any;
  inspection.body.observed.target = `us\n${CANARY}`;
  inspection.body.observed.errorReason = CANARY.repeat(5000);
  inspection.body.observed.env = { TOKEN: CANARY };
  inspection.body.labels = {
    ...Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`label-${index}`, CANARY])
    ),
    credentialBoundaryVersion: "attempt-reset-v1",
  };
  inspection.body.observed.platform = { architecture: "x".repeat(100_000) };
  inspection.body.extra = CANARY.repeat(5000);
  // The answer wrapper is Castles' own; its extra keys are not read.
  inspection.extra = CANARY.repeat(5000);
  // Unknown keys refuse the whole answer; a hostile value in a known key is
  // read and never echoed. Both stay bounded and clean.
  const targetOnly = structuredClone(fixture.inspection) as any;
  targetOnly.body.observed.target = `us\n${CANARY}`;
  for (const answer of [inspection, targetOnly]) {
    const wire = tripwireClient(() => answer);
    const result = await runPreflight(fixture.env, wire.client);
    const json = renderJson(result);
    assert.ok(Buffer.byteLength(json) <= PREFLIGHT_JSON_MAX_BYTES);
    assert.doesNotMatch(json, new RegExp(CANARY, "u"));
    assert.doesNotMatch(renderHuman(result), new RegExp(CANARY, "u"));
    assert.notEqual(result.status, "ready");
  }
});

// --- Provider free text is never echoed (review N1) ------------------------

const ECHOED_FIELDS: readonly (readonly [
  string,
  (inspection: any, value: unknown) => void,
])[] = [
  ["observed.state", (i, v) => (i.observed.state = v)],
  ["observed.target", (i, v) => (i.observed.target = v)],
  ["observed.snapshot", (i, v) => (i.observed.snapshot = v)],
  ["policy.sdkVersion", (i, v) => (i.policy.sdkVersion = v)],
  ["record.lifecycle", (i, v) => (i.record.lifecycle = v)],
  ["record.fence", (i, v) => (i.record.fence = v)],
  // `identity.configuration` is echoed too, but only `current` and `prior`
  // are ever disclosed: any other value withholds the observed block.
];

test("no echoed field can carry the configured IDs or free text into output", async () => {
  const hostile = [
    "fixture-sandbox-0001",
    "fixture-agent-0001",
    CANARY,
    "canary9f2c",
    "x",
    "1.2.3-canary9f2c",
    "0.231.1.canary9f2c",
    "Started",
    " started",
  ];
  for (const [field, set] of ECHOED_FIELDS) {
    for (const value of hostile) {
      const result = await withInspection((inspection) => set(inspection, value));
      for (const output of [renderJson(result), renderHuman(result)]) {
        const where = `${field}=${JSON.stringify(value)}`;
        assert.doesNotMatch(output, /fixture-sandbox-0001/u, where);
        assert.doesNotMatch(output, /fixture-agent-0001/u, where);
        assert.doesNotMatch(output, /canary/iu, where);
        assert.ok(!output.includes(`"${value}"`), where);
      }
      assert.notEqual(result.status, "ready", `${field}=${value}`);
      assert.notEqual(result.observed, null);
    }
  }
});

test("a value outside the known set is reported as unrecognised, an absent one as null", async () => {
  const read: Record<string, (result: PreflightResult) => unknown> = {
    "observed.snapshot": (r) => r.observed?.image.snapshot,
    "observed.state": (r) => r.observed?.state,
    "observed.target": (r) => r.observed?.target,
    "policy.sdkVersion": (r) => r.observed?.sdk.version,
    "record.fence": (r) => r.observed?.binding.attemptFence,
    "record.lifecycle": (r) => r.observed?.binding.lifecycle,
  };
  for (const [field, set] of ECHOED_FIELDS) {
    const unknown = await withInspection((inspection) =>
      set(inspection, "fixture-free-text")
    );
    assert.equal(read[field]?.(unknown), "unrecognised", field);
    // The two record fields are required strings; absence is a contract
    // violation and discloses nothing.
    if (field.startsWith("record.")) {
      continue;
    }
    const absent = await withInspection((inspection) => set(inspection, undefined));
    assert.equal(read[field]?.(absent), null, field);
    const wrongType = await withInspection((inspection) => set(inspection, 7));
    assert.equal(read[field]?.(wrongType), null, field);
  }
});

test("known values are echoed exactly", async () => {
  const known: [string, unknown, (result: PreflightResult) => unknown][] = [
    ["observed.state", "transitioning", (r) => r.observed?.state],
    ["observed.state", "destroyed", (r) => r.observed?.state],
    ["observed.target", "eu", (r) => r.observed?.target],
    ["observed.snapshot", "coven-agents-copilot-2", (r) => r.observed?.image.snapshot],
    ["policy.sdkVersion", "0.221.0", (r) => r.observed?.sdk.version],
    ["policy.sdkVersion", "10.0.999", (r) => r.observed?.sdk.version],
    ["record.lifecycle", "provisioning_ambiguous", (r) => r.observed?.binding.lifecycle],
    ["record.fence", "cleanup_required", (r) => r.observed?.binding.attemptFence],
    ["record.fence", "attempt_outstanding", (r) => r.observed?.binding.attemptFence],
  ];
  const setters = new Map(ECHOED_FIELDS);
  for (const [field, value, get] of known) {
    const result = await withInspection((inspection) =>
      setters.get(field)?.(inspection, value)
    );
    assert.equal(get(result), value, `${field}=${String(value)}`);
  }
  for (const version of ["0.231", "0.231.1.1", "v0.231.1", "0.231.1-rc1", "0000.1.1", "01.2.3"]) {
    const result = await withInspection((inspection) => {
      inspection.policy.sdkVersion = version;
    });
    assert.equal(result.observed?.sdk.version, "unrecognised", version);
  }
});

test("reasons are capped", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as any;
  // Every observed key absent except the identity block, which v1 requires.
  inspection.body.observed = { identity: inspection.body.observed.identity };
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client);
  assert.equal(result.status, "incompatible");
  assert.ok(result.reasons.length <= 16);
});

// --- Observed integers are echoed only inside a small range (review R1) -----

const INTEGER_FIELDS: readonly (readonly [
  string,
  (inspection: any, value: unknown) => void,
  (result: PreflightResult) => unknown,
])[] = [
  ["observed.cpu", (i, v) => (i.observed.cpu = v), (r) => r.observed?.resources.cpu],
  ["observed.memoryGib", (i, v) => (i.observed.memoryGib = v), (r) => r.observed?.resources.memoryGiB],
  ["observed.diskGib", (i, v) => (i.observed.diskGib = v), (r) => r.observed?.resources.diskGiB],
  ["observed.gpu", (i, v) => (i.observed.gpu = v), (r) => r.observed?.resources.gpu],
  ["observed.autoStopInterval", (i, v) => (i.observed.autoStopInterval = v), (r) => r.observed?.lifecycle.autoStopInterval],
  ["observed.autoArchiveInterval", (i, v) => (i.observed.autoArchiveInterval = v), (r) => r.observed?.lifecycle.autoArchiveInterval],
  ["observed.autoDeleteInterval", (i, v) => (i.observed.autoDeleteInterval = v), (r) => r.observed?.lifecycle.autoDeleteInterval],
  ["observed.autoPauseInterval", (i, v) => (i.observed.autoPauseInterval = v), (r) => r.observed?.lifecycle.autoPauseInterval],
  ["record.generation", (i, v) => (i.record.generation = v), (r) => r.observed?.binding.generation],
];
/** v1 has no negative generation: one is a contract violation (v1 tests). */
const NEGATIVE_IS_VIOLATION = new Set(["record.generation"]);

test("R1: an all-digit configured ID returned in a numeric field never reaches output", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  // Invented all-digit identifiers. The last is the smallest the rule covers.
  for (const digits of ["900719925474", "4815162342", "900719925", "100000"]) {
    for (const key of ["CASTLES_SANDBOX_ID", "CASTLES_OWNER_AGENT_ID"] as const) {
      const env = { ...fixture.env, [key]: digits };
      for (const [field, set, read] of INTEGER_FIELDS) {
        const where = `${key}=${digits} returned in ${field}`;
        const inspection = structuredClone(fixture.inspection) as any;
        inspection.body.record.agentId = env.CASTLES_OWNER_AGENT_ID;
        inspection.body.record.sandboxId = env.CASTLES_SANDBOX_ID;
        set(inspection.body, Number(digits));
        const wire = tripwireClient(() => inspection);
        const result = await runPreflight(env, wire.client);
        // Identity holds, so the observed block is disclosed; the number is not.
        assert.notEqual(result.observed, null, where);
        assert.notEqual(result.status, "ready", where);
        assert.equal(read(result), null, where);
        for (const output of [renderJson(result), renderHuman(result)]) {
          assert.ok(!output.includes(digits), where);
        }
      }
    }
  }
});

test("R1: an observed integer is echoed from -1 to 99999 and is null outside, with status and reasons unchanged", async () => {
  // Literals on purpose: a widened range must turn this red.
  const inside = [-1, 0, 1, 99_999];
  const outside = [
    -2,
    -100_000,
    100_000,
    2 ** 31,
    999_999_999,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ];
  for (const [field, set, read] of INTEGER_FIELDS) {
    const allowed = (value: number) =>
      value >= 0 || !NEGATIVE_IS_VIOLATION.has(field);
    for (const value of inside.filter(allowed)) {
      const result = await withInspection((inspection) => set(inspection, value));
      assert.equal(read(result), value, `${field}=${value}`);
    }
    // 99999 is out of policy for every field, so a value beyond the range
    // must be reported exactly as it is: same status, same reasons.
    const reference = await withInspection((inspection) => set(inspection, 99_999));
    assert.notEqual(reference.status, "ready", field);
    assert.equal(reference.reasons.length, 1, field);
    for (const value of outside.filter(allowed)) {
      const where = `${field}=${value}`;
      const result = await withInspection((inspection) => set(inspection, value));
      assert.equal(read(result), null, where);
      assert.equal(result.status, reference.status, where);
      assert.deepEqual(result.reasons, reference.reasons, where);
      assert.notEqual(result.observed, null, where);
      const human = renderHuman(result);
      const json = renderJson(result);
      // -2 is too short to search for: "2" is in every output.
      if (Math.abs(value) >= 100_000) {
        for (const output of [human, json]) {
          assert.ok(!output.includes(String(Math.abs(value))), where);
        }
      }
      assert.doesNotMatch(human, /\bnull\b|undefined|NaN/u, where);
    }
  }
  const stale = await withInspection((inspection) => {
    inspection.record.generation = 100_000;
  });
  assert.equal(stale.status, "reconciliation-required");
  assert.deepEqual(stale.reasons, [
    { code: "generation_mismatch", field: "record.generation" },
  ]);
  assert.equal(JSON.parse(renderJson(stale)).observed.binding.generation, null);
  assert.match(renderHuman(stale), /^  binding generation \?, lifecycle ready, /mu);

  // matchesTarget follows the readings themselves, each of the three, and
  // is false for a reading that is not echoed.
  for (const [field, value] of [
    ["cpu", 3],
    ["memoryGib", 5],
    ["diskGib", 11],
    ["diskGib", 9],
    ["cpu", 100_000],
    ["memoryGib", 100_000],
    ["diskGib", 100_000],
  ] as const) {
    const off = await withInspection((inspection) => {
      inspection.observed[field] = value;
    });
    assert.equal(off.observed?.resources.matchesTarget, false, `${field}=${value}`);
  }
});

test("R1 consequence: a matching generation beyond the echoed range is ready and is not echoed", async () => {
  // Stated, not hidden: the binding format allows a nine-digit generation.
  // The match shows as no generation_mismatch beside the expected value.
  const fixture = loadFixtureCase(casePath("ready"));
  for (const [generation, echoed] of [
    [99_999, 99_999],
    [100_000, null],
    [999_999_999, null],
  ] as const) {
    const env = { ...fixture.env, CASTLES_SANDBOX_GENERATION: String(generation) };
    const inspection = structuredClone(fixture.inspection) as any;
    inspection.body.record.generation = generation;
    const result = await runPreflight(env, tripwireClient(() => inspection).client);
    assert.equal(result.status, "ready", String(generation));
    assert.deepEqual(result.reasons, [], String(generation));
    assert.equal(result.target.expectedGeneration, generation);
    assert.equal(result.observed?.binding.generation, echoed, String(generation));
  }
});

test("R1 limit: an ID that is itself an integer inside the echo range can coincide with a reading", async () => {
  // Stated, not hidden: the rule bounds what a numeric field can carry to
  // -1..99999. It cannot tell a reading of 4 from a configured ID of "4".
  const fixture = loadFixtureCase(casePath("ready"));
  const env = { ...fixture.env, CASTLES_SANDBOX_ID: "4" };
  const inspection = structuredClone(fixture.inspection) as any;
  inspection.body.record.sandboxId = "4";
  inspection.body.observed.cpu = 4;
  const result = await runPreflight(env, tripwireClient(() => inspection).client);
  assert.equal(result.status, "ready");
  assert.equal(result.observed?.resources.cpu, 4);
});

test("N4: the volume count is echoed only as an integer from 0 to 999", async () => {
  // The same leak class as R1, in a field that is not one of the nine
  // (review rv11 N4). v1 reports volumes as a count, so the count itself is
  // the reported value: anything that is not an integer from 0 up is
  // refused as an attachment and not echoed.
  const fixture = loadFixtureCase(casePath("ready"));
  const digits = "900719925474";
  const env = { ...fixture.env, CASTLES_SANDBOX_ID: digits };
  const lengths: [string, unknown, number | null, string, string[]][] = [
    ["minus the ID", -Number(digits), null, "incompatible", ["volumes_present"]],
    ["-1", -1, null, "incompatible", ["volumes_present"]],
    ["the ID as a fraction", Number(`0.${digits}`), null, "incompatible", ["volumes_present"]],
    ["the ID as text", digits, null, "incompatible", ["volumes_present"]],
    ["not a number", Number.NaN, null, "incompatible", ["volumes_present"]],
    ["0", 0, 0, "ready", []],
    ["5", 5, 5, "incompatible", ["volumes_present"]],
    ["999", 999, 999, "incompatible", ["volumes_present"]],
    ["the ID", Number(digits), 999, "incompatible", ["volumes_present"]],
  ];
  for (const [label, length, echoed, status, expected] of lengths) {
    const inspection = structuredClone(fixture.inspection) as any;
    inspection.body.record.sandboxId = digits;
    inspection.body.observed.volumes = length;
    const result = await runPreflight(env, tripwireClient(() => inspection).client);
    // A length that is not an integer from 0 up is refused, not read as "no
    // volume", and is not echoed as a count (PR #11 question 11, review N9).
    assert.equal(result.status, status, label);
    assert.deepEqual(codes(result), expected, label);
    assert.equal(result.observed?.attachments.volumes, echoed, label);
    for (const output of [renderJson(result), renderHuman(result)]) {
      assert.ok(!output.includes(digits), label);
    }
  }
  // A count is echoed as itself, capped at 999.
  for (const [volumes, echoed] of [
    [0, 0],
    [1, 1],
    [1_500, 999],
  ] as const) {
    const inspection = structuredClone(fixture.inspection) as any;
    inspection.body.observed.volumes = volumes;
    const result = await runPreflight(fixture.env, tripwireClient(() => inspection).client);
    assert.equal(result.observed?.attachments.volumes, echoed);
  }
});

test("Q11: an array whose length is not an integer from 0 up is an attachment, never \"no volume\"", async () => {
  // PR #11 question 11 and review rv11 N9. The policy used to read every
  // length not greater than 0 as "no volume": a negative number, NaN, and a
  // zero or negative bigint (which made the check reject at 13ab3bc and
  // return ready at fa95bbc). v1 reports a count instead of an array, and
  // the same rule holds for it: a count that is not an integer from 0 up is
  // refused as an attachment, and none is echoed. Null and absent are
  // missing metadata.
  const lengths: [string, unknown][] = [
    ["0n", 0n],
    ["-5n", -5n],
    ["5n", 5n],
    ["-1", -1],
    ["-0.5", -0.5],
    ["0.5", 0.5],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-2^53", -(2 ** 53)],
    ["2^53", 2 ** 53],
    ['"0"', "0"],
    ['""', ""],
    ['"abc"', "abc"],
    ["false", false],
    ["true", true],
    ["an object", {}],
    ["a symbol", Symbol("length")],
  ];
  for (const [label, length] of lengths) {
    const result = await withSandbox((sandbox) => {
      sandbox.volumes = length;
    });
    assert.equal(result.status, "incompatible", label);
    assert.deepEqual(result.reasons, [{ code: "volumes_present", field: "volumes" }], label);
    assert.equal(result.observed?.attachments.volumes, null, label);
  }
  // A boxed number is not plain data, so the whole answer is refused, and
  // it is never "no volume" either (v1 review tests).
  const boxed = await withSandbox((sandbox) => {
    sandbox.volumes = Object(0);
  });
  assert.deepEqual(codes(boxed), ["inspection_contract_violation"]);
  for (const length of [null, undefined]) {
    const result = await withSandbox((sandbox) => {
      sandbox.volumes = length;
    });
    assert.deepEqual(result.reasons, [{ code: "metadata_missing", field: "volumes" }], String(length));
    assert.equal(result.observed?.attachments.volumes, null, String(length));
  }
  // An integer from 0 up is read as before: 0 is no volume, more is one.
  for (const [length, status, echoed] of [
    [0, "ready", 0],
    [1, "incompatible", 1],
    [1_500, "incompatible", 999],
  ] as const) {
    const result = await withSandbox((sandbox) => {
      sandbox.volumes = length;
    });
    assert.equal(result.status, status, String(length));
    assert.equal(result.observed?.attachments.volumes, echoed, String(length));
  }
});

// --- Test gaps found by mutation (review N5, N6, N7) ------------------------
// Behaviour was already correct for every case below; these pin it.

const VALID_ENV = Object.freeze({
  CASTLES_OWNER_AGENT_ID: "fixture-agent-0001",
  CASTLES_PROFILE: "castles.daytona-private-linux.v1",
  CASTLES_SANDBOX_GENERATION: "3",
  CASTLES_SANDBOX_ID: "fixture-sandbox-0001",
});

const BAD_IDENTIFIERS = [
  "*",
  "fixture-*",
  "name:fixture-sandbox",
  "fixture sandbox",
  " fixture-sandbox",
  "fixture-sandbox ",
  "fixture-sandbox\n",
  "\nfixture-sandbox",
  "!fixture-sandbox",
  "fixture-sandbox!",
  "-fixture-sandbox",
  "_fixture-sandbox",
  "fixture.sandbox",
  "fixture/sandbox",
  "fixturé-sandbox",
  "ｆixture-sandbox",
  "f".repeat(129),
];
const GOOD_IDENTIFIERS = ["f", "F_x-9", "0abc", "f".repeat(128)];
const BAD_GENERATIONS = [
  "03",
  "00",
  "-1",
  "+1",
  "3.0",
  "1e3",
  "0x1",
  " 3",
  "3 ",
  "3\n",
  "x3",
  "3x",
  "３",
  "٣",
  "1234567890",
];
const GOOD_GENERATIONS: [string, number][] = [
  ["0", 0],
  ["3", 3],
  ["10", 10],
  ["999999999", 999_999_999],
];

test("binding: a complete, exact binding parses to exactly those values", () => {
  assert.deepEqual(parseBinding(VALID_ENV), {
    binding: {
      agentId: "fixture-agent-0001",
      expectedGeneration: 3,
      profile: "castles.daytona-private-linux.v1",
      sandboxId: "fixture-sandbox-0001",
    },
    ok: true,
  });
  for (const id of GOOD_IDENTIFIERS) {
    for (const key of ["CASTLES_SANDBOX_ID", "CASTLES_OWNER_AGENT_ID"]) {
      assert.equal(parseBinding({ ...VALID_ENV, [key]: id }).ok, true, id);
    }
  }
  for (const [text, value] of GOOD_GENERATIONS) {
    const parsed = parseBinding({
      ...VALID_ENV,
      CASTLES_SANDBOX_GENERATION: text,
    });
    assert.equal(parsed.ok && parsed.binding.expectedGeneration, value, text);
  }
});

test("binding: every malformed identifier or generation is refused with its own code", async () => {
  const table: [keyof typeof VALID_ENV, readonly string[], string][] = [
    ["CASTLES_SANDBOX_ID", BAD_IDENTIFIERS, "sandbox_id_invalid"],
    ["CASTLES_OWNER_AGENT_ID", BAD_IDENTIFIERS, "owner_binding_invalid"],
    ["CASTLES_SANDBOX_GENERATION", BAD_GENERATIONS, "generation_invalid"],
  ];
  for (const [key, values, problem] of table) {
    for (const value of values) {
      const where = `${key}=${JSON.stringify(value)}`;
      const parsed = parseBinding({ ...VALID_ENV, [key]: value });
      assert.equal(parsed.ok, false, where);
      assert.equal(!parsed.ok && parsed.problem, problem, where);
      const wire = tripwireClient(() => ({}));
      const result = await runPreflight(
        { ...VALID_ENV, [key]: value },
        wire.client
      );
      assert.equal(result.status, "unavailable", where);
      assert.deepEqual(result.reasons, [{ code: problem }], where);
      assert.deepEqual(wire.calls, [], where);
      assert.equal(result.observed, null, where);
    }
  }
});

test("binding: each missing value has its own code, checked in a fixed order", async () => {
  const table: [keyof typeof VALID_ENV, string, string][] = [
    ["CASTLES_SANDBOX_ID", "sandbox_id_missing", "unavailable"],
    ["CASTLES_PROFILE", "profile_missing", "incompatible"],
    ["CASTLES_OWNER_AGENT_ID", "owner_binding_missing", "unavailable"],
    ["CASTLES_SANDBOX_GENERATION", "generation_missing", "unavailable"],
  ];
  for (const [key, problem, status] of table) {
    for (const absent of [undefined, ""]) {
      const env = { ...VALID_ENV, [key]: absent };
      const parsed = parseBinding(env);
      assert.equal(!parsed.ok && parsed.problem, problem, key);
      const wire = tripwireClient(() => ({}));
      const result = await runPreflight(env, wire.client);
      assert.equal(result.status, status, key);
      assert.deepEqual(result.reasons, [{ code: problem }], key);
      assert.deepEqual(wire.calls, [], key);
    }
  }
  const unknown = await runPreflight(
    { ...VALID_ENV, CASTLES_PROFILE: "castles.daytona-private-linux.v2" },
    null
  );
  assert.equal(unknown.status, "incompatible");
  assert.deepEqual(unknown.reasons, [{ code: "unknown_profile" }]);

  // Order: sandbox ID, profile, owner, generation. The first problem wins.
  const order = table.map(([key]) => key);
  for (let first = 0; first < order.length; first += 1) {
    const env: Record<string, string | undefined> = { ...VALID_ENV };
    for (const key of order.slice(first)) {
      env[key] = undefined;
    }
    const parsed = parseBinding(env);
    assert.equal(!parsed.ok && parsed.problem, table[first]?.[1]);
  }
  // Only values that parsed are aliased; a refused value is not.
  const partial = await runPreflight(
    { ...VALID_ENV, CASTLES_OWNER_AGENT_ID: "bad owner" },
    null
  );
  assert.match(String(partial.target.sandboxAlias), /^sbx_[0-9a-f]{12}$/u);
  assert.equal(partial.target.ownerAlias, null);
  assert.equal(partial.target.expectedGeneration, null);
});

const REQUIRED_METADATA: [string, (inspection: any, value: unknown) => void, unknown[]][] = [
  ["state", (i, v) => (i.observed.state = v), [7, true, {}]],
  ["public", (i, v) => (i.observed.public = v), ["false", 0, "no"]],
  ["networkBlockAll", (i, v) => (i.observed.networkBlockAll = v), ["false", 0]],
  ["domainAllowListConfigured", (i, v) => (i.observed.domainAllowListConfigured = v), ["true", 1]],
  ["domainAllowListMatchesPolicy", (i, v) => (i.observed.domainAllowListMatchesPolicy = v), ["true", 1]],
  ["networkAllowListConfigured", (i, v) => (i.observed.networkAllowListConfigured = v), ["false", 0]],
  ["outboundProxyConfigured", (i, v) => (i.observed.outboundProxyConfigured = v), ["false", 0]],
  ["autoStopInterval", (i, v) => (i.observed.autoStopInterval = v), ["15", 15.5, Number.NaN]],
  ["autoArchiveInterval", (i, v) => (i.observed.autoArchiveInterval = v), ["10080", 60.5]],
  ["autoDeleteInterval", (i, v) => (i.observed.autoDeleteInterval = v), ["-1", -1.5]],
  ["autoPauseInterval", (i, v) => (i.observed.autoPauseInterval = v), ["0", 0.5, false]],
  ["autoDestroyAtConfigured", (i, v) => (i.observed.autoDestroyAtConfigured = v), ["false", 0]],
  ["snapshot", (i, v) => (i.observed.snapshot = v), [2, ["coven-agents-copilot-2"]]],
  ["target", (i, v) => (i.observed.target = v), [1, ["us"]]],
  ["cpu", (i, v) => (i.observed.cpu = v), ["2", 2.5]],
  ["memoryGib", (i, v) => (i.observed.memoryGib = v), ["4", 4.5]],
  ["diskGib", (i, v) => (i.observed.diskGib = v), ["10", 10.5]],
  ["gpu", (i, v) => (i.observed.gpu = v), ["0", 0.5, false]],
  ["warmPool", (i, v) => (i.observed.warmPool = v), ["false", 0]],
  ["linkedSandbox", (i, v) => (i.observed.linkedSandbox = v), ["false", 0]],
];

test("each required metadata field, when absent, null or mistyped, fails closed on its own", async () => {
  for (const [field, set, mistyped] of REQUIRED_METADATA) {
    for (const value of [undefined, null, ...mistyped]) {
      const result = await withInspection((inspection) => set(inspection, value));
      const where = `${field}=${String(value)}`;
      assert.equal(result.status, "incompatible", where);
      assert.deepEqual(
        result.reasons,
        [{ code: "metadata_missing", field }],
        where
      );
    }
  }
});

test("inspection parsing: a wrong version, an unknown outcome or a mistyped record is a contract violation", async () => {
  const edits: [string, (inspection: any) => void][] = [
    ["version absent", (i) => delete i.version],
    ["version 0", (i) => (i.version = 0)],
    ["version 2", (i) => (i.version = 2)],
    ["version text", (i) => (i.version = "1")],
    ["version array", (i) => (i.version = [1])],
    ["the earlier contract label", (i) => (i.contract = "castles.fixture.sandbox-inspection.v1")],
    ["outcome absent", (i) => delete i.outcome],
    ["outcome null", (i) => (i.outcome = null)],
    ["outcome unknown", (i) => (i.outcome = "ok")],
    ["outcome cased", (i) => (i.outcome = "Observed")],
    ["outcome ready", (i) => (i.outcome = "ready")],
    ["outcome number", (i) => (i.outcome = 1)],
    ["generation float", (i) => (i.record.generation = 3.5)],
    ["generation string", (i) => (i.record.generation = "3")],
    ["generation null", (i) => (i.record.generation = null)],
    ["generation absent", (i) => delete i.record.generation],
    ["generation NaN", (i) => (i.record.generation = Number.NaN)],
    ["generation unsafe", (i) => (i.record.generation = 2 ** 53)],
    ["generation negative", (i) => (i.record.generation = -1)],
    ["record absent", (i) => delete i.record],
    ["record array", (i) => (i.record = [])],
    ["record.sandboxId number", (i) => (i.record.sandboxId = 1)],
    ["record.sandboxId absent", (i) => delete i.record.sandboxId],
    ["record.agentId number", (i) => (i.record.agentId = 1)],
    ["record.lifecycle absent", (i) => delete i.record.lifecycle],
    ["record.lifecycle boolean", (i) => (i.record.lifecycle = true)],
    ["record.fence absent", (i) => delete i.record.fence],
    ["record.fence null", (i) => (i.record.fence = null)],
    ["observed absent", (i) => delete i.observed],
    ["observed array", (i) => (i.observed = [])],
    ["identity absent", (i) => delete i.observed.identity],
    ["identity string", (i) => (i.observed.identity = "current")],
    ["policy absent", (i) => delete i.policy],
    ["policy string", (i) => (i.policy = "0.231.1")],
  ];
  for (const [label, edit] of edits) {
    const result = await withInspection(edit);
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(
      result.reasons,
      [{ code: "inspection_contract_violation" }],
      label
    );
    assert.equal(result.observed, null, label);
    assert.equal(result.providerCalls.inspect, 1, label);
  }
});

test("inspection parsing: each refusal outcome maps to one status and code, and needs the version", async () => {
  const table: [Record<string, unknown>, string, string][] = [
    [
      {
        outcome: "not_found",
        policy: v1Ready().body.policy,
        record: { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" },
      },
      "unavailable",
      "sandbox_not_found",
    ],
    [{ outcome: "ambiguous", reason: "no_recorded_sandbox", record: V1_DB_RECORD }, "reconciliation-required", "ambiguous_lookup"],
    [{ outcome: "unavailable", source: "provider" }, "unavailable", "provider_unavailable"],
    [{ outcome: "unauthorized" }, "unauthorized", "owner_mismatch"],
    // A reason v1 does not define is not read, and not echoed.
    [{ outcome: "ambiguous", reason: CANARY, record: V1_DB_RECORD }, "unavailable", "inspection_contract_violation"],
    // v1's unauthorized outcome has no reason: an extra key is a violation.
    [{ outcome: "unauthorized", reason: "owner_mismatch" }, "unavailable", "inspection_contract_violation"],
  ];
  for (const [body, status, code] of table) {
    const labelled = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ body: { ...body, version: 1 }, status: 200 })).client
    );
    assert.equal(labelled.status, status, code);
    assert.deepEqual(labelled.reasons, [{ code }]);
    assert.equal(labelled.observed, null);
    assert.doesNotMatch(renderJson(labelled), new RegExp(CANARY, "u"));

    const unlabelled = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ body, status: 200 })).client
    );
    assert.equal(unlabelled.status, "unavailable", code);
    assert.deepEqual(unlabelled.reasons, [
      { code: "inspection_contract_violation" },
    ]);
  }
});

test("a recorded generation that differs in either direction is stale", async () => {
  for (const generation of [0, 1, 2, 4, 9, 999_999_999]) {
    const result = await withInspection((inspection) => {
      inspection.record.generation = generation;
    });
    assert.equal(result.status, "reconciliation-required", String(generation));
    assert.deepEqual(result.reasons, [
      { code: "generation_mismatch", field: "record.generation" },
    ]);
  }
  // v1 has no negative generation, so -1 is a contract violation.
  const negative = await withInspection((inspection) => {
    inspection.record.generation = -1;
  });
  assert.deepEqual(codes(negative), ["inspection_contract_violation"]);
  const same = await withInspection((inspection) => {
    inspection.record.generation = 3;
  });
  assert.equal(same.status, "ready");
});

test("an attempt fence other than none needs reconciliation", async () => {
  for (const fence of ["cleanup_required", "attempt_outstanding", "held", "", "None", "none ", "clear"]) {
    const result = await withInspection((inspection) => {
      inspection.record.fence = fence;
    });
    assert.equal(result.status, "reconciliation-required", fence);
    assert.deepEqual(result.reasons, [
      { code: "attempt_fence_held", field: "record.fence" },
    ]);
  }
});

test("policy: the supported profile is exactly these literal values", () => {
  // Written out, not derived: widening any bound in src/profile.ts must
  // turn this red.
  assert.deepEqual(SUPPORTED_PROFILE, {
    credentialBoundaryVersion: "attempt-reset-v1",
    id: "castles.daytona-private-linux.v1",
    image: {
      base: "node:22-bookworm-slim",
      qualifiedSnapshot: "coven-agents-copilot-2",
    },
    lifecycle: {
      autoArchiveMinutes: { max: 43_200, min: 60 },
      autoDeleteInterval: -1,
      autoPauseInterval: 0,
      autoStopMinutes: { max: 60, min: 5 },
      ttl: "disabled",
    },
    network: {
      domainAllowList: { basis: "owner-policy-equality" },
      egress: "restricted",
      networkAllowList: { basis: "owner-policy-sets-none", configured: "refused" },
      outboundProxy: { basis: "owner-policy-sets-none", configured: "refused" },
      public: false,
    },
    platform: { architecture: "not-pinned", basis: "qualified-snapshot", os: "linux" },
    provider: "daytona",
    resources: {
      caps: { cpu: 4, diskGiB: 10, memoryGiB: 8 },
      floor: { cpu: 1, diskGiB: 10, memoryGiB: 1 },
      target: { cpu: 2, diskGiB: 10, memoryGiB: 4 },
    },
    sdk: { package: "@daytona/sdk", version: "0.231.1" },
    targets: ["us", "eu"],
  });
});

test("policy: each numeric bound is enforced at literal edges", async () => {
  type Edge = [string, number, "ready" | "incompatible", string?];
  const edges: Edge[] = [
    ["autoStopInterval", 4, "incompatible", "lifecycle_auto_stop"],
    ["autoStopInterval", 5, "ready"],
    ["autoStopInterval", 60, "ready"],
    ["autoStopInterval", 61, "incompatible", "lifecycle_auto_stop"],
    ["autoStopInterval", 600, "incompatible", "lifecycle_auto_stop"],
    ["autoStopInterval", 0, "incompatible", "lifecycle_auto_stop"],
    ["autoArchiveInterval", 59, "incompatible", "lifecycle_auto_archive"],
    ["autoArchiveInterval", 60, "ready"],
    ["autoArchiveInterval", 43_200, "ready"],
    ["autoArchiveInterval", 43_201, "incompatible", "lifecycle_auto_archive"],
    ["autoArchiveInterval", 432_000, "incompatible", "lifecycle_auto_archive"],
    ["autoArchiveInterval", 0, "incompatible", "lifecycle_auto_archive"],
    ["autoDeleteInterval", -1, "ready"],
    ["autoDeleteInterval", 0, "incompatible", "lifecycle_auto_delete"],
    ["autoDeleteInterval", 1, "incompatible", "lifecycle_auto_delete"],
    ["autoDeleteInterval", -2, "incompatible", "lifecycle_auto_delete"],
    ["autoPauseInterval", 0, "ready"],
    ["autoPauseInterval", 1, "incompatible", "lifecycle_auto_pause"],
    ["autoPauseInterval", -1, "incompatible", "lifecycle_auto_pause"],
    ["cpu", 0, "incompatible", "resources_out_of_policy"],
    ["cpu", 1, "ready"],
    ["cpu", 4, "ready"],
    ["cpu", 5, "incompatible", "resources_out_of_policy"],
    ["memoryGib", 0, "incompatible", "resources_out_of_policy"],
    ["memoryGib", 1, "ready"],
    ["memoryGib", 8, "ready"],
    ["memoryGib", 9, "incompatible", "resources_out_of_policy"],
    ["diskGib", 9, "incompatible", "resources_out_of_policy"],
    ["diskGib", 10, "ready"],
    ["diskGib", 11, "incompatible", "resources_out_of_policy"],
    ["gpu", 0, "ready"],
    ["gpu", 1, "incompatible", "gpu_present"],
    ["gpu", -1, "incompatible", "gpu_present"],
  ];
  for (const [field, value, status, code] of edges) {
    const result = await withSandbox((sandbox) => {
      sandbox[field] = value;
    });
    assert.equal(result.status, status, `${field}=${value}`);
    assert.deepEqual(codes(result), code ? [code] : [], `${field}=${value}`);
  }
  const target = await withSandbox(() => undefined);
  assert.equal(target.observed?.resources.matchesTarget, true);
  for (const [field, value] of [["cpu", 4], ["memoryGib", 8], ["cpu", 1]] as const) {
    const off = await withSandbox((sandbox) => {
      sandbox[field] = value;
    });
    assert.equal(off.status, "ready");
    assert.equal(off.observed?.resources.matchesTarget, false, field);
  }
});

test("pins: the upstream revision and the pinned paths are these literals", () => {
  const prefix =
    "OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502:";
  assert.deepEqual(
    SOURCE_PINS.map((entry) => entry.pin),
    [
      "package.json",
      "pnpm-lock.yaml",
      "packages/agent-contracts/package.json",
      "lib/runner/daytona/resource-policy.ts",
      "lib/runner/daytona/config.ts",
      "lib/runner/daytona/sandbox.ts",
      "lib/runner/daytona/resource-inventory.ts",
      "lib/runner/daytona/snapshot-name.ts",
      "lib/runner/daytona/image.ts",
      "lib/runner/resource-lifecycle.ts",
      "lib/runner/types.ts",
      "lib/runner/daytona/resource-repair.ts",
      "lib/runner/daytona/resource-recovery.ts",
      "lib/runner/diagnostics.ts",
      "lib/runner/daytona/process.ts",
      "docs/architecture/adr-002-daytona-execution-boundary.md",
      "docs/product/cloud-pilot-integration.md",
      ".env.example",
      "packages/agent-contracts/src/sandbox-inspection.ts",
      "lib/runner/sandbox-inspection-http.ts",
      "lib/runner/transport.ts",
      "lib/runner/daytona/resource-inspection.ts",
    ].map((path) => prefix + path)
  );
  assert.equal(
    UPSTREAM_SEAM.issue,
    "https://github.com/OpenCoven/coven-agents/issues/296"
  );
});

test("status precedence: unauthorized, reconciliation-required, incompatible, unavailable, stopped, ready", async () => {
  type Finding = [status: string, code: string, edit: (inspection: any) => void];
  const unauthorized: Finding = [
    "unauthorized",
    "binding_mismatch",
    (i) => (i.record.sandboxId = "fixture-sandbox-9999"),
  ];
  // v1 answers a returned-ID mismatch as its own outcome, so it can no
  // longer combine with another finding; upstream's ownership-label check is
  // the second identity finding instead.
  const labels: Finding = [
    "unauthorized",
    "owner_mismatch",
    (i) => (i.observed.identity.ownershipLabels = false),
  ];
  const stale: Finding = [
    "reconciliation-required",
    "generation_mismatch",
    (i) => (i.record.generation = 2),
  ];
  const exposed: Finding = [
    "incompatible",
    "public_exposure",
    (i) => (i.observed.public = true),
  ];
  const unsettled: Finding = [
    "unavailable",
    "lifecycle_not_settled",
    (i) => (i.observed.state = "transitioning"),
  ];
  const destroyed: Finding = [
    "unavailable",
    "sandbox_destroyed",
    (i) => (i.observed.state = "destroyed"),
  ];
  const stopped: Finding = [
    "stopped",
    "sandbox_stopped",
    (i) => (i.observed.state = "stopped"),
  ];
  // Each row lists findings from highest to lowest priority. Reasons must be
  // reported in that order whatever order the edits were applied in.
  const rows: Finding[][] = [
    [unauthorized, labels],
    [stale, exposed],
    [stale, unsettled],
    [stale, destroyed],
    [stale, stopped],
    [exposed, unsettled],
    [exposed, destroyed],
    [exposed, stopped],
    [stale, exposed, unsettled],
    [stale, exposed, stopped],
    [unsettled],
    [destroyed],
    [stopped],
    [],
  ];
  for (const row of rows) {
    for (const ordered of [row, [...row].reverse()]) {
      const result = await withInspection((inspection) => {
        for (const [, , edit] of ordered) {
          edit(inspection);
        }
      });
      const label = row.map(([, code]) => code).join(" > ") || "none";
      assert.equal(result.status, row[0]?.[0] ?? "ready", label);
      assert.deepEqual(codes(result), row.map(([, code]) => code), label);
    }
  }
  // unavailable and stopped both come from the one state field, so no input
  // carries both; their relative order is not observable through the API.
});

test("egress: no usable restriction at all is unrestricted; block-all alone is restricted", async () => {
  // Every row states each comparison: an unstated one is missing metadata,
  // not "no list" (see the v1 egress test).
  const open = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = false;
    sandbox.domainAllowListConfigured = false;
    sandbox.networkAllowListConfigured = false;
  });
  assert.equal(open.status, "incompatible");
  assert.deepEqual(open.reasons, [
    { code: "egress_unrestricted", field: "egress" },
  ]);
  assert.equal(open.observed?.exposure.domainAllowListConfigured, false);

  const blocked = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = true;
    sandbox.domainAllowListConfigured = false;
    sandbox.networkAllowListConfigured = false;
  });
  assert.equal(blocked.status, "ready");
  assert.equal(blocked.observed?.exposure.networkBlockAll, true);

  // A configured domain list equal to the owner's policy is a restriction.
  const listed = await withSandbox(() => undefined);
  assert.equal(listed.status, "ready");
  assert.equal(listed.observed?.exposure.domainAllowListConfigured, true);
  assert.equal(listed.observed?.exposure.domainAllowListMatchesPolicy, true);
});

test("a fixture case contributes only the four binding keys to the environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "castles-env-"));
  try {
    const path = join(directory, "case.json");
    const original = JSON.parse(readFileSync(casePath("ready"), "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        env: { ...original.env, CASTLES_EXTRA: "x", DAYTONA_API_KEY: CANARY },
      })
    );
    assert.deepEqual(loadFixtureCase(path).env, original.env);
    assert.deepEqual(Object.keys(original.env).sort(), [
      "CASTLES_OWNER_AGENT_ID",
      "CASTLES_PROFILE",
      "CASTLES_SANDBOX_GENERATION",
      "CASTLES_SANDBOX_ID",
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function worstCase() {
  return withInspection((inspection) => {
    inspection.record.generation = 2;
    inspection.record.lifecycle = CANARY;
    inspection.record.fence = CANARY;
    inspection.policy = {
      ...inspection.policy,
      credentialBoundaryVersion: CANARY,
      sdkVersion: CANARY,
    };
    inspection.observed = {
      autoArchiveInterval: 1,
      autoDeleteInterval: 1,
      autoDestroyAtConfigured: true,
      autoPauseInterval: 1,
      autoStopInterval: 1,
      cpu: 99,
      diskGib: 99,
      domainAllowListConfigured: true,
      domainAllowListMatchesPolicy: false,
      gpu: 9,
      identity: {
        configuration: "prior",
        credentialBoundary: false,
        generationLabel: false,
        ownershipLabels: true,
      },
      linkedSandbox: true,
      memoryGib: 99,
      networkAllowListConfigured: true,
      networkBlockAll: CANARY,
      outboundProxyConfigured: true,
      public: true,
      snapshot: CANARY,
      state: CANARY,
      target: CANARY,
      volumes: 5000,
      warmPool: true,
    };
  });
}

test("reasons are capped at exactly 16, highest priority first, and the JSON stays bounded", async () => {
  const result = await worstCase();
  // 6 reconciliation findings and more than 10 compatibility findings exist.
  assert.equal(result.reasons.length, 16);
  assert.deepEqual(codes(result).slice(0, 7), [
    "generation_mismatch",
    "generation_mismatch",
    "binding_lifecycle_pending",
    "attempt_fence_held",
    "credential_boundary_unverified",
    "credential_boundary_unverified",
    "sdk_generation_mismatch",
  ]);
  assert.equal(result.status, "reconciliation-required");
  assert.equal(result.observed?.attachments.volumes, 999);
  assert.equal(PREFLIGHT_JSON_MAX_BYTES, 16_384);
  for (const output of [renderJson(result), renderHuman(result)]) {
    assert.doesNotMatch(output, /canary/iu);
    assert.doesNotMatch(output, /fixture-(?:sandbox|agent)-\d+/u);
    assert.ok(Buffer.byteLength(output) <= 8192, String(output.length));
  }
  assert.equal(renderHuman(result).split("\n").length <= 32, true);
});

test("every string in observed output is drawn from a fixed vocabulary", async () => {
  const vocabulary =
    /^(?:unrecognised|absent|present|[a-z_]{2,24}|coven-agents-copilot-2|\d{1,4}\.\d{1,4}\.\d{1,4})$/u;
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      strings.push(value);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  for (const result of [await worstCase(), (await runCase("ready")).result]) {
    walk(result.observed);
  }
  assert.ok(strings.length >= 16);
  for (const value of strings) {
    assert.match(value, vocabulary);
  }
});

// --- Contract pins and mutation owners -------------------------------------

test("source pins are exact repo@sha:path references", () => {
  assert.ok(SOURCE_PINS.length > 0);
  for (const { pin } of SOURCE_PINS) {
    assert.match(pin, /^OpenCoven\/[a-z-]+@[0-9a-f]{40}:[\w./-]+$/u);
  }
  assert.equal(SUPPORTED_PROFILE.sdk.package, "@daytona/sdk");
  assert.equal(SUPPORTED_PROFILE.sdk.version, "0.231.1");
});

test("every provider mutation names its existing upstream owner, and none is Castles", () => {
  // Literal on purpose: the table is compared with what was read at the pin.
  const at = (path: string) =>
    `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502:${path}`;
  assert.deepEqual(
    MUTATION_OWNERS.map((entry) => [entry.mutation, entry.owner]),
    [
      ["create", at("lib/runner/daytona/sandbox.ts")],
      ["start", at("lib/runner/daytona/sandbox.ts")],
      ["stop", at("lib/runner/daytona/sandbox.ts")],
      ["archive", at("lib/runner/daytona/sandbox.ts")],
      ["resize", at("lib/runner/daytona/resource-repair.ts")],
      ["delete", at("lib/runner/daytona/sandbox.ts")],
      ["reset", at("lib/runner/daytona/sandbox.ts")],
      ["adopt-policy", at("lib/runner/daytona/sandbox.ts")],
      ["diagnostic-create", at("lib/runner/diagnostics.ts")],
      ["diagnostic-delete", at("lib/runner/diagnostics.ts")],
    ]
  );
  const pinned = new Set(SOURCE_PINS.map((entry) => entry.pin as string));
  for (const entry of MUTATION_OWNERS) {
    assert.equal(entry.castles, "never");
    assert.ok(entry.via.length > 0);
    assert.ok(pinned.has(entry.owner), `${entry.mutation} owner is a source pin`);
  }
});

test("operations outside the listed mutations are named, not implied", () => {
  assert.deepEqual(
    OUTSIDE_LISTED_MUTATIONS.map((entry) => [entry.operation, entry.at]),
    [
      [
        "command execution inside a sandbox",
        "OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502:lib/runner/daytona/process.ts",
      ],
      [
        "snapshot creation",
        "OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502:lib/runner/daytona/image.ts",
      ],
    ]
  );
  for (const entry of OUTSIDE_LISTED_MUTATIONS) {
    assert.equal(entry.castles, "never");
  }
});

test("the missing upstream binding seam is an explicit blocker with a link", () => {
  assert.equal(UPSTREAM_SEAM.status, "missing");
  assert.match(
    UPSTREAM_SEAM.issue,
    /^https:\/\/github\.com\/OpenCoven\/coven-agents\/issues\/\d+$/u
  );
});

// --- Test gaps found by mutation (review rv6c-3db7f9d0, R4) -----------------
// Behaviour was already correct for every case below; these pin it. Each
// test names the single-edit mutation of src/ that it exists to catch.

test("R4 sdk version: each part has at most four digits and nothing follows the version", async () => {
  const withVersion = (version: string) =>
    withInspection((inspection) => {
      inspection.policy.sdkVersion = version;
    });
  // Mutation: version parts of up to 31 digits.
  for (const version of ["9999.9999.9999", "1000.0.0", "0.1000.0", "0.0.1000"]) {
    const result = await withVersion(version);
    assert.equal(result.observed?.sdk.version, version, version);
  }
  const pinned = await withVersion("0.231.1");
  assert.equal(pinned.status, "ready");
  assert.equal(pinned.observed?.sdk.version, "0.231.1");
  const lines = renderHuman(pinned).split("\n").length;

  // Mutation: a multi-line flag on the version pattern, which would echo a
  // valid version followed by a newline and any text.
  const refused = [
    "10000.0.0",
    "0.10000.0",
    "0.0.10000",
    "12345678901234567890.0.0",
    "0.231.1234567890123456789012345678901",
    "0.231.1\n",
    "\n0.231.1",
    "0.231.1\nfixture-free-text",
    "fixture-free-text\n0.231.1",
    "0.231.1\r\nfixture-free-text",
    "0.231.1\rfixture-free-text",
    "0.231.1\u2028fixture-free-text",
    "0.231.1\u2029fixture-free-text",
    "0.231.1 ",
    " 0.231.1",
    "0.231.1\t",
    "0.231.1\u0000",
  ];
  for (const version of refused) {
    const where = JSON.stringify(version);
    const result = await withVersion(version);
    assert.equal(result.observed?.sdk.version, "unrecognised", where);
    assert.equal(result.status, "incompatible", where);
    assert.deepEqual(
      result.reasons,
      [{ code: "sdk_generation_mismatch", field: "policy.sdkVersion" }],
      where
    );
    const human = renderHuman(result);
    const json = renderJson(result);
    assert.match(human, /; server sdk unrecognised\n/u, where);
    assert.equal(JSON.parse(json).observed.sdk.version, "unrecognised", where);
    // One reason heading and one reason line more than the ready output,
    // and no line supplied by the response.
    assert.equal(human.split("\n").length, lines + 2, where);
    for (const output of [human, json]) {
      assert.doesNotMatch(output, /free-text/u, where);
      assert.doesNotMatch(output, /[\r\u2028\u2029\u0000\t]/u, where);
    }
  }
});

// Written out, not derived from src/: removing a member from a set in
// src/preflight.ts, or accepting a value from another set, must turn the two
// tests below red. These are the values upstream may send; ECHO_AS names the
// one that Castles echoes under its own word. v1 reports no platform, so the
// architecture set and its open `x64` question are gone with it.
const ECHO_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  "observed.snapshot": ["coven-agents-copilot-2"],
  "observed.state": [
    "started",
    "stopped",
    "archived",
    "transitioning",
    "error",
    "destroyed",
    "unknown",
  ],
  "observed.target": ["us", "eu"],
  "record.fence": ["none", "attempt_outstanding", "cleanup_required"],
  "record.lifecycle": [
    "unprovisioned",
    "provisioning",
    "provisioning_ambiguous",
    "ready",
    "resizing",
    "resetting",
    "decommissioning",
    "decommission_failed",
  ],
};
/** Upstream's `none` fence is echoed as Castles' existing `clear`. */
const ECHO_AS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "record.fence": { none: "clear" },
};
const ECHO_READERS: Readonly<
  Record<string, (result: PreflightResult) => unknown>
> = {
  "observed.snapshot": (r) => r.observed?.image.snapshot,
  "observed.state": (r) => r.observed?.state,
  "observed.target": (r) => r.observed?.target,
  "record.fence": (r) => r.observed?.binding.attemptFence,
  "record.lifecycle": (r) => r.observed?.binding.lifecycle,
};
// Plausible names that are in no set. An added member that is not listed
// here, and belongs to no other field's set, is not caught: the sets are not
// exported, so this test cannot compare them whole.
const ECHO_NEAR_MISSES = [
  "running",
  "active",
  "deleted",
  "deleting",
  "terminated",
  "suspended",
  "failed",
  "pending",
  "created",
  "queued",
  "held",
  "locked",
  "released",
  "fenced",
  "none",
  "clear",
  "open",
  "starting",
  "stopping",
  "archiving",
  "destroying",
  "creating",
  "paused",
  "build_failed",
  "busy",
  "i386",
  "arm",
  "armv7",
  "riscv64",
  "ppc64le",
  "s390x",
  "darwin",
  "windows",
  "win32",
  "freebsd",
  "ap",
  "asia",
  "local",
  "default",
  "coven-agents-copilot-1",
  "coven-agents-copilot-3",
  "coven-agents-copilot",
  "coven-agents-copilot-20",
];

test("R4 vocabulary: every member of every fixed set is echoed exactly", async () => {
  // Mutation: removing a sandbox state, a fence value or a binding lifecycle.
  const setters = new Map(ECHOED_FIELDS);
  let checked = 0;
  for (const [field, members] of Object.entries(ECHO_VOCABULARY)) {
    for (const member of members) {
      const result = await withInspection((inspection) =>
        setters.get(field)?.(inspection, member)
      );
      const echoed = ECHO_AS[field]?.[member] ?? member;
      assert.equal(ECHO_READERS[field]?.(result), echoed, `${field}=${member}`);
      checked += 1;
    }
  }
  assert.equal(checked, 1 + 7 + 2 + 3 + 8);
});

test("R4 vocabulary: a member of another field's set, a near miss or a variant spelling is unrecognised", async () => {
  // Mutation: adding a sandbox state or an attempt-fence value.
  const setters = new Map(ECHOED_FIELDS);
  const everyMember = Object.values(ECHO_VOCABULARY).flat();
  for (const [field, members] of Object.entries(ECHO_VOCABULARY)) {
    const variants = members.flatMap((member) => [
      member.toUpperCase(),
      `${member[0]?.toUpperCase()}${member.slice(1)}`,
      ` ${member}`,
      `${member} `,
      `${member}\n`,
      `${member}s`,
      `${member}_`,
      member.slice(0, -1),
    ]);
    const outside = new Set(
      [...everyMember, ...ECHO_NEAR_MISSES, ...variants, ""].filter(
        (value) => !members.includes(value)
      )
    );
    assert.ok(outside.size >= 60, field);
    for (const value of outside) {
      const where = `${field}=${JSON.stringify(value)}`;
      const result = await withInspection((inspection) =>
        setters.get(field)?.(inspection, value)
      );
      assert.equal(ECHO_READERS[field]?.(result), "unrecognised", where);
      assert.notEqual(result.status, "ready", where);
    }
  }
});

test("R4 evidence: every replayed outcome is fixture evidence, identity failures included", async () => {
  // Mutation: an identity failure reported as `none` instead of `fixture`.
  for (const name of [...FAIL_CLOSED_CASES, "ready", "stopped"]) {
    const { fixture, result } = await runCase(name);
    assert.equal(result.evidence, "fixture", name);
    assert.equal(result.providerCalls.inspect, fixture.expect.inspectCalls, name);
    assert.equal(isLiveReady(result), false, name);
  }
  const identity: [string, string, (inspection: any) => void][] = [
    ["owner_mismatch", "unauthorized", (i) => (i.record.agentId = "fixture-agent-9999")],
    ["binding_mismatch", "unauthorized", (i) => (i.record.sandboxId = "fixture-sandbox-9999")],
    ["binding_mismatch", "unauthorized", (i) => (i.record.sandboxId = null)],
    ["owner_mismatch", "unauthorized", (i) => (i.observed.identity.ownershipLabels = false)],
    ["binding_mismatch", "unauthorized", (i) => (i.observed.identity.configuration = "mismatch")],
    // v1 answers a returned-ID mismatch as its own ambiguous outcome.
    [
      "returned_id_mismatch",
      "reconciliation-required",
      (i) => {
        for (const key of Object.keys(i)) delete i[key];
        Object.assign(i, {
          outcome: "ambiguous",
          reason: "returned_id_mismatch",
          record: V1_DB_RECORD,
          version: 1,
        });
      },
    ],
  ];
  for (const [code, status, edit] of identity) {
    const result = await withInspection(edit);
    assert.equal(result.status, status, code);
    assert.deepEqual(codes(result), [code]);
    assert.equal(result.evidence, "fixture", code);
    assert.equal(result.providerCalls.inspect, 1, code);
    assert.equal(result.observed, null, code);
    assert.match(renderHuman(result), /^evidence: FIXTURE /mu, code);
    assert.equal(JSON.parse(renderJson(result)).evidence, "fixture", code);
  }
});

test("R4 owners: the whole mutation-owner table is these literal rows, `via` included", () => {
  // Mutation: the `via` text of a row. Written out, not derived.
  const at = (path: string) =>
    `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502:${path}`;
  const sandbox = at("lib/runner/daytona/sandbox.ts");
  const row = (mutation: string, owner: string, via: string) => ({
    castles: "never",
    mutation,
    owner,
    via,
  });
  assert.deepEqual(MUTATION_OWNERS, [
    row("create", sandbox, "ensureDaytonaSandbox / ensureDaytonaSandboxForDispatch"),
    row("start", sandbox, "ensureDaytonaSandbox* (start or recover on attach)"),
    row(
      "stop",
      sandbox,
      "provider auto-stop policy set at create; no application stop call at this pin"
    ),
    row(
      "archive",
      sandbox,
      "provider auto-archive policy set at create; no application archive call at this pin"
    ),
    row(
      "resize",
      at("lib/runner/daytona/resource-repair.ts"),
      "RunnerPersistentResourceLifecycle.repair"
    ),
    row(
      "delete",
      sandbox,
      "RunnerPersistentResourceLifecycle.decommission / recover (also resource-recovery.ts)"
    ),
    row("reset", sandbox, "RunnerPersistentResourceLifecycle.reset"),
    row(
      "adopt-policy",
      sandbox,
      "adoptDaytonaSandboxPolicy (labels, auto-stop, auto-archive)"
    ),
    row(
      "diagnostic-create",
      at("lib/runner/diagnostics.ts"),
      "diagnoseDaytonaSandbox (its own ephemeral diagnostic sandbox, 5 minute TTL)"
    ),
    row(
      "diagnostic-delete",
      at("lib/runner/diagnostics.ts"),
      "diagnoseDaytonaSandbox / runEphemeralDiagnostic (deletes the sandbox it created)"
    ),
  ]);
  assert.deepEqual(OUTSIDE_LISTED_MUTATIONS, [
    {
      at: at("lib/runner/daytona/process.ts"),
      castles: "never",
      operation: "command execution inside a sandbox",
    },
    {
      at: at("lib/runner/daytona/image.ts"),
      castles: "never",
      operation: "snapshot creation",
    },
  ]);
});

const afterMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Asserts that a check against a client that never answers is abandoned at
 * exactly `expectedMs` on a mocked clock: still pending one millisecond
 * earlier, `provider_unavailable` at the deadline.
 */
async function assertDeadline(
  context: { mock: { timers: { tick: (ms: number) => void } } },
  options: Parameters<typeof runPreflight>[2] | undefined,
  expectedMs: number,
  label: string
) {
  const client: SandboxInspectionClient = {
    inspectBoundSandbox: () => new Promise(() => undefined),
  };
  const seen: PreflightResult[] = [];
  const pending =
    options === undefined
      ? runPreflight(VALID_ENV, client)
      : runPreflight(VALID_ENV, client, options);
  void pending.then((result) => {
    seen.push(result);
  });
  await afterMicrotasks();
  context.mock.timers.tick(expectedMs - 1);
  await afterMicrotasks();
  assert.equal(seen.length, 0, `${label}: settled before ${expectedMs} ms`);
  context.mock.timers.tick(1);
  await afterMicrotasks();
  assert.equal(seen.length, 1, `${label}: not settled at ${expectedMs} ms`);
  const [settled] = seen;
  assert.equal(settled?.status, "unavailable", label);
  assert.deepEqual(settled?.reasons, [{ code: "provider_unavailable" }], label);
  assert.equal(settled?.providerCalls.inspect, 1, label);
}

test("R4 deadline: with no timeout option an unanswered inspection is abandoned at 30 seconds", async (t) => {
  // Mutation: the 30-second default.
  assert.equal(DEFAULT_INSPECTION_TIMEOUT_MS, 30_000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assertDeadline(t, undefined, 30_000, "no options");
  await assertDeadline(t, {}, 30_000, "empty options");
  await assertDeadline(t, { timeoutMs: undefined }, 30_000, "timeoutMs undefined");
  // A stated deadline is used as stated.
  await assertDeadline(t, { timeoutMs: 1234 }, 1234, "timeoutMs 1234");
  await assertDeadline(t, { timeoutMs: 60_000 }, 60_000, "timeoutMs 60000");
});

// --- Library edges for #3 and #5 callers (review rv6c-3db7f9d0, R6) ---------

test("R6: a missing or unusable client is no client: no call is counted, no evidence is claimed", async () => {
  const unusable: [string, unknown][] = [
    ["undefined", undefined],
    ["an empty object", {}],
    ["a method that is a string", { inspectBoundSandbox: "live-provider" }],
    ["a method that is null", { inspectBoundSandbox: null }],
    ["a method that is an object", { inspectBoundSandbox: {} }],
    ["a string", "client"],
    ["a number", 7],
    ["true", true],
    ["an array", []],
    [
      "a method whose read throws",
      Object.defineProperty({}, "inspectBoundSandbox", {
        get() {
          throw new Error(CANARY);
        },
      }),
    ],
    [
      "a proxy answering live-provider to every property",
      new Proxy({}, { get: () => "live-provider" }),
    ],
  ];
  const absent = await runPreflight(VALID_ENV, null);
  assert.equal(absent.status, "unavailable");
  assert.deepEqual(absent.reasons, [{ code: "upstream_seam_missing" }]);
  assert.equal(absent.evidence, "none");
  assert.equal(absent.providerCalls.inspect, 0);
  const unbound = await runPreflight({}, null);
  assert.deepEqual(unbound.reasons, [{ code: "sandbox_id_missing" }]);
  assert.equal(unbound.evidence, "none");
  for (const [label, client] of unusable) {
    const result = await runPreflight(
      VALID_ENV,
      client as SandboxInspectionClient
    );
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(result.reasons, [{ code: "upstream_seam_missing" }], label);
    assert.equal(result.evidence, "none", label);
    assert.equal(result.providerCalls.inspect, 0, label);
    assert.equal(result.observed, null, label);
    assert.equal(isLiveReady(result), false, label);
    // Exactly what `null` gives, with or without a valid binding.
    assert.deepEqual(result, absent, label);
    assert.deepEqual(
      await runPreflight({}, client as SandboxInspectionClient),
      unbound,
      label
    );
    assert.doesNotMatch(renderJson(result) + renderHuman(result), /canary/iu);
  }
});

test("R6: one inspection is counted exactly when the seam method was invoked", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  type Shape = [string, (count: () => void) => unknown, string, string[]];
  const shapes: Shape[] = [
    ["answers", (count) => ({ inspectBoundSandbox: () => (count(), Promise.resolve(fixture.inspection)) }), "ready", []],
    ["answers without a promise", (count) => ({ inspectBoundSandbox: () => (count(), fixture.inspection) }), "ready", []],
    [
      "throws synchronously",
      (count) => ({
        inspectBoundSandbox: () => {
          count();
          throw new Error(CANARY);
        },
      }),
      "unavailable",
      ["provider_unavailable"],
    ],
    ["rejects", (count) => ({ inspectBoundSandbox: () => (count(), Promise.reject(new Error(CANARY))) }), "unavailable", ["provider_unavailable"]],
    ["never answers", (count) => ({ inspectBoundSandbox: () => (count(), new Promise(() => undefined)) }), "unavailable", ["provider_unavailable"]],
    ["answers outside the contract", (count) => ({ inspectBoundSandbox: () => (count(), Promise.resolve(CANARY)) }), "unavailable", ["inspection_contract_violation"]],
    [
      "uses its own receiver",
      (count) => ({
        inspectBoundSandbox(this: { response: unknown }) {
          count();
          return Promise.resolve(this.response);
        },
        response: fixture.inspection,
      }),
      "ready",
      [],
    ],
    [
      "is a callable object carrying the method",
      (count) =>
        Object.assign(() => undefined, {
          inspectBoundSandbox: () => (count(), Promise.resolve(fixture.inspection)),
        }),
      "ready",
      [],
    ],
    [
      "inherits the method",
      (count) =>
        Object.create({
          inspectBoundSandbox: () => (count(), Promise.resolve(fixture.inspection)),
        }),
      "ready",
      [],
    ],
    // Review rv11 B1. A callable need not carry the built-in `call`, and one
    // that carries its own must not be reached through it: the method itself
    // is what gets invoked, whatever its properties say.
    [
      "is a method with a null prototype",
      (count) => ({
        inspectBoundSandbox: Object.setPrototypeOf(
          () => (count(), Promise.resolve(fixture.inspection)),
          null
        ),
      }),
      "ready",
      [],
    ],
    [
      "is a callable proxy answering undefined to every property",
      (count) => ({
        inspectBoundSandbox: new Proxy(
          () => (count(), Promise.resolve(fixture.inspection)),
          { get: () => undefined }
        ),
      }),
      "ready",
      [],
    ],
    [
      "is a callable proxy answering a stub to every property",
      (count) => ({
        inspectBoundSandbox: new Proxy(
          () => (count(), Promise.resolve(fixture.inspection)),
          { get: () => () => CANARY }
        ),
      }),
      "ready",
      [],
    ],
    [
      "carries its own call answering ready, and itself rejects",
      (count) => ({
        inspectBoundSandbox: Object.assign(
          () => (count(), Promise.reject(new Error(CANARY))),
          {
            apply: () => Promise.resolve(fixture.inspection),
            bind: () => () => Promise.resolve(fixture.inspection),
            call: () => Promise.resolve(fixture.inspection),
          }
        ),
      }),
      "unavailable",
      ["provider_unavailable"],
    ],
  ];
  for (const [label, build, status, expected] of shapes) {
    let invoked = 0;
    const client = build(() => {
      invoked += 1;
    }) as SandboxInspectionClient;
    const result = await runPreflight(fixture.env, client, { timeoutMs: 25 });
    assert.equal(invoked, 1, label);
    assert.equal(result.providerCalls.inspect, 1, label);
    assert.equal(result.evidence, "fixture", label);
    assert.equal(result.status, status, label);
    assert.deepEqual(codes(result), expected, label);
    assert.doesNotMatch(renderJson(result) + renderHuman(result), /canary/iu);
  }

  // No property of the method is read on the way to invoking it.
  const touched: PropertyKey[] = [];
  let direct = 0;
  const watched = new Proxy(
    () => {
      direct += 1;
      return Promise.resolve(fixture.inspection);
    },
    {
      get(target, key, receiver) {
        touched.push(key);
        return Reflect.get(target, key, receiver);
      },
    }
  );
  const untouched = await runPreflight(fixture.env, {
    inspectBoundSandbox: watched,
  } as SandboxInspectionClient);
  assert.deepEqual(touched, []);
  assert.equal(direct, 1);
  assert.equal(untouched.status, "ready");
  assert.equal(untouched.providerCalls.inspect, 1);

  // The method is read once: what was judged usable is what gets called.
  let reads = 0;
  const shifting = Object.defineProperty({}, "inspectBoundSandbox", {
    get() {
      reads += 1;
      return reads === 1 ? () => Promise.resolve(fixture.inspection) : undefined;
    },
  }) as SandboxInspectionClient;
  const read = await runPreflight(fixture.env, shifting);
  assert.equal(reads, 1);
  assert.equal(read.status, "ready");
  assert.equal(read.providerCalls.inspect, 1);

  // An invalid binding stops the check before the client is called.
  let early = 0;
  const counted: SandboxInspectionClient = {
    inspectBoundSandbox: () => {
      early += 1;
      return Promise.resolve(fixture.inspection);
    },
  };
  const invalid = await runPreflight({}, counted);
  assert.equal(early, 0);
  assert.equal(invalid.providerCalls.inspect, 0);
  assert.equal(invalid.evidence, "fixture");

  // The client's property is still read, once, with an invalid binding: the
  // evidence class depends on it (review rv11 N1). At 13ab3bc an invalid
  // binding returned without touching the client.
  let lazyReads = 0;
  const lazy = Object.defineProperty({}, "inspectBoundSandbox", {
    get() {
      lazyReads += 1;
      return counted.inspectBoundSandbox;
    },
  }) as SandboxInspectionClient;
  const unbound = await runPreflight({}, lazy);
  assert.equal(lazyReads, 1);
  assert.equal(early, 0);
  assert.equal(unbound.providerCalls.inspect, 0);
  assert.equal(unbound.evidence, "fixture");
});

test("R6: options that are null or not an object are no options", async (t) => {
  const fixture = loadFixtureCase(casePath("ready"));
  // The last two carry a `timeoutMs` (review rv11 B2): without them nothing
  // here would notice an array or a function being read for its deadline.
  const junk = [
    null,
    7,
    "timeoutMs",
    true,
    [],
    [5],
    () => undefined,
    Object.assign([], { timeoutMs: 25 }),
    Object.assign(() => undefined, { timeoutMs: 25 }),
  ];
  for (const options of junk) {
    const result = await runPreflight(
      fixture.env,
      createFixtureInspectionClient(fixture),
      options as never
    );
    assert.equal(result.status, "ready", String(options));
    assert.equal(result.evidence, "fixture", String(options));
    assert.equal(result.providerCalls.inspect, 1, String(options));
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const options of junk) {
    await assertDeadline(t, options as never, 30_000, `options ${String(options)}`);
  }
  // What still counts as options: any other object, whatever built it.
  class Stated {
    timeoutMs = 25;
  }
  const bare = Object.assign(Object.create(null), { timeoutMs: 25 });
  await assertDeadline(t, new Stated(), 25, "options from a class");
  await assertDeadline(t, bare, 25, "options with a null prototype");
});

test("R6: a null or non-object environment is an unconfigured binding, not an exception", async () => {
  const unconfigured = { ok: false, partial: {}, problem: "sandbox_id_missing" };
  // The last one carries a complete, valid binding (review rv11 B2): every
  // other value here gave this result before any guard existed, or threw.
  const notAnEnvironment = [
    null,
    undefined,
    7,
    "CASTLES_SANDBOX_ID",
    true,
    [],
    ["x"],
    Object.assign(() => undefined, VALID_ENV),
  ];
  for (const environment of notAnEnvironment) {
    const label = String(environment);
    assert.deepEqual(parseBinding(environment as never), unconfigured, label);
    const wire = tripwireClient(() => ({}));
    const result = await runPreflight(environment as never, wire.client);
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(result.reasons, [{ code: "sandbox_id_missing" }], label);
    assert.deepEqual(wire.calls, [], label);
    assert.equal(result.providerCalls.inspect, 0, label);
    assert.equal(result.evidence, "fixture", label);
    assert.equal(result.observed, null, label);
    assert.deepEqual(
      result.target,
      { expectedGeneration: null, ownerAlias: null, profile: null, sandboxAlias: null },
      label
    );
    const none = await runPreflight(environment as never, null);
    assert.equal(none.evidence, "none", label);
    assert.deepEqual(none.reasons, [{ code: "sandbox_id_missing" }], label);
  }

  // What still counts as an environment: any other object, whatever built
  // it. An array is an object here, so one carrying the keys is read.
  class Configured {
    CASTLES_OWNER_AGENT_ID = VALID_ENV.CASTLES_OWNER_AGENT_ID;
    CASTLES_PROFILE = VALID_ENV.CASTLES_PROFILE;
    CASTLES_SANDBOX_GENERATION = VALID_ENV.CASTLES_SANDBOX_GENERATION;
    CASTLES_SANDBOX_ID = VALID_ENV.CASTLES_SANDBOX_ID;
  }
  const read: [string, unknown][] = [
    ["from a class", new Configured()],
    ["with a null prototype", Object.assign(Object.create(null), VALID_ENV)],
    ["an array carrying the keys", Object.assign([], VALID_ENV)],
  ];
  for (const [label, environment] of read) {
    assert.equal(parseBinding(environment as never).ok, true, label);
    const wire = tripwireClient(() => ({}));
    const result = await runPreflight(environment as never, wire.client);
    assert.deepEqual(wire.calls, ["inspectBoundSandbox"], label);
    assert.equal(result.providerCalls.inspect, 1, label);
  }
});

test("N5 limit: a property whose read throws still rejects with the caller's error", async () => {
  // Stated, not hidden (review rv11 N5): the edges above are decided for
  // plain values. An accessor that throws is not handled, at 13ab3bc or
  // here, and the caller's own error comes back. When that is decided, this
  // test is the one to change.
  const fixture = loadFixtureCase(casePath("ready"));
  const raise = () => {
    throw new Error(CANARY);
  };
  const client = createFixtureInspectionClient(fixture);
  const environment = Object.defineProperty({ ...fixture.env }, "CASTLES_SANDBOX_ID", {
    get: raise,
  });
  await assert.rejects(runPreflight(environment, client), { message: CANARY });
  const options = Object.defineProperty({}, "timeoutMs", { get: raise });
  await assert.rejects(runPreflight(fixture.env, client, options), { message: CANARY });
  const inspection = structuredClone(fixture.inspection) as any;
  // Enumerable, as a key a JSON answer could carry: a non-enumerable one is
  // now refused before it is read (see the v1 review tests).
  Object.defineProperty(inspection.body.observed, "cpu", { enumerable: true, get: raise });
  await assert.rejects(
    runPreflight(fixture.env, { inspectBoundSandbox: () => Promise.resolve(inspection) }),
    { message: CANARY }
  );
});

/**
 * Numbers no timer can hold. Node replaces a delay above 2^31-1 with 1 ms
 * and warns, so a caller asking for a long wait got none: the one timeout
 * defect review rv6c R6 reported.
 */
const OVER_LONG_TIMEOUTS: [string, number][] = [
  ["2^31", 2 ** 31],
  ["2^31 - 1 + 0.5", 2 ** 31 - 0.5],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ["1e21", 1e21],
];

/**
 * Every other stated value, a number or not. At the accepted revision
 * 13ab3bc each of these was handed to the timer as given, and what a
 * non-positive or non-numeric timeout should mean is an open question for
 * the maintainer (review rv11 N2). Until it is answered they keep that
 * behaviour: Node waits 1 ms for a number below 1 and for NaN, converts a
 * string, a boolean or an array, and throws on a bigint, which the check
 * flattens to `provider_unavailable`.
 */
const TIMEOUTS_LEFT_TO_THE_TIMER: [string, unknown][] = [
  ["0", 0],
  ["0.5", 0.5],
  ["-1", -1],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["NaN", Number.NaN],
  ['"20"', "20"],
  ["true", true],
  ["an object", {}],
  ["an array", [20]],
  ["a bigint", 20n],
  // Not numbers, so not changed either, though Node converts both to more
  // than 2^31-1 and waits 1 ms: part of the same open question.
  ['"4294967296"', "4294967296"],
  ["a boxed 2^31", Object(2 ** 31)],
];

test("R6: a timeout above 2^31-1, Infinity included, falls back to the 30-second default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [label, timeoutMs] of OVER_LONG_TIMEOUTS) {
    await assertDeadline(t, { timeoutMs }, 30_000, `timeoutMs ${label}`);
  }
  // No stated value is the default too, as it always was.
  for (const timeoutMs of [undefined, null]) {
    await assertDeadline(t, { timeoutMs } as never, 30_000, `timeoutMs ${timeoutMs}`);
  }
  // Up to the longest delay a timer accepts, the stated deadline is used.
  for (const timeoutMs of [1, 20, 30_001, 2 ** 31 - 1]) {
    await assertDeadline(t, { timeoutMs }, timeoutMs, `timeoutMs ${timeoutMs}`);
  }
});

test("N2: every other stated timeout reaches the timer as given, as at 13ab3bc", async (t) => {
  const fixture = loadFixtureCase(casePath("ready"));
  const handed: unknown[] = [];
  const realSetTimeout = globalThis.setTimeout;
  // Records the delay and arms a real 1 ms timer in its place, so that this
  // test does not make Node print its own warnings about the value.
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, delay?: unknown) => {
      handed.push(delay);
      return realSetTimeout(callback, 1);
    }
  );
  for (const [label, timeoutMs] of TIMEOUTS_LEFT_TO_THE_TIMER) {
    handed.length = 0;
    const result = await runPreflight(
      fixture.env,
      createFixtureInspectionClient(fixture),
      { timeoutMs } as never
    );
    assert.equal(result.status, "ready", `timeoutMs ${label}`);
    assert.equal(handed.length, 1, `timeoutMs ${label}`);
    assert.ok(
      Object.is(handed[0], timeoutMs),
      `timeoutMs ${label}: the timer was handed ${String(handed[0])}`
    );
  }
  // The same seam shows the other side: a number above 2^31-1 never
  // reaches the timer.
  for (const [label, timeoutMs] of OVER_LONG_TIMEOUTS) {
    handed.length = 0;
    await runPreflight(fixture.env, createFixtureInspectionClient(fixture), {
      timeoutMs,
    });
    assert.deepEqual(handed, [DEFAULT_INSPECTION_TIMEOUT_MS], `timeoutMs ${label}`);
  }
});

test("N2: a timeout below 1 or not a number still abandons a silent provider at once, as at 13ab3bc", async () => {
  // Real timers, and only values Node handles without printing a warning.
  const silent: SandboxInspectionClient = {
    inspectBoundSandbox: () => new Promise(() => undefined),
  };
  for (const [label, timeoutMs] of [
    ["0", 0],
    ["0.5", 0.5],
    ['"20"', "20"],
    ["true", true],
    ["a bigint", 20n],
  ] as const) {
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runPreflight(VALID_ENV, silent, { timeoutMs } as never),
      new Promise<"pending">((resolve) => {
        guard = setTimeout(() => resolve("pending"), 2_000);
      }),
    ]);
    clearTimeout(guard);
    assert.notEqual(outcome, "pending", `timeoutMs ${label}: still waiting after 2 s`);
    const result = outcome as PreflightResult;
    assert.equal(result.status, "unavailable", `timeoutMs ${label}`);
    assert.deepEqual(result.reasons, [{ code: "provider_unavailable" }], `timeoutMs ${label}`);
    assert.equal(result.providerCalls.inspect, 1, `timeoutMs ${label}`);
  }
});

test("R6: an over-long timeout does not abandon a provider that answers, and Node is never handed it", async () => {
  // Real timers. Node replaces a delay above 2^31-1 with 1 ms and emits a
  // warning; a check must not inherit that.
  const fixture = loadFixtureCase(casePath("ready"));
  const slow: SandboxInspectionClient = {
    inspectBoundSandbox: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(fixture.inspection), 40);
      }),
  };
  // Only timer warnings count: an unrelated one (Node 22.0.0 warns once that
  // mocked timers are experimental) must not fail this test.
  const warnings: string[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name.startsWith("Timeout")) {
      warnings.push(warning.name);
    }
  };
  process.on("warning", onWarning);
  try {
    for (const [label, timeoutMs] of OVER_LONG_TIMEOUTS) {
      const result = await runPreflight(fixture.env, slow, { timeoutMs });
      assert.equal(result.status, "ready", `timeoutMs ${label}`);
      assert.deepEqual(result.reasons, [], `timeoutMs ${label}`);
    }
    await afterMicrotasks();
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings, []);
});

// --- Structural: no second adapter, no network, no writes ------------------

/**
 * A static scan of every file under src/. It is a tripwire, not a proof.
 *
 * What it checks:
 * - src/ holds only `.ts` files, and every one is scanned;
 * - every `import` and every `export ... from`, wherever it sits on a line,
 *   names either a `./x.ts` file that is itself in src/, or a binding listed
 *   in ALLOWED_IMPORTS; nothing else may be imported or re-exported;
 * - the name of a Node built-in module appears in a string only as the
 *   specifier of such an import;
 * - `process` is used only in the forms listed in PROCESS_USE;
 * - the text `process.env[key]` appears only inside a loop that is, to the
 *   character, BINDING_LOOP: `for (const key of BINDING_ENVIRONMENT_KEYS)`
 *   with the one statement `environment[key] = process.env[key];`;
 * - the name BINDING_ENVIRONMENT_KEYS appears, comments included, only in
 *   its declaration in profile.ts, which must be KEY_LIST_DECLARATION (the
 *   four binding keys, written out), as a plain member of an import from
 *   `./profile.ts`, and as the iterable of such a `for` header;
 * - the name readFileSync appears, comments included, only in READ_IMPORT
 *   and as the call READ_CALL, `readFileSync(path, "utf8")`: no flag and no
 *   options object can be passed to it;
 * - none of the words in FORBIDDEN_ANYWHERE appears at all, comments and
 *   strings included, and no `\u` or `\x` escape does either.
 *
 * What it cannot do: it reads text, not a syntax tree, so it does not hold
 * the property "this code cannot reach a capability". In particular it does
 * not know what `key`, `path` or the key list hold when the code runs. The
 * environment rule shows that the one loop is spelled as expected and that
 * the list it names is declared as four keys; it does not show that only
 * those four variables are read. SCAN_KNOWN_GAPS lists examples of evasions
 * that pass, among them a key list widened without being named and a read
 * of any file through the allowed call. The permission-model run at the end of this file
 * is the run-time check, with its own stated limits; it does not restrict
 * environment reads at all.
 */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "node:crypto": ["createHash"],
  "node:fs": ["readFileSync"],
  "node:process": ["default"],
  "node:util": ["parseArgs"],
};
const BUILTIN_NAMES = new Set(
  builtinModules.flatMap((name) => {
    const bare = name.replace(/^node:/u, "");
    return [bare, `node:${bare}`];
  })
);
const FORBIDDEN_ANYWHERE =
  /\b(?:globalThis|global|self|window|require|eval|Function|constructor|__proto__|prototype|Reflect|Proxy|fetch|XMLHttpRequest|WebSocket|EventSource|Worker|WebAssembly|Deno|Bun|getBuiltinModule|dlopen|mainModule|createRequire)\b|\bimport\s*\(|\bimport\s*\.|\\u|\\x/u;
const FORBIDDEN_EVERYWHERE = new RegExp(FORBIDDEN_ANYWHERE.source, "gu");
const PROCESS_WORD = /(?<![\w$/-]|node:)process(?![\w$])/gu;
const PROCESS_USE =
  /^process(?:\.env\[key\]|\.exit\(2\)|\.exitCode = |\.loadEnvFile\("\.env\.local"\)|\.stdout\.write\(|\.stderr\.write\(| from "node:process";)/u;
const MODULE_STATEMENT =
  /\b(import|export)\b(?!\s*["'])\s*([^;"'`]*?)\s*\bfrom\s*(["'])([^"'\n]*)\3|\bimport\s*(["'])([^"'\n]*)\5/gu;
const RELATIVE_SPECIFIER = /^\.\/[a-z][a-z0-9-]*\.ts$/u;
/** The only text in which the environment may be read. */
const BINDING_LOOP =
  /for \(const key of BINDING_ENVIRONMENT_KEYS\) \{\s*environment\[key\] = process\.env\[key\];\s*\}/gu;
const ENVIRONMENT_READ = /process\.env\[key\]/gu;
const KEY_LIST = "BINDING_ENVIRONMENT_KEYS";
const KEY_LIST_WORD = /(?<![\w$])BINDING_ENVIRONMENT_KEYS(?![\w$])/gu;
const KEY_LIST_FILE = "profile.ts";
const KEY_LIST_DECLARATION = [
  "export const BINDING_ENVIRONMENT_KEYS = [",
  '  "CASTLES_PROFILE",',
  '  "CASTLES_SANDBOX_ID",',
  '  "CASTLES_OWNER_AGENT_ID",',
  '  "CASTLES_SANDBOX_GENERATION",',
  "] as const;",
].join("\n");
const KEY_LIST_ITERATION = "for (const key of ";
const READ_WORD = /(?<![\w$])readFileSync(?![\w$])/gu;
const READ_IMPORT = 'import { readFileSync } from "node:fs";';
const READ_CALL = 'readFileSync(path, "utf8")';

/** Naive on purpose: checks that must not be fooled by it read raw text. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

function importedNames(clause: string): string[] {
  const names: string[] = [];
  let rest = clause.replace(/^type\s+/u, "");
  const braces = /\{([^}]*)\}/u.exec(rest);
  if (braces) {
    for (const part of (braces[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0];
      if (name) {
        names.push(name.trim());
      }
    }
    rest = rest.replace(braces[0], "");
  }
  for (const part of rest.split(",")) {
    if (part.trim() !== "") {
      names.push(part.trim().startsWith("*") ? "*" : "default");
    }
  }
  return names;
}

function scanSources(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of files) {
    if (source === NOT_A_REGULAR_FILE) {
      problems.push(`${file}: not a regular file`);
      continue;
    }
    if (!file.endsWith(".ts")) {
      problems.push(`${file}: not a TypeScript source file`);
      continue;
    }
    const code = withoutComments(source);

    // Every occurrence, with its line, so a session can fix them in one pass.
    for (const forbidden of source.matchAll(FORBIDDEN_EVERYWHERE)) {
      const line = source.slice(0, forbidden.index).split("\n").length;
      problems.push(
        `${file}:${line}: contains ${forbidden[0]} (banned anywhere in src/, comments and strings included)`
      );
    }

    let moduleStatements = 0;
    let importStatements = 0;
    let builtinSpecifiers = 0;
    for (const match of code.matchAll(MODULE_STATEMENT)) {
      moduleStatements += match[4] === undefined ? 0 : 1;
      importStatements += match[1] === "export" ? 0 : 1;
      const specifier = match[4] ?? match[6] ?? "";
      if (BUILTIN_NAMES.has(specifier)) {
        builtinSpecifiers += 1;
      }
      if (match[4] === undefined) {
        problems.push(`${file}: side-effect import of ${specifier}`);
        continue;
      }
      if (specifier.startsWith(".")) {
        const target = join(dirname(file), specifier).replaceAll("\\", "/");
        if (!RELATIVE_SPECIFIER.test(specifier) || !files.has(target)) {
          problems.push(`${file}: imports ${specifier}, not a file in src/`);
        }
        continue;
      }
      const allowed = ALLOWED_IMPORTS[specifier];
      if (!allowed) {
        problems.push(`${file}: imports ${specifier}`);
        continue;
      }
      for (const name of importedNames(match[2] ?? "")) {
        if (match[1] === "export" || !allowed.includes(name)) {
          problems.push(`${file}: ${match[1]}s ${name} from ${specifier}`);
        }
      }
    }
    if ([...code.matchAll(/\bimport\b/gu)].length !== importStatements) {
      problems.push(`${file}: an import is not a plain static import`);
    }
    if ([...code.matchAll(/\bfrom\s*["'`]/gu)].length !== moduleStatements) {
      problems.push(`${file}: a from clause is not a plain import or export`);
    }
    // Raw text: a built-in module's name in any string must be accounted for
    // by an import above, so hiding one from the comment stripper shows.
    const builtinLiterals = [
      ...source.matchAll(/(["'`])([^"'`\n]*)\1/gu),
    ].filter((match) => BUILTIN_NAMES.has(match[2] ?? "")).length;
    if (builtinLiterals !== builtinSpecifiers) {
      problems.push(`${file}: a built-in module name outside a static import`);
    }

    for (const match of code.matchAll(PROCESS_WORD)) {
      if (!PROCESS_USE.test(code.slice(match.index))) {
        problems.push(`${file}: process used outside the allowed forms`);
      }
    }
    for (const match of source.matchAll(PROCESS_WORD)) {
      const rest = source.slice(match.index);
      if (/^process\s*[.[?,;:)}=(]/u.test(rest) && !PROCESS_USE.test(rest)) {
        problems.push(`${file}: process member outside the allowed forms`);
      }
    }

    // Raw text from here on: these names may not appear in a comment either.
    const within = (
      spans: readonly RegExpMatchArray[],
      at: number
    ): boolean =>
      spans.some(
        (span) =>
          at > (span.index ?? 0) && at < (span.index ?? 0) + span[0].length
      );

    const bindingLoops = [...source.matchAll(BINDING_LOOP)];
    for (const match of source.matchAll(ENVIRONMENT_READ)) {
      if (!within(bindingLoops, match.index)) {
        problems.push(`${file}: environment read outside the binding-key loop`);
      }
    }

    const profileImports = [...source.matchAll(MODULE_STATEMENT)].filter(
      (match) => match[1] === "import" && match[4] === `./${KEY_LIST_FILE}`
    );
    for (const match of source.matchAll(KEY_LIST_WORD)) {
      const at = match.index;
      const before = source.slice(Math.max(0, at - 200), at);
      const after = source.slice(at + KEY_LIST.length);
      const declared =
        file === KEY_LIST_FILE &&
        before.endsWith("export const ") &&
        source.startsWith(KEY_LIST_DECLARATION, at - "export const ".length);
      const iterated =
        before.endsWith(KEY_LIST_ITERATION) && after.startsWith(") {");
      const imported =
        /[{,]\s*$/u.test(before) &&
        /^\s*[,}]/u.test(after) &&
        within(profileImports, at);
      if (!declared && !iterated && !imported) {
        problems.push(`${file}: the binding key list used outside its allowed forms`);
      }
    }

    for (const match of source.matchAll(READ_WORD)) {
      const at = match.index;
      const imported =
        source.slice(Math.max(0, at - "import { ".length), at) === "import { " &&
        source.startsWith(READ_IMPORT, at - "import { ".length);
      if (!imported && !source.startsWith(READ_CALL, at)) {
        problems.push(`${file}: readFileSync outside its import and its one call form`);
      }
    }
  }
  return problems;
}

/**
 * The src/ file registry is the ownership table in docs/ownership.md, so a
 * lane adding its reserved file flips one Exists cell rather than editing
 * this test. The reserved names themselves are fixed here, in SRC_RESERVED:
 * the doc may move a reserved file between `not yet` and `yes`, but a new
 * name needs the #2 steward to add it to that list.
 *
 * Every file under src/ must have exactly one visible `src/` row:
 * - in "## Implementation paths", with Exists `yes` (it must be present) or
 *   `not yet` (it must be absent);
 * - or in "## Shared files", where it must be present.
 * Any heading ends a section, setext and indented ones included, and each
 * section may appear once. A row counts only as a body row of a table. The
 * document may hold no code fence, HTML or link reference definition. A row
 * anywhere else, under any other heading, or repeated, is a problem, as is
 * another Exists value, as is a reserved name spelled as src/ text outside a
 * counted row, or a table whose rows differ in width. Every table line must
 * be printable ASCII with no backslash and no &, which rules out escaped
 * pipes, entities and lookalike characters as a class. This is a
 * tripwire like the scan: it reads lines, not a Markdown tree, and refuses
 * what it cannot model. It cannot prove that the rendered page shows what it
 * counts, so a reviewer still reads the raw diff of docs/ownership.md. It reads text, as the scan does: a
 * table the parser does not recognise lists nothing, so every file then
 * reads as unlisted.
 */
const SRC_RESERVED = [
  "cli.ts",
  "export.ts",
  "observe.ts",
  "preflight.ts",
  "profile.ts",
  "run.ts",
] as const;
const REGISTRY_ROW = /^\|\s*`src\/([^`]+)`\s*\|(.*)$/u;
const REGISTRY_ROW_LIKE = /`src\/([^`]+)`\s*\|/u;
const TABLE_SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u;
const REGISTRY_SECTIONS = ["## Implementation paths", "## Shared files"] as const;

function sourceRegistryProblems(
  files: ReadonlyMap<string, string>,
  ownership: string,
  reserved: readonly string[]
): string[] {
  const problems: string[] = [];
  const rows = new Map<string, "yes" | "not yet" | null>();
  const seen = new Set<string>();
  let section = "";
  let fenced = false;
  let commented = false;
  // A line-by-line parser cannot follow every fence and comment form a
  // renderer does, so the registry document may contain none.
  if (/^\s*(?:`{3,}|~{3,})/mu.test(ownership) || ownership.includes("<!--")) {
    problems.push("docs/ownership.md: code fences and HTML comments are not allowed in the registry document");
  }
  // The same for every other form that can fold or hide a line when
  // rendered: raw HTML, processing instructions, declarations, CDATA and
  // link reference definitions (whose titles may span lines).
  if (/<(?!!--)[A-Za-z!?/]/u.test(ownership) || /^\s{0,3}\[[^\]]+\]:/mu.test(ownership)) {
    problems.push(
      "docs/ownership.md: raw HTML and link reference definitions are not allowed in the registry document"
    );
  }
  // A row counts only as a body row of a table: a header line at column 0
  // after a blank line or heading, then a separator row, then contiguous
  // rows. Any other line that looks like a src/ row is refused.
  let table: "none" | "header" | "separator" | "body" | "invalid" = "none";
  let width = 0;
  let plainReported = false;
  const cells = (text: string) => text.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").length;
  // A reserved name spelled as src/ text outside a counted row is refused.
  const mention = new RegExp(
    `src(?:/|&#47;|&#x2[fF];)(${reserved.map((name) => name.replaceAll(".", "\\.")).join("|")})`,
    "gu"
  );
  let boundary = true;
  let previous = "";
  for (const line of ownership.split("\n")) {
    // A setext underline makes the line before it a heading: end the section.
    if (/^\s{0,3}(?:=+|-+)\s*$/u.test(line) && previous.trim() !== "" && !previous.trimStart().startsWith("|")) {
      section = "";
      table = "none";
      boundary = true;
      previous = line;
      continue;
    }
    previous = line;
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      table = "none";
      boundary = false;
      continue;
    }
    const hidden = fenced || commented || line.includes("<!--");
    if (line.includes("<!--")) {
      commented = !line.includes("-->", line.indexOf("<!--"));
    } else if (commented && line.includes("-->")) {
      commented = false;
    }
    if (!hidden && /^\s{0,3}#{1,6}(?:\s|$)/u.test(line)) {
      const named = REGISTRY_SECTIONS.find((heading) => line.startsWith(heading)) ?? "";
      if (named !== "" && seen.has(named)) {
        problems.push(`docs/ownership.md: the section ${named} appears more than once`);
        section = "";
      } else {
        seen.add(named);
        section = named;
      }
      table = "none";
      boundary = true;
      continue;
    }
    if (/^\s*\|/u.test(line) && /[^\x20-\x7E]|[\\&]/u.test(line) && !plainReported) {
      // Escaped pipes, entities and lookalike characters let the page and
      // this parser read different cells, so a table line refuses them all.
      problems.push("docs/ownership.md: a table line holds a backslash, & or a character outside printable ASCII");
      plainReported = true;
    }
    if (line.startsWith("|")) {
      // Header and separator must have the same number of cells or the
      // renderer draws no table. GitHub pads or trims a body row of another
      // width; the check refuses one anyway.
      if (table === "none") {
        table = boundary ? "header" : "invalid";
        width = cells(line);
      } else if (table === "header") {
        table = TABLE_SEPARATOR.test(line) && cells(line) === width ? "separator" : "invalid";
      } else if (table === "separator" || table === "body") {
        table = cells(line) === width ? "body" : "invalid";
      }
    } else {
      table = "none";
    }
    boundary = line.trim() === "";
    const rowLike = REGISTRY_ROW_LIKE.exec(line);
    if (!rowLike) {
      for (const found of line.matchAll(mention)) {
        problems.push(`${found[1] ?? ""}: mentioned outside a counted row in docs/ownership.md`);
      }
      continue;
    }
    const row = REGISTRY_ROW.exec(line);
    const name = row?.[1] ?? rowLike[1] ?? "";
    if (rows.has(name)) {
      problems.push(`${name}: listed more than once in docs/ownership.md`);
      continue;
    }
    if (hidden) {
      problems.push(`${name}: row inside a code fence or HTML comment in docs/ownership.md`);
      rows.set(name, null);
    } else if (line.includes("\\")) {
      // An escaped pipe makes the page and this parser read different cells.
      problems.push(`${name}: a backslash in a registry row in docs/ownership.md`);
      rows.set(name, null);
    } else if (!row || table !== "body") {
      problems.push(`${name}: a src/ row outside a table body in docs/ownership.md`);
    } else if (section === "## Implementation paths") {
      const exists = (row?.[2] ?? "").split("|")[1]?.trim();
      if (exists === "yes" || exists === "not yet") {
        rows.set(name, exists);
      } else {
        problems.push(`${name}: Exists cell in docs/ownership.md is not yes or not yet`);
        rows.set(name, null);
      }
    } else if (section === "## Shared files") {
      rows.set(name, "yes");
    } else {
      problems.push(
        `${name}: listed outside the implementation and shared tables of docs/ownership.md`
      );
      rows.set(name, null);
    }
  }
  for (const name of [...files.keys()].sort()) {
    if (!rows.has(name)) {
      problems.push(`${name}: not listed in docs/ownership.md`);
    } else if (rows.get(name) === "not yet") {
      problems.push(`${name}: present but listed as not yet in docs/ownership.md`);
    }
  }
  for (const [name, exists] of rows) {
    if (exists === "yes" && !files.has(name)) {
      problems.push(`${name}: listed as existing in docs/ownership.md but absent`);
    }
  }
  for (const [name, exists] of rows) {
    if (exists !== null && !reserved.includes(name)) {
      problems.push(`${name}: not a reserved src/ name; adding one needs the #2 steward`);
    }
  }
  for (const name of reserved) {
    if (!rows.has(name)) {
      problems.push(`${name}: reserved src/ name has no row in docs/ownership.md`);
    }
  }
  return problems;
}

/** What readSourceTree records for an entry that is not a regular file. */
const NOT_A_REGULAR_FILE = "\0castles: not a regular file\0";

/**
 * Every entry under src/, as posix paths relative to src/. A symlink or any
 * other non-regular entry is recorded as NOT_A_REGULAR_FILE and refused by
 * scanSources, never followed and never read as empty.
 */
function readSourceTree(source: string = join(root, "src")): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      // Dirent reports a symlink as neither file nor directory.
      if (!(entry.isDirectory() || entry.isFile())) {
        files.set(relative, NOT_A_REGULAR_FILE);
      } else if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${relative}/`);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.set(relative, readFileSync(join(directory, entry.name), "utf8"));
      } else {
        // Not a TypeScript source file: scanSources reports it by name.
        files.set(relative, "");
      }
    }
  };
  walk(source, "");
  return files;
}

test("every file under src/ passes the capability scan", () => {
  const files = readSourceTree();
  // The src/ file list is docs/ownership.md, not a list in this test: a lane
  // that adds its reserved file flips that row's Exists cell to "yes".
  assert.deepEqual(
    sourceRegistryProblems(
      files,
      readFileSync(join(root, "docs", "ownership.md"), "utf8"),
      SRC_RESERVED
    ),
    []
  );
  assert.deepEqual(scanSources(files), []);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
});

const REGISTRY_FIXTURE = [
  "# Path ownership (synthetic, for the registry test)",
  "",
  "## Implementation paths",
  "",
  "| Path | Owner | Exists | Notes |",
  "| --- | --- | --- | --- |",
  "| `src/alpha.ts` | #2 | yes | |",
  "| `src/beta.ts` | #3 | not yet | |",
  "| `tests/alpha.test.ts` | #2 | yes | not under src/, so not checked here |",
  "",
  "## Shared files, stewarded by #2",
  "",
  "| Path | Why it is shared |",
  "| --- | --- |",
  "| `src/gamma.ts` | Shared entrypoint |",
  "",
].join("\n");

const FIXTURE_RESERVED = ["alpha.ts", "beta.ts", "gamma.ts"] as const;

test("the src/ registry refuses an unlisted, missing, early or unreadable file", () => {
  const files = (...names: string[]) => new Map(names.map((name) => [name, ""]));
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), []);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts", "stray.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), [
    "stray.ts: not listed in docs/ownership.md",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts", "nested/x.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), [
    "nested/x.ts: not listed in docs/ownership.md",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("gamma.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), [
    "alpha.ts: listed as existing in docs/ownership.md but absent",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), [
    "gamma.ts: listed as existing in docs/ownership.md but absent",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "beta.ts", "gamma.ts"), REGISTRY_FIXTURE, FIXTURE_RESERVED), [
    "beta.ts: present but listed as not yet in docs/ownership.md",
  ]);
  const flipped = REGISTRY_FIXTURE.replace("| `src/beta.ts` | #3 | not yet |", "| `src/beta.ts` | #3 | yes |");
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "beta.ts", "gamma.ts"), flipped, FIXTURE_RESERVED), []);
  const unreadable = REGISTRY_FIXTURE.replace("| `src/beta.ts` | #3 | not yet |", "| `src/beta.ts` | #3 | soon |");
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts"), unreadable, FIXTURE_RESERVED), [
    "beta.ts: Exists cell in docs/ownership.md is not yes or not yet",
  ]);
  const elsewhere = `${REGISTRY_FIXTURE}\n## Maintainer-owned\n\n| Path | Notes |\n| --- | --- |\n| \`src/delta.ts\` | |\n`;
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts"), elsewhere, FIXTURE_RESERVED), [
    "delta.ts: listed outside the implementation and shared tables of docs/ownership.md",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts"), `${REGISTRY_FIXTURE}| \`src/alpha.ts\` | #4 | yes | |\n`, FIXTURE_RESERVED), [
    "alpha.ts: listed more than once in docs/ownership.md",
  ]);
  assert.deepEqual(sourceRegistryProblems(files("alpha.ts", "gamma.ts"), "# empty\n", FIXTURE_RESERVED), [
    "alpha.ts: not listed in docs/ownership.md",
    "gamma.ts: not listed in docs/ownership.md",
    "alpha.ts: reserved src/ name has no row in docs/ownership.md",
    "beta.ts: reserved src/ name has no row in docs/ownership.md",
    "gamma.ts: reserved src/ name has no row in docs/ownership.md",
  ]);
});

test("the src/ registry admits only a flipped Exists cell, never a new or hidden row (PR #20 read rv20-8fd6a4b7, N1)", () => {
  const files = (...names: string[]) => new Map(names.map((name) => [name, ""]));
  const beta = "| `src/beta.ts` | #3 | not yet | |";
  const without = REGISTRY_FIXTURE.replace(`${beta}\n`, "");
  const check = (doc: string, ...names: string[]) =>
    sourceRegistryProblems(files(...names), doc, FIXTURE_RESERVED);
  const table = (row: string) => `| Path | Owner | Exists | Notes |\n| --- | --- | --- | --- |\n${row}`;
  const betaYes = "| `src/beta.ts` | #3 | yes | |";
  const outside = "beta.ts: listed outside the implementation and shared tables of docs/ownership.md";
  // A new row, even marked yes, needs the steward: the reserved names are fixed here.
  assert.deepEqual(check(REGISTRY_FIXTURE.replace(beta, `${beta}\n| \`src/new.ts\` | #3 | yes | |`), "alpha.ts", "gamma.ts", "new.ts"), [
    "new.ts: not a reserved src/ name; adding one needs the #2 steward",
  ]);
  assert.deepEqual(check(REGISTRY_FIXTURE.replace(beta, `${beta}\n| \`src/sub/new.ts\` | #3 | yes | |`), "alpha.ts", "gamma.ts", "sub/new.ts"), [
    "sub/new.ts: not a reserved src/ name; adding one needs the #2 steward",
  ]);
  assert.deepEqual(check(without, "alpha.ts", "gamma.ts"), [
    "beta.ts: reserved src/ name has no row in docs/ownership.md",
  ]);
  // Rows a reader of the rendered page would not see.
  assert.deepEqual(check(`${without}\n\`\`\`\n| \`src/beta.ts\` | #3 | yes | |\n\`\`\`\n`, "alpha.ts", "beta.ts", "gamma.ts"), [
    "docs/ownership.md: code fences and HTML comments are not allowed in the registry document",
    "beta.ts: row inside a code fence or HTML comment in docs/ownership.md",
  ]);
  assert.deepEqual(check(`${without}\n<!--\n| \`src/beta.ts\` | #3 | yes | |\n-->\n`, "alpha.ts", "beta.ts", "gamma.ts"), [
    "docs/ownership.md: code fences and HTML comments are not allowed in the registry document",
    "beta.ts: row inside a code fence or HTML comment in docs/ownership.md",
  ]);
  // Fence and comment styles a line-by-line parser can misread (PR #20 read
  // rv20b-73648cb1, F1): the document may hold none at all.
  const hiders = [
    "~~~\n| `src/beta.ts` | #3 | yes | |\n~~~",
    "   ```\n| `src/beta.ts` | #3 | yes | |\n   ```",
    "````\n```\n| `src/beta.ts` | #3 | yes | |\n````",
    "a --> b <!-- c\n| `src/beta.ts` | #3 | yes | |\n-->",
  ];
  for (const hider of hiders) {
    assert.ok(
      check(`${without}\n${hider}\n`, "alpha.ts", "beta.ts", "gamma.ts").includes(
        "docs/ownership.md: code fences and HTML comments are not allowed in the registry document"
      ),
      hider
    );
  }
  // Any heading ends a section; only the two named sections list src/ files.
  for (const heading of ["### Aside", "# Other", "#", "  ### Aside", "Aside\n-----", "Aside\n=====", "Aside\n  ---"]) {
    assert.deepEqual(
      check(without.replace("## Shared files", `${heading}\n\n${table(betaYes)}\n\n## Shared files`), "alpha.ts", "beta.ts", "gamma.ts"),
      [outside],
      heading
    );
  }
  assert.deepEqual(check(`${without}\n## Implementation paths\n\n${table(betaYes)}\n`, "alpha.ts", "beta.ts", "gamma.ts"), [
    "docs/ownership.md: the section ## Implementation paths appears more than once",
    "beta.ts: listed outside the implementation and shared tables of docs/ownership.md",
  ]);
});

test("the src/ registry counts a row only in a table body, and refuses raw HTML and link references (PR #20 read rv20c-42344cbc, F1)", () => {
  const files = (...names: string[]) => new Map(names.map((name) => [name, ""]));
  const beta = "| `src/beta.ts` | #3 | not yet | |";
  const without = REGISTRY_FIXTURE.replace(`${beta}\n`, "");
  const check = (doc: string, ...names: string[]) =>
    sourceRegistryProblems(files(...names), doc, FIXTURE_RESERVED);
  const betaYes = "| `src/beta.ts` | #3 | yes | |";
  const raw = "docs/ownership.md: raw HTML and link reference definitions are not allowed in the registry document";
  // A row-like line that is not a body row of a table counts as nothing and is refused.
  assert.deepEqual(check(REGISTRY_FIXTURE.replace(beta, ` ${beta}`), "alpha.ts", "gamma.ts"), [
    "beta.ts: a src/ row outside a table body in docs/ownership.md",
    "beta.ts: reserved src/ name has no row in docs/ownership.md",
  ]);
  assert.deepEqual(check(`${without}\n${betaYes}\n`.replace("Shared entrypoint |\n\n", "Shared entrypoint |\n\nSome prose.\n"), "alpha.ts", "beta.ts", "gamma.ts"), [
    "beta.ts: a src/ row outside a table body in docs/ownership.md",
    "beta.ts: not listed in docs/ownership.md",
    "beta.ts: reserved src/ name has no row in docs/ownership.md",
  ]);
  assert.deepEqual(check(`${without}\n> ${betaYes}\n`, "alpha.ts", "beta.ts", "gamma.ts"), [
    "beta.ts: a src/ row outside a table body in docs/ownership.md",
    "beta.ts: not listed in docs/ownership.md",
    "beta.ts: reserved src/ name has no row in docs/ownership.md",
  ]);
  // A table needs a blank line or heading before its header, and a separator row.
  const header = "| Path | Owner | Exists | Notes |";
  for (const doc of [
    `${without}\nSome prose.\n${header}\n| --- | --- | --- | --- |\n${betaYes}\n`,
    `${without}\n${header}\n| not | a | separator | row |\n${betaYes}\n`,
  ]) {
    assert.deepEqual(check(doc, "alpha.ts", "beta.ts", "gamma.ts"), [
      "beta.ts: a src/ row outside a table body in docs/ownership.md",
      "beta.ts: not listed in docs/ownership.md",
      "beta.ts: reserved src/ name has no row in docs/ownership.md",
    ], doc);
  }
  // PR #20 read rv20d-04e82d07: a header and separator with different cell
  // counts render as a paragraph, not a table. A body row of another width
  // still renders (GitHub pads or trims it); the check refuses it anyway.
  for (const doc of [
    `${without}\n${header}\n| --- | --- |\n${betaYes}\n`,
    `${without}\n${header}\n| --- | --- | --- | --- |\n| \`src/beta.ts\` | #3 | yes |\n`,
  ]) {
    assert.deepEqual(check(doc, "alpha.ts", "beta.ts", "gamma.ts"), [
      "beta.ts: a src/ row outside a table body in docs/ownership.md",
      "beta.ts: not listed in docs/ownership.md",
      "beta.ts: reserved src/ name has no row in docs/ownership.md",
    ], doc);
  }
  // An escaped pipe makes the page and the parser read different cells.
  assert.ok(
    check(REGISTRY_FIXTURE.replace(beta, "| `src/beta.ts` | #3 \\| yes | not yet |"), "alpha.ts", "beta.ts", "gamma.ts").includes(
      "beta.ts: a backslash in a registry row in docs/ownership.md"
    ),
    "escaped pipe"
  );
  // A reserved name spelled as src/ text outside a counted row is refused.
  for (const decoy of [
    "| ``src/beta.ts`` | #3 | yes | |",
    "| &#96;src/beta.ts&#96; | #3 | yes | |",
    "| src/beta.ts | #3 | yes | |",
    "Note: src/beta.ts is ready.",
  ]) {
    assert.ok(
      check(`${REGISTRY_FIXTURE}\n${decoy}\n`, "alpha.ts", "gamma.ts").includes(
        "beta.ts: mentioned outside a counted row in docs/ownership.md"
      ),
      decoy
    );
  }
  // PR #20 read rv20e-e3e4fcae: any table line may hold only printable ASCII,
  // with no backslash and no &. That closes escaped pipes in a header, HTML
  // entities, zero-width and lookalike characters as a class.
  const plain = "docs/ownership.md: a table line holds a backslash, & or a character outside printable ASCII";
  for (const doc of [
    REGISTRY_FIXTURE.replace("| Path | Owner | Exists | Notes |", "| Path | Owner \\| Exists | Notes |"),
    `${REGISTRY_FIXTURE}| \`src/beta.ts\` | #3 | yes |\n`.replace("| `src/beta.ts` | #3 | yes |", "| `src\u200b/beta.ts` | #3 | yes |"),
    `${REGISTRY_FIXTURE}| \`src\uff0fbeta.ts\` | #3 | yes | |\n`,
    `${REGISTRY_FIXTURE}| src&#X2F;beta.ts | #3 | yes | |\n`,
    `${REGISTRY_FIXTURE}| src&sol;beta.ts | #3 | yes | |\n`,
  ]) {
    assert.ok(check(doc, "alpha.ts", "beta.ts", "gamma.ts").includes(plain), doc);
  }
  // A src/ code span in a later cell is not a row.
  assert.ok(
    check(REGISTRY_FIXTURE.replace("| `src/gamma.ts` | Shared entrypoint |", "| `src/gamma.ts` | Shared entrypoint |\n| `docs/x.md` | see `src/delta.ts` |"), "alpha.ts", "gamma.ts").includes(
      "delta.ts: a src/ row outside a table body in docs/ownership.md"
    ),
    "code span in a later cell"
  );
  // Forms the renderer hides or folds, each refused outright.
  for (const hider of [
    `[x]: /u '\n${betaYes}\n'`,
    `[x]: /u "\n${betaYes}\n"`,
    `<?\n${betaYes}\n?>`,
    `<![CDATA[\n${betaYes}\n]]>`,
    `<!X\n${betaYes}\n>`,
    `<span title="\n${betaYes}\n">`,
    `<details>\n\n${betaYes}\n\n</details>`,
  ]) {
    assert.ok(check(`${REGISTRY_FIXTURE.replace(beta, ` ${beta}`)}\n${hider}\n`, "alpha.ts", "beta.ts", "gamma.ts").includes(raw), hider);
  }
  // The real document holds none of these, and a plain one-cell flip still passes.
  const flipped = REGISTRY_FIXTURE.replace(beta, betaYes);
  assert.deepEqual(check(flipped, "alpha.ts", "beta.ts", "gamma.ts"), []);
});

test("the capability scan refuses a symlink under src/ rather than reading it as empty (PR #20 read rv20-8fd6a4b7, N3)", () => {
  const directory = mkdtempSync(join(tmpdir(), "castles-src-"));
  const outside = mkdtempSync(join(tmpdir(), "castles-outside-"));
  try {
    writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "planted.ts"), "export const g = globalThis;\n");
    symlinkSync(join(directory, "a.ts"), join(directory, "b.ts"));
    symlinkSync(join(outside, "planted.ts"), join(directory, "c.ts"));
    symlinkSync(outside, join(directory, "linked"));
    assert.deepEqual(scanSources(readSourceTree(directory)).sort(), [
      "b.ts: not a regular file",
      "c.ts: not a regular file",
      "linked: not a regular file",
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a capability-scan problem names the file, the line and the banned word, once per occurrence", () => {
  const files = new Map([
    ["one.ts", 'export const a = 1;\n// the prototype of a thing\nexport const b = 2; // window\n'],
  ]);
  assert.deepEqual(scanSources(files), [
    "one.ts:2: contains prototype (banned anywhere in src/, comments and strings included)",
    "one.ts:3: contains window (banned anywhere in src/, comments and strings included)",
  ]);
  // Two on one line, and one word on two lines: one problem each (N2).
  assert.deepEqual(scanSources(new Map([["three.ts", "// prototype and prototype\n// prototype\n"]])), [
    "three.ts:1: contains prototype (banned anywhere in src/, comments and strings included)",
    "three.ts:1: contains prototype (banned anywhere in src/, comments and strings included)",
    "three.ts:2: contains prototype (banned anywhere in src/, comments and strings included)",
  ]);
  assert.deepEqual(scanSources(new Map([["two.ts", 'const s = "\\x41";\n']])), [
    "two.ts:1: contains \\x (banned anywhere in src/, comments and strings included)",
  ]);
});

type Plant = (files: Map<string, string>) => void;
const prepend =
  (file: string, text: string): Plant =>
  (files) => {
    files.set(file, `${text}\n${files.get(file) ?? ""}`);
  };
const append =
  (file: string, text: string): Plant =>
  (files) => {
    files.set(file, `${files.get(file) ?? ""}\n${text}\n`);
  };
const addFile =
  (file: string, text: string): Plant =>
  (files) => {
    files.set(file, text);
  };
/** Replaces text that must be present, so a plant cannot silently miss. */
const replaceIn =
  (file: string, from: string, to: string): Plant =>
  (files) => {
    const source = files.get(file) ?? "";
    assert.ok(source.includes(from), `plant target missing in ${file}`);
    files.set(file, source.replace(from, to));
  };

/** Each of these must be reported by the scan. */
const SCAN_MUST_CATCH: readonly (readonly [string, ...Plant[]])[] = [
  // Carried over from the first review.
  ["fs write functions", prepend("cli.ts", 'import { openSync, writeSync } from "node:fs";')],
  ["fs write beside read", prepend("cli.ts", 'import { readFileSync, writeFileSync } from "node:fs";')],
  ["fs namespace", prepend("cli.ts", 'import * as fs from "node:fs";')],
  ["fs default", prepend("cli.ts", 'import fs from "node:fs";')],
  ["https", prepend("cli.ts", 'import { request } from "node:https";')],
  ["child_process", prepend("cli.ts", 'import { spawn } from "node:child_process";')],
  ["createRequire", prepend("cli.ts", 'import { createRequire } from "node:module";')],
  ["globalThis", append("cli.ts", "const f = globalThis.fetch;")],
  ["dynamic import", append("cli.ts", 'const net = await import("node:net");')],
  ["require", append("cli.ts", 'const fs = require("node:fs");')],
  ["process.binding", append("cli.ts", 'process.binding("fs");')],
  ["getBuiltinModule", append("cli.ts", 'process.getBuiltinModule("node:fs");')],
  ["computed dynamic import", append("cli.ts", 'import("node:" + "http");')],
  ["multi-line named import", prepend("cli.ts", 'import {\n  readFileSync,\n  rmSync,\n} from "node:fs";')],
  // The second review's seven (rv6b-0288e674, N2).
  [
    "named import beside the default from node:process",
    (files) => {
      files.set(
        "cli.ts",
        (files.get("cli.ts") ?? "").replace(
          'import process from "node:process";',
          'import process, { getBuiltinModule } from "node:process";'
        )
      );
    },
  ],
  ["bracketed getBuiltinModule", append("cli.ts", 'process["getBuiltinModule"]("node:child_process").spawnSync("true");')],
  ["concatenated global property", append("cli.ts", 'global["fe" + "tch"]("http://127.0.0.1:9");')],
  ["process.report", append("cli.ts", 'process.report.writeReport("/tmp/castles-report.json");')],
  ["import after another statement on the line", prepend("cli.ts", 'const a = 1; import { writeFileSync } from "node:fs";')],
  [
    "new sibling module with network and process imports",
    addFile("net.ts", 'import { request } from "node:https";\nimport { spawn } from "node:child_process";\nexport const reach = [request, spawn];'),
    prepend("preflight.ts", 'import { reach } from "./net.ts";'),
  ],
  ["sibling module nobody imports", addFile("lib/net.ts", 'import { connect } from "node:net";\nexport const reach = connect;')],
  ["named re-export", append("preflight.ts", 'export { request } from "node:https";')],
  ["star re-export", append("preflight.ts", 'export * from "node:child_process";')],
  ["namespace re-export", append("preflight.ts", 'export * as cp from "node:child_process";')],
  ["re-export of an allowed binding", append("preflight.ts", 'export { readFileSync } from "node:fs";')],
  ["string-named import of a package", prepend("cli.ts", 'import { "Daytona" as D } from "@daytona/sdk";')],
  ["string-named re-export of a package", append("preflight.ts", 'export { "Daytona" as D } from "@daytona/sdk";')],
  ["a success exit", append("cli.ts", "process.exit(0);")],
  // Other evasions the second review listed.
  ["optional-chained process member", append("cli.ts", 'process?.binding("fs");')],
  ["destructuring from process", append("cli.ts", "const { env, report } = process;")],
  ["aliasing process", append("cli.ts", "const p = process;\np.report.writeReport();")],
  ["aliasing process without a semicolon", append("cli.ts", "const p = process\nconst q = p")],
  ["passing process", append("cli.ts", "Object.keys(process);")],
  ["spreading process.env", append("cli.ts", "const all = { ...process.env };")],
  ["Unicode-escaped identifier", append("cli.ts", "const g = gl\\u006fbalThis;")],
  ["hex-escaped string", append("cli.ts", 'const name = "\\x66etch";')],
  ["function constructor", append("cli.ts", '(function () {}).constructor("return this")();')],
  ["Function", append("cli.ts", 'new Function("return this")();')],
  ["eval", append("cli.ts", '(0, eval)("this");')],
  ["Reflect", append("cli.ts", 'Reflect.get(process, "report");')],
  ["process member between string-borne comment markers", append("cli.ts", 'const a = "/*"; process.report.writeReport(); const b = "*/";')],
  ["import between string-borne comment markers", append("cli.ts", 'const a = "/*"; import { writeFileSync } from "node:fs"; const b = "*/";')],
  ["builtin name in a string", append("cli.ts", 'const name = "node:child_process";')],
  ["unprefixed builtin name in a string", append("cli.ts", "const name = 'child_process';")],
  // Reading a credential from the environment.
  ["named environment variable", append("cli.ts", "const key = process.env.DAYTONA_API_KEY;")],
  ["bracketed environment variable", append("cli.ts", 'const key = process.env["DAYTONA_API_KEY"];')],
  ["whole environment", append("cli.ts", "const all = Object.entries(process.env);")],
  ["a second env file", append("cli.ts", 'process.loadEnvFile(".env");')],
  // Module graph and file kinds.
  ["unprefixed builtin", prepend("cli.ts", 'import fs from "fs";')],
  ["bare package", prepend("cli.ts", 'import { Daytona } from "@daytona/sdk";')],
  ["parent-relative import", prepend("cli.ts", 'import { helper } from "../tests/helper.ts";')],
  ["relative import of a missing file", prepend("cli.ts", 'import { helper } from "./missing.ts";')],
  ["side-effect import", prepend("cli.ts", 'import "node:child_process";')],
  ["import attributes", prepend("cli.ts", 'import data from "./data.json" with { type: "json" };')],
  ["import.meta", append("cli.ts", "const here = import.meta.dirname;")],
  ["native addon in src", addFile("addon.node", "")],
  ["JavaScript file in src", addFile("helper.js", "")],
  ["Worker", append("cli.ts", 'new Worker("./x.ts");')],
  ["WebSocket", append("cli.ts", 'new WebSocket("wss://provider.invalid");')],
  // The third review (rv6c-3db7f9d0, R2): any variable through `[key]`.
  [
    "environment read in a second loop over other keys",
    append(
      "cli.ts",
      'const kept: string[] = [];\nfor (const key of ["DAYTONA_API_KEY", "GITHUB_TOKEN"]) {\n  kept.push(process.env[key] ?? "");\n}'
    ),
  ],
  [
    "environment read through a variable named key",
    append("cli.ts", 'const key = "DAYTONA_API_KEY";\nconst value = process.env[key];'),
  ],
  [
    "the binding loop doing more than copy the four values",
    replaceIn(
      "cli.ts",
      "    environment[key] = process.env[key];\n",
      '    environment[key] = process.env[key];\n    process.stderr.write(process.env[key] ?? "");\n'
    ),
  ],
  [
    "the binding loop over a shadowed key list",
    replaceIn(
      "cli.ts",
      "  const environment: Record<string, string | undefined> = {};\n",
      '  const environment: Record<string, string | undefined> = {};\n  const BINDING_ENVIRONMENT_KEYS = ["DAYTONA_API_KEY"];\n'
    ),
  ],
  [
    "the binding loop over a renamed import",
    append("profile.ts", 'export const OTHER_KEYS = ["DAYTONA_API_KEY"] as const;'),
    replaceIn(
      "cli.ts",
      'import { BINDING_ENVIRONMENT_KEYS } from "./profile.ts";',
      'import { OTHER_KEYS as BINDING_ENVIRONMENT_KEYS } from "./profile.ts";'
    ),
  ],
  [
    "a fifth key in the binding key list",
    replaceIn(
      "profile.ts",
      '  "CASTLES_SANDBOX_GENERATION",\n] as const;',
      '  "CASTLES_SANDBOX_GENERATION",\n  "DAYTONA_API_KEY",\n] as const;'
    ),
  ],
  [
    "the binding key list widened at run time",
    append(
      "preflight.ts",
      '(BINDING_ENVIRONMENT_KEYS as unknown as string[]).push("DAYTONA_API_KEY");'
    ),
  ],
  [
    "the binding key list aliased on import",
    replaceIn(
      "preflight.ts",
      "  BINDING_ENVIRONMENT_KEYS,\n",
      "  BINDING_ENVIRONMENT_KEYS,\n  BINDING_ENVIRONMENT_KEYS as keys,\n"
    ),
    append("preflight.ts", '(keys as unknown as string[]).push("DAYTONA_API_KEY");'),
  ],
  // The same review: an allowed import that can write through its flags.
  [
    "readFileSync with an append flag, swallowed",
    append(
      "preflight.ts",
      'try {\n  readFileSync("/tmp/castles-planted", { flag: "a" });\n} catch {}'
    ),
  ],
  [
    "readFileSync with a write flag beside an encoding",
    append("preflight.ts", 'readFileSync("x", { encoding: "utf8", flag: "w" });'),
  ],
  ["readFileSync under another name", append("preflight.ts", "const read = readFileSync;")],
  [
    "readFileSync with a flag between string-borne comment markers",
    append("preflight.ts", 'const a = "/*"; readFileSync("x", { flag: "a" }); const b = "*/";'),
  ],
  [
    "readFileSync of a named file",
    append("preflight.ts", 'const local = readFileSync(".env", "utf8");'),
  ],
  [
    "readFileSync of the same argument with a flag",
    append("preflight.ts", 'readFileSync(path, { encoding: "utf8", flag: "a" });'),
  ],
];

/**
 * Evasions the scan is KNOWN not to catch. They are written down so the scan
 * is not mistaken for a proof: it reads text, so a property name built at run
 * time, or code hidden from the comment stripper and then aliased, gets
 * through. Each entry is the text, the file it goes into, and where: at the
 * end, or first when it has to run before the binding loop to matter.
 *
 * The list is examples, not a complete account. Each entry is one use of a
 * technique, and a technique has more uses than the one written down: the
 * hidden alias of entry two reads the environment in entry six.
 *
 * What the permission-model run below stops is what the first two TEXTS do,
 * not the techniques behind them. The first text builds a function from a
 * string, and code generation from strings is denied; the second writes a
 * report file, and file writes are denied. Nothing in this suite stops the
 * other four, when scanned or when run: the permission-model run does not
 * restrict the environment at all, and it allows reads of the paths each
 * case names, so a read inside those paths succeeds and a denied one wrapped
 * in try/catch goes unreported.
 *
 * Entries three and five each make the one allowed loop read a fifth
 * variable without naming the key list where the scan looks. Five replaces
 * the iterator every array shares and needs no import, so refusing
 * namespace imports would close three and not five. Nothing in this suite
 * shows that only the four binding variables are read; that holds by
 * reading src/.
 *
 * Not a gap any more: a call such as `readFileSync(x, { flag: "a" })`, which
 * creates or appends to a file through an allowed import. The scan now
 * refuses every call but READ_CALL (see SCAN_MUST_CATCH).
 */
const SCAN_KNOWN_GAPS: readonly (readonly [string, string, string, "first"?])[] = [
  [
    "property name built at run time",
    'const k = ["constr", "uctor"].join("");\nconst reach = ([] as any)[k][k]("return this");',
    "cli.ts",
  ],
  [
    "alias hidden between string-borne comment markers",
    'const a = "/*"; const p = process\nconst b = "*/";\n(p as any).report.writeReport("/tmp/castles-report.json");',
    "cli.ts",
  ],
  [
    "the binding key list widened through a namespace import and a computed name, so the one allowed loop reads a fifth variable",
    'import * as profile from "./profile.ts";\n(profile as any)["BINDING_" + "ENVIRONMENT_KEYS"].push("DAYTONA_API_KEY");',
    "preflight.ts",
  ],
  [
    "a read of any file through the one allowed call form, swallowed",
    'try {\n  const path = "/etc/hosts";\n  readFileSync(path, "utf8");\n} catch {}',
    "preflight.ts",
  ],
  // Review rv11 N6.
  [
    "the iterator every array shares replaced, so the one allowed loop reads a fifth variable with the key list never named",
    [
      "const arrays = Object.getPrototypeOf([]);",
      "const plain = arrays[Symbol.iterator];",
      "arrays[Symbol.iterator] = function* (this: string[]) {",
      "  yield* plain.call(this);",
      '  if (this[0] === "CASTLES_PROFILE") {',
      '    yield "DAYTONA_API_KEY";',
      "  }",
      "};",
    ].join("\n"),
    "cli.ts",
    "first",
  ],
  [
    "the hidden alias of entry two, reading a variable outside the binding keys",
    'const a = "/*"; const p = process\nconst b = "*/";\nconst other = (p as any).env.DAYTONA_API_KEY;',
    "cli.ts",
  ],
  // PR #19 review rv19b-d029b92a, recorded by maintainer decision on
  // 2026-11-22. This records the rule's scope, not a new evasion (PR #20
  // read rv20-8fd6a4b7, N6): the built-in-name rule reads quoted text only,
  // and src/ already uses such names as bare identifiers. #3's matchesShape
  // uses one as an object key. A key cannot load a module without a banned
  // word or a disallowed import.
  [
    "a built-in module's name used as an object key rather than a string literal",
    "const shape = { path: (value: unknown) => typeof value === \"string\" };",
    "cli.ts",
  ],
  // PR #20 read rv20-8fd6a4b7, N5; present on main before it. Quotes are
  // paired naively, so an apostrophe inside an earlier string shifts the
  // pairing and a later built-in name in quotes goes uncounted.
  [
    "a built-in module's name in quotes, uncounted because an earlier apostrophe shifts the quote pairing",
    'const a = "it\'s"; const b = "fs";',
    "cli.ts",
  ],
];

test("the capability scan reports each known way of reaching a capability", () => {
  const missed: string[] = [];
  for (const [label, ...plants] of SCAN_MUST_CATCH) {
    const files = readSourceTree();
    for (const plant of plants) {
      plant(files);
    }
    if (scanSources(files).length === 0) {
      missed.push(label);
    }
  }
  assert.deepEqual(missed, []);
});

test("the binding key list is exactly the four CASTLES_ keys", () => {
  // Literal on purpose. The scan pins the declaration's text; this pins the
  // value the CLI loop iterates.
  assert.deepEqual(BINDING_ENVIRONMENT_KEYS, [
    "CASTLES_PROFILE",
    "CASTLES_SANDBOX_ID",
    "CASTLES_OWNER_AGENT_ID",
    "CASTLES_SANDBOX_GENERATION",
  ]);
});

test("the capability scan is a tripwire, not a proof: these known evasions pass it", () => {
  for (const [label, text, file, where] of SCAN_KNOWN_GAPS) {
    const files = readSourceTree();
    (where === "first" ? prepend : append)(file, text)(files);
    assert.deepEqual(scanSources(files), [], label);
  }
  assert.equal(SCAN_KNOWN_GAPS.length, 8);
});

// --- CLI: read-only command, human and JSON, no credentials ----------------

const HARNESS_CANARIES = {
  ANTHROPIC_API_KEY: `${CANARY}-anthropic`,
  COPILOT_GITHUB_TOKEN: `${CANARY}-copilot`,
  DAYTONA_API_KEY: `${CANARY}-daytona`,
  GITHUB_TOKEN: `${CANARY}-github`,
  OPENAI_API_KEY: `${CANARY}-openai`,
};

function cli(args: readonly string[], env: Record<string, string>, cwd: string) {
  return spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(root, "src", "cli.ts"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { HOME: cwd, PATH: process.env.PATH ?? "", ...env },
      timeout: 60_000,
    }
  );
}

test("CLI check is read-only, credential-blind, and emits human and JSON output", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    const before = readdirSync(cwd);
    const json = cli(
      ["check", "--json", "--fixture", casePath("ready")],
      HARNESS_CANARIES,
      cwd
    );
    // A fixture replay that reports ready exits 3, never 0 (review N3).
    assert.equal(json.status, 3, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.status, "ready");
    assert.equal(parsed.evidence, "fixture");

    const human = cli(
      ["check", "--fixture", casePath("public-exposure")],
      HARNESS_CANARIES,
      cwd
    );
    assert.equal(human.status, 1);
    assert.match(human.stdout, /status: incompatible/u);
    assert.match(human.stdout, /public_exposure/u);
    assert.match(human.stdout, /FIXTURE/u);

    for (const run of [json, human]) {
      assert.doesNotMatch(run.stdout + run.stderr, new RegExp(CANARY, "u"));
    }
    assert.deepEqual(readdirSync(cwd), before);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI without a sandbox ID fails closed before any provider path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    const run = cli(["check", "--json"], HARNESS_CANARIES, cwd);
    assert.equal(run.status, 1);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.status, "unavailable");
    assert.deepEqual(
      parsed.reasons.map((reason: { code: string }) => reason.code),
      ["sandbox_id_missing"]
    );
    assert.equal(parsed.providerCalls.inspect, 0);
    assert.equal(parsed.evidence, "none");
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI with a full binding but no upstream seam reports the blocker, not a guess", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    const run = cli(
      ["check", "--json"],
      {
        ...HARNESS_CANARIES,
        CASTLES_OWNER_AGENT_ID: "fixture-agent-0001",
        CASTLES_PROFILE: SUPPORTED_PROFILE.id,
        CASTLES_SANDBOX_GENERATION: "3",
        CASTLES_SANDBOX_ID: "fixture-sandbox-0001",
      },
      cwd
    );
    assert.equal(run.status, 1);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.status, "unavailable");
    assert.deepEqual(
      parsed.reasons.map((reason: { code: string }) => reason.code),
      ["upstream_seam_missing"]
    );
    assert.equal(parsed.providerCalls.inspect, 0);
    assert.equal(parsed.upstream.issue, UPSTREAM_SEAM.issue);
    assert.doesNotMatch(run.stdout, /fixture-sandbox-0001/u);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI rejects unknown commands and flags with a usage error", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    assert.equal(cli(["start"], {}, cwd).status, 2);
    assert.equal(cli(["check", "--create"], {}, cwd).status, 2);
    assert.equal(cli([], {}, cwd).status, 2);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI exits 2, with nothing on stdout, for an unreadable or unlabelled fixture", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    const ready = JSON.parse(readFileSync(casePath("ready"), "utf8"));
    const files: Record<string, string> = {
      "array.json": "[]",
      "empty.json": "",
      "no-env.json": JSON.stringify({ ...ready, env: undefined }),
      "no-expect.json": JSON.stringify({ ...ready, expect: undefined }),
      "not-json.json": "{ not json",
      "null.json": "null",
      "relabelled.json": JSON.stringify({ ...ready, fixture: "captured" }),
      "unlabelled.json": JSON.stringify({ ...ready, fixture: undefined }),
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(cwd, name), body);
    }
    for (const path of [
      ...Object.keys(files).map((name) => join(cwd, name)),
      join(cwd, "does-not-exist.json"),
      cwd,
    ]) {
      for (const flags of [["--json"], []]) {
        const run = cli(["check", ...flags, "--fixture", path], {}, cwd);
        assert.equal(run.status, 2, path);
        assert.equal(run.stdout, "", path);
        assert.equal(
          run.stderr,
          "castles: not a readable synthetic fixture case\n",
          path
        );
      }
    }
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI exit code follows status and evidence for every fixture case", () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    for (const name of ["ready", "stopped", "wrong-owner", "missing-id"]) {
      const run = cli(["check", "--json", "--fixture", casePath(name)], {}, cwd);
      const parsed = JSON.parse(run.stdout);
      assert.equal(parsed.evidence, "fixture", name);
      assert.equal(run.status, parsed.status === "ready" ? 3 : 1, name);
      assert.equal(name === "ready", parsed.status === "ready", name);
    }
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("CLI loads the binding from .env.local, and exported variables win", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "castles-cli-"));
  try {
    const fromFile = {
      CASTLES_OWNER_AGENT_ID: "fixture-agent-0002",
      CASTLES_PROFILE: SUPPORTED_PROFILE.id,
      CASTLES_SANDBOX_GENERATION: "7",
      CASTLES_SANDBOX_ID: "fixture-sandbox-0002",
    };
    writeFileSync(
      join(cwd, ".env.local"),
      [
        ...Object.entries(fromFile).map(([key, value]) => `${key}=${value}`),
        `DAYTONA_API_KEY=${CANARY}-file`,
        "",
      ].join("\n")
    );
    const aliases = async (env: Record<string, string>) =>
      (await runPreflight(env, null)).target;

    const fileOnly = cli(["check", "--json"], HARNESS_CANARIES, cwd);
    assert.equal(fileOnly.status, 1);
    const parsedFile = JSON.parse(fileOnly.stdout);
    assert.deepEqual(parsedFile.target, await aliases(fromFile));
    assert.equal(parsedFile.target.expectedGeneration, 7);
    assert.deepEqual(parsedFile.reasons, [{ code: "upstream_seam_missing" }]);
    assert.equal(parsedFile.evidence, "none");

    const exported = {
      CASTLES_SANDBOX_GENERATION: "9",
      CASTLES_SANDBOX_ID: "fixture-sandbox-0003",
    };
    const mixed = cli(
      ["check", "--json"],
      { ...HARNESS_CANARIES, ...exported },
      cwd
    );
    const parsedMixed = JSON.parse(mixed.stdout);
    assert.deepEqual(
      parsedMixed.target,
      await aliases({ ...fromFile, ...exported })
    );
    assert.equal(parsedMixed.target.expectedGeneration, 9);
    assert.notEqual(
      parsedMixed.target.sandboxAlias,
      parsedFile.target.sandboxAlias
    );
    assert.equal(parsedMixed.target.ownerAlias, parsedFile.target.ownerAlias);

    // With --fixture the file is not consulted: the case file is the binding.
    const replay = cli(
      ["check", "--json", "--fixture", casePath("ready")],
      HARNESS_CANARIES,
      cwd
    );
    assert.equal(replay.status, 3);
    assert.deepEqual(
      JSON.parse(replay.stdout).target,
      await aliases(loadFixtureCase(casePath("ready")).env)
    );

    for (const run of [fileOnly, mixed, replay]) {
      assert.doesNotMatch(run.stdout + run.stderr, /canary/iu);
      assert.doesNotMatch(run.stdout + run.stderr, /fixture-sandbox-\d+/u);
    }
    assert.deepEqual(readdirSync(cwd), [".env.local"]);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

// --- Runtime: the CLI under Node's permission model (review N2) -------------

/**
 * What this proves, where it runs: on the paths exercised below, the CLI
 * produces its normal output with file-system writes, child processes,
 * worker threads, native addons, WASI and code generation from strings all
 * denied by the Node runtime, and with file-system reads limited to src/ and
 * the one path each case names. The controls show the confinement is real:
 * the same command fails when one such capability is planted in a copy.
 *
 * What it does not prove:
 * - Network. Node denies network under the permission model only where the
 *   `--allow-net` flag exists (not in Node 22 or 24). There, nothing in this
 *   suite stops a network call at run time; only the scan looks for one.
 * - Paths not exercised here.
 * - An attempt wrapped in try/catch: it is denied, but nothing reports it.
 * - Anything about a run without these flags. `pnpm check` runs through tsx
 *   with no permission model; this test is not a sandbox for operators.
 *
 * Where it does not run: it needs `--permission` and built-in type stripping.
 * Observed: it runs on Node 22.23.5, 24.22.0 and 26.12.0, and is skipped on
 * Node 22.0.0, the stated minimum, where only the scan applies. The first
 * 22.x release on which it runs was not determined.
 */
const allowedNodeFlags = process.allowedNodeEnvironmentFlags;
const PERMISSION_SKIP: string | false =
  allowedNodeFlags.has("--permission") &&
  Boolean((process.features as { typescript?: unknown }).typescript)
    ? false
    : `Node ${process.version} lacks --permission or built-in type stripping; the permission-model run is skipped and only the static scan applies`;
const NETWORK_SKIP: string | false =
  PERMISSION_SKIP ||
  (allowedNodeFlags.has("--allow-net")
    ? false
    : `Node ${process.version} has no network permission (--allow-net); network is NOT denied at run time on this version`);

function confined(
  sourceRoot: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  readable: readonly string[] = []
) {
  return spawnSync(
    process.execPath,
    [
      "--permission",
      "--disallow-code-generation-from-strings",
      // No --allow-fs-write, --allow-child-process, --allow-worker,
      // --allow-addons, --allow-wasi or --allow-net.
      ...[sourceRoot, ...readable].map((path) => `--allow-fs-read=${path}`),
      join(sourceRoot, "cli.ts"),
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { HOME: cwd, PATH: "", ...env },
      timeout: 60_000,
    }
  );
}

const sourceRoot = join(root, "src");

test(
  "CLI runs unchanged with writes, child processes, workers, addons, WASI and string code generation denied",
  { skip: PERMISSION_SKIP },
  async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "castles-confined-")));
    try {
      const expected = async (name: string) => {
        const fixture = loadFixtureCase(casePath(name));
        return runPreflight(
          fixture.env,
          createFixtureInspectionClient(fixture)
        );
      };

      const ready = confined(
        sourceRoot,
        ["check", "--json", "--fixture", casePath("ready")],
        HARNESS_CANARIES,
        cwd,
        [casePath("ready")]
      );
      assert.equal(ready.status, 3, ready.stderr);
      assert.equal(ready.stdout, renderJson(await expected("ready")));

      const exposed = confined(
        sourceRoot,
        ["check", "--fixture", casePath("public-exposure")],
        HARNESS_CANARIES,
        cwd,
        [casePath("public-exposure")]
      );
      assert.equal(exposed.status, 1, exposed.stderr);
      assert.equal(
        exposed.stdout,
        renderHuman(await expected("public-exposure"))
      );

      const binding = {
        CASTLES_OWNER_AGENT_ID: "fixture-agent-0002",
        CASTLES_PROFILE: SUPPORTED_PROFILE.id,
        CASTLES_SANDBOX_GENERATION: "7",
        CASTLES_SANDBOX_ID: "fixture-sandbox-0002",
      };
      writeFileSync(
        join(cwd, ".env.local"),
        `${Object.entries(binding)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`
      );
      const live = confined(
        sourceRoot,
        ["check", "--json"],
        HARNESS_CANARIES,
        cwd,
        [join(cwd, ".env.local")]
      );
      assert.equal(live.status, 1, live.stderr);
      assert.equal(live.stdout, renderJson(await runPreflight(binding, null)));

      const usage = confined(sourceRoot, ["start"], {}, cwd);
      assert.equal(usage.status, 2);
      assert.equal(usage.stdout, "");

      for (const run of [ready, exposed, live, usage]) {
        assert.doesNotMatch(run.stderr, /ERR_ACCESS_DENIED|EvalError/u);
        assert.doesNotMatch(run.stdout + run.stderr, /canary/iu);
      }
      assert.deepEqual(readdirSync(cwd), [".env.local"]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  }
);

/** A copy of src/ with one line planted at the top of cli.ts. */
function plantedCopy(directory: string, name: string, plant: string): string {
  const copy = join(directory, name);
  mkdirSync(copy);
  for (const [file, source] of readSourceTree()) {
    writeFileSync(
      join(copy, file),
      file === "cli.ts" && plant !== ""
        ? source.replace(
            'import process from "node:process";',
            `import process from "node:process";\n${plant}`
          )
        : source
    );
  }
  return copy;
}

test(
  "control: a planted write, spawn, worker, report or generated function fails under the same confinement",
  { skip: PERMISSION_SKIP },
  () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "castles-control-"))
    );
    try {
      const target = join(directory, "written-by-plant");
      const args = ["check", "--json", "--fixture", casePath("ready")];
      const run = (name: string, plant: string) =>
        confined(plantedCopy(directory, name, plant), args, {}, directory, [
          casePath("ready"),
        ]);

      // The unmodified copy behaves like the original, so a failure below is
      // caused by the plant and not by copying.
      const clean = run("clean", "");
      assert.equal(clean.status, 3, clean.stderr);

      const controls: [string, string, RegExp][] = [
        [
          "file write",
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(target)}, "x");`,
          /ERR_ACCESS_DENIED/u,
        ],
        [
          "child process",
          `process["getBuiltinModule"]("node:child_process").spawnSync(process.execPath, ["--version"]);`,
          /ERR_ACCESS_DENIED/u,
        ],
        [
          "diagnostic report",
          `process.report.writeReport(${JSON.stringify(target)});`,
          /ERR_ACCESS_DENIED/u,
        ],
        [
          "worker thread",
          `new (process.getBuiltinModule("node:worker_threads").Worker)("1", { eval: true });`,
          /ERR_ACCESS_DENIED/u,
        ],
        [
          "function built from a string",
          SCAN_KNOWN_GAPS[0]?.[1].replace(/ as any/gu, "") ?? "",
          /EvalError/u,
        ],
        [
          "hidden alias of process",
          (SCAN_KNOWN_GAPS[1]?.[1] ?? "")
            .replace(/ as any/gu, "")
            .replace("/tmp/castles-report.json", target),
          /ERR_ACCESS_DENIED/u,
        ],
      ];
      for (const [label, plant, error] of controls) {
        const planted = run(label.replaceAll(" ", "-"), plant);
        assert.notEqual(planted.status, 3, label);
        assert.notEqual(planted.status, 0, label);
        assert.match(planted.stderr, error, label);
        assert.equal(existsSync(target), false, label);
      }

      // The stated limit: a swallowed attempt is denied, and goes unreported.
      const swallowed = run(
        "swallowed",
        `import { writeFileSync } from "node:fs";\ntry { writeFileSync(${JSON.stringify(target)}, "x"); } catch {}`
      );
      assert.equal(swallowed.status, 3);
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

test(
  "control: a planted network connection fails under the same confinement",
  { skip: NETWORK_SKIP },
  () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "castles-control-"))
    );
    try {
      const planted = confined(
        plantedCopy(
          directory,
          "network",
          `process.getBuiltinModule("node:net").connect(9, "127.0.0.1");`
        ),
        ["check", "--json", "--fixture", casePath("ready")],
        {},
        directory,
        [casePath("ready")]
      );
      assert.notEqual(planted.status, 3);
      assert.notEqual(planted.status, 0);
      assert.match(planted.stderr, /ERR_ACCESS_DENIED/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

// --- Boundaries found by single-edit mutation of src/ (worker mut2-0cb24bd4) --
//
// Each test below exists because one edit to src/preflight.ts or
// src/profile.ts (a flipped comparison, a changed literal, a removed
// statement) left the suite at b5d7fc1 green. Tests only: every one passes
// against unmodified source. Edits that draft PR #11 (fa95bbc) already turns
// red have no test here.

const READY_TARGET = Object.freeze({
  expectedGeneration: 3,
  ownerAlias: "own_76a2176ac79a",
  profile: "castles.daytona-private-linux.v1",
  sandboxAlias: "sbx_08d40473afdf",
});

const HUMAN_TARGET_LINE =
  "target: sandbox sbx_08d40473afdf, owner own_76a2176ac79a, generation 3, profile castles.daytona-private-linux.v1";
const HUMAN_POLICY_LINES = [
  "source policy (pinned; not an observation):",
  "  profile castles.daytona-private-linux.v1; target 2 vCPU / 4 GiB / 10 GiB; @daytona/sdk@0.231.1; 22 source pins (see --json)",
];
const HUMAN_PLATFORM =
  "platform not reported (policy: linux from the qualified snapshot)";
const HUMAN_IDENTITY_LINE =
  "  identity configuration current; credential boundary true; ownership labels true; generation label true";
const HUMAN_SEAM_LINE =
  "upstream seam: missing - https://github.com/OpenCoven/coven-agents/issues/296";

test("human output: a ready result is exactly these lines", async () => {
  const { result } = await runCase("ready");
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: ready",
      "evidence: FIXTURE (synthetic input; not provider evidence)",
      HUMAN_TARGET_LINE,
      "observed (as reported through the seam):",
      `  state started; 2 vCPU / 4 GiB RAM / 10 GiB disk; snapshot coven-agents-copilot-2; ${HUMAN_PLATFORM}; server sdk 0.231.1`,
      "  public false; domain allow list configured true, matches policy true; network allow list false; outbound proxy false; block-all false",
      "  auto-stop 15 min; auto-archive 10080 min; auto-delete -1; ttl absent; volumes 0; warm pool false; linked sandbox false",
      "  binding generation 3, lifecycle ready, attempt fence clear",
      HUMAN_IDENTITY_LINE,
      ...HUMAN_POLICY_LINES,
      "provider calls: inspect 1; mutations 0 (the client seam has none)",
      HUMAN_SEAM_LINE,
      "",
    ].join("\n")
  );
});

test("human output: a refusal lists its reason without a field and discloses nothing", async () => {
  const { result } = await runCase("missing-sandbox");
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: unavailable",
      "evidence: FIXTURE (synthetic input; not provider evidence)",
      HUMAN_TARGET_LINE,
      "reasons:",
      "  - sandbox_not_found",
      "observed: nothing disclosed",
      ...HUMAN_POLICY_LINES,
      "provider calls: inspect 1; mutations 0 (the client seam has none)",
      HUMAN_SEAM_LINE,
      "",
    ].join("\n")
  );
});

test("human output: an unconfigured binding with no client names each missing value", async () => {
  const result = await runPreflight({}, null);
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: unavailable",
      "evidence: none (no inspection was made)",
      "target: sandbox (not configured), owner (not configured), generation (not configured), profile (not configured)",
      "reasons:",
      "  - sandbox_id_missing",
      "observed: nothing disclosed",
      ...HUMAN_POLICY_LINES,
      "provider calls: inspect 0; mutations 0 (the client seam has none)",
      HUMAN_SEAM_LINE,
      "",
    ].join("\n")
  );
});

test("human output: every unstated observed value is a question mark, and each reason carries its field", async () => {
  const result = await withInspection((inspection) => {
    const { observed } = inspection;
    delete observed.state;
    observed.cpu = "2";
    observed.memoryGib = 1.5;
    observed.diskGib = null;
    observed.snapshot = 7;
    inspection.policy.sdkVersion = 231;
    observed.public = "no";
    observed.domainAllowListConfigured = "yes";
    observed.autoStopInterval = "15";
    observed.autoArchiveInterval = null;
    delete observed.autoDeleteInterval;
    observed.autoPauseInterval = 0.5;
    delete observed.autoDestroyAtConfigured;
    observed.gpu = "0";
    observed.target = 1;
    observed.networkBlockAll = 1;
  });
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: incompatible",
      "evidence: FIXTURE (synthetic input; not provider evidence)",
      HUMAN_TARGET_LINE,
      "reasons:",
      "  - sdk_generation_mismatch (policy.sdkVersion)",
      "  - metadata_missing (state)",
      "  - metadata_missing (public)",
      "  - metadata_missing (networkBlockAll)",
      "  - metadata_missing (domainAllowListConfigured)",
      "  - metadata_missing (autoStopInterval)",
      "  - metadata_missing (autoArchiveInterval)",
      "  - metadata_missing (autoDeleteInterval)",
      "  - metadata_missing (autoPauseInterval)",
      "  - metadata_missing (autoDestroyAtConfigured)",
      "  - metadata_missing (snapshot)",
      "  - metadata_missing (target)",
      "  - metadata_missing (cpu)",
      "  - metadata_missing (memoryGib)",
      "  - metadata_missing (diskGib)",
      "  - metadata_missing (gpu)",
      "observed (as reported through the seam):",
      `  state ?; ? vCPU / ? GiB RAM / ? GiB disk; snapshot ?; ${HUMAN_PLATFORM}; server sdk ?`,
      "  public ?; domain allow list configured ?, matches policy true; network allow list false; outbound proxy false; block-all ?",
      "  auto-stop ? min; auto-archive ? min; auto-delete ?; ttl ?; volumes 0; warm pool false; linked sandbox false",
      "  binding generation 3, lifecycle ready, attempt fence clear",
      HUMAN_IDENTITY_LINE,
      ...HUMAN_POLICY_LINES,
      "provider calls: inspect 1; mutations 0 (the client seam has none)",
      HUMAN_SEAM_LINE,
      "",
    ].join("\n")
  );
});

test("human output: a stated zero or false is printed, never read as unstated", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as any;
  inspection.body.record.generation = 0;
  Object.assign(inspection.body.observed, {
    autoArchiveInterval: 0,
    autoDeleteInterval: 0,
    autoDestroyAtConfigured: true,
    autoStopInterval: 0,
    cpu: 0,
    diskGib: 0,
    memoryGib: 0,
  });
  const result = await runPreflight(
    { ...fixture.env, CASTLES_SANDBOX_GENERATION: "0" },
    tripwireClient(() => inspection).client
  );
  assert.equal(result.target.expectedGeneration, 0);
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: incompatible",
      "evidence: FIXTURE (synthetic input; not provider evidence)",
      "target: sandbox sbx_08d40473afdf, owner own_76a2176ac79a, generation 0, profile castles.daytona-private-linux.v1",
      "reasons:",
      "  - lifecycle_auto_stop (autoStopInterval)",
      "  - lifecycle_auto_archive (autoArchiveInterval)",
      "  - lifecycle_auto_delete (autoDeleteInterval)",
      "  - lifecycle_ttl (autoDestroyAtConfigured)",
      "  - resources_out_of_policy (resources)",
      "observed (as reported through the seam):",
      `  state started; 0 vCPU / 0 GiB RAM / 0 GiB disk; snapshot coven-agents-copilot-2; ${HUMAN_PLATFORM}; server sdk 0.231.1`,
      "  public false; domain allow list configured true, matches policy true; network allow list false; outbound proxy false; block-all false",
      "  auto-stop 0 min; auto-archive 0 min; auto-delete 0; ttl present; volumes 0; warm pool false; linked sandbox false",
      "  binding generation 0, lifecycle ready, attempt fence clear",
      HUMAN_IDENTITY_LINE,
      ...HUMAN_POLICY_LINES,
      "provider calls: inspect 1; mutations 0 (the client seam has none)",
      HUMAN_SEAM_LINE,
      "",
    ].join("\n")
  );
});

test("human output: the live-provider evidence line is this literal", async () => {
  // No client yields live evidence at this head, so the line is reachable
  // only through the renderer. Altering a result by hand is exactly what
  // `isLiveReady` cannot detect; this pins the wording, not readiness.
  const { result } = await runCase("ready");
  const lines = renderHuman({ ...result, evidence: "live-provider" }).split(
    "\n"
  );
  assert.equal(
    lines[1],
    "evidence: live provider read through the owning service"
  );
});

test("JSON output is the result itself, indented by two spaces, with one final newline", async () => {
  for (const name of ["ready", "missing-id", "wrong-owner"]) {
    const { result } = await runCase(name);
    assert.equal(
      renderJson(result),
      `${JSON.stringify(result, null, 2)}\n`,
      name
    );
  }
});

test("target: the aliases, generation and profile are these exact values on every path that has them", async () => {
  // The aliases are the first 12 hex digits of SHA-256 over
  // "castles.<prefix>\0<configured value>"; written out, not derived.
  const ready = await runCase("ready");
  assert.deepEqual(ready.result.target, READY_TARGET);

  // A refusal and an identity failure disclose nothing observed, and still
  // name the configured target by alias.
  for (const name of [
    "missing-sandbox",
    "ambiguous-lookup",
    "unavailable-provider",
    "wrong-owner",
    "binding-mismatch",
    "mismatched-returned-id",
  ]) {
    const { result } = await runCase(name);
    assert.equal(result.observed, null, name);
    assert.deepEqual(result.target, READY_TARGET, name);
  }
  const otherAgent = await withInspection((inspection) => {
    inspection.record.agentId = "fixture-agent-0002";
  });
  assert.deepEqual(otherAgent.target, READY_TARGET);

  // A generation of zero is a configured value, not an absent one.
  const zero = await runPreflight(
    { ...VALID_ENV, CASTLES_SANDBOX_GENERATION: "0" },
    null
  );
  assert.deepEqual(zero.target, { ...READY_TARGET, expectedGeneration: 0 });
});

test("target: a binding that fails part-way keeps exactly the values parsed before the failure", async () => {
  const cases: [Record<string, string | undefined>, string, object][] = [
    [
      { ...VALID_ENV, CASTLES_PROFILE: undefined },
      "profile_missing",
      {
        expectedGeneration: null,
        ownerAlias: null,
        profile: null,
        sandboxAlias: READY_TARGET.sandboxAlias,
      },
    ],
    [
      { ...VALID_ENV, CASTLES_OWNER_AGENT_ID: undefined },
      "owner_binding_missing",
      {
        expectedGeneration: null,
        ownerAlias: null,
        profile: READY_TARGET.profile,
        sandboxAlias: READY_TARGET.sandboxAlias,
      },
    ],
    [
      { ...VALID_ENV, CASTLES_OWNER_AGENT_ID: "not valid" },
      "owner_binding_invalid",
      {
        expectedGeneration: null,
        ownerAlias: null,
        profile: READY_TARGET.profile,
        sandboxAlias: READY_TARGET.sandboxAlias,
      },
    ],
    [
      { ...VALID_ENV, CASTLES_SANDBOX_GENERATION: undefined },
      "generation_missing",
      { ...READY_TARGET, expectedGeneration: null },
    ],
    [
      { ...VALID_ENV, CASTLES_SANDBOX_GENERATION: "03" },
      "generation_invalid",
      { ...READY_TARGET, expectedGeneration: null },
    ],
  ];
  for (const [environment, problem, target] of cases) {
    const result = await runPreflight(environment, null);
    assert.deepEqual(codes(result), [problem]);
    // deepEqual in strict mode tells an absent key from a null one.
    assert.deepEqual(result.target, target, problem);
  }
});

test("source policy in a result is exactly the pinned profile, block by block", async () => {
  const { result } = await runCase("ready");
  const { pins, ...blocks } = result.sourcePolicy;
  assert.deepEqual(blocks, {
    image: {
      base: "node:22-bookworm-slim",
      qualifiedSnapshot: "coven-agents-copilot-2",
    },
    lifecycle: {
      autoArchiveMinutes: { max: 43_200, min: 60 },
      autoDeleteInterval: -1,
      autoPauseInterval: 0,
      autoStopMinutes: { max: 60, min: 5 },
      ttl: "disabled",
    },
    network: {
      domainAllowList: { basis: "owner-policy-equality" },
      egress: "restricted",
      networkAllowList: { basis: "owner-policy-sets-none", configured: "refused" },
      outboundProxy: { basis: "owner-policy-sets-none", configured: "refused" },
      public: false,
    },
    platform: { architecture: "not-pinned", basis: "qualified-snapshot", os: "linux" },
    profile: "castles.daytona-private-linux.v1",
    resources: {
      caps: { cpu: 4, diskGiB: 10, memoryGiB: 8 },
      floor: { cpu: 1, diskGiB: 10, memoryGiB: 1 },
      target: { cpu: 2, diskGiB: 10, memoryGiB: 4 },
    },
    sdk: { package: "@daytona/sdk", version: "0.231.1" },
  });
  assert.equal(pins.length, 22);
});

test("source policy cannot be altered through a result: every pinned block is frozen", async () => {
  // `sourcePolicy` hands out the profile's own objects. If one were not
  // frozen, a consumer writing to a result would change the policy the next
  // check is held to.
  const unfrozen: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    if (!Object.isFrozen(value)) {
      unfrozen.push(path);
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${path}.${key}`);
    }
  };
  walk(SUPPORTED_PROFILE, "SUPPORTED_PROFILE");
  assert.deepEqual(unfrozen, []);
  for (const [name, table] of Object.entries({
    MUTATION_OWNERS,
    OUTSIDE_LISTED_MUTATIONS,
    SOURCE_PINS,
    UPSTREAM_SEAM,
  })) {
    assert.ok(Object.isFrozen(table), name);
  }
  const { result } = await runCase("ready");
  assert.throws(() => {
    (result.sourcePolicy.resources.caps as { cpu: number }).cpu = 64;
  }, TypeError);
  assert.equal(SUPPORTED_PROFILE.resources.caps.cpu, 4);
});

test("pins: what each source pin covers is these literal descriptions", () => {
  assert.deepEqual(
    SOURCE_PINS.map((entry) => entry.covers),
    [
      "toolchain (pnpm 10.32.1, tsx, TypeScript) and @daytona/sdk 0.231.1",
      "resolved @daytona/sdk 0.231.1 and its API clients",
      "the tsx --test and tsc --noEmit scripts",
      "resource defaults (2 vCPU / 4 GiB / 10 GiB) and caps",
      "auto-stop and auto-archive bounds; TTL 0; auto-delete -1",
      "create parameters (private, non-ephemeral), credential-boundary marker, lifecycle mutations, guarded-bind verification (a read)",
      "observed sandbox field set used for drift (inventory item)",
      "versioned snapshot naming",
      "snapshot image base (Linux); snapshot creation (outside the listed mutations)",
      "persistent resource lifecycle contract and sandbox lifecycle states",
      "canonical agent record: sandbox ID, generation, lifecycle",
      "resize owner",
      "recovery delete owner",
      "diagnostic sandbox create and delete owner",
      "command execution inside a sandbox (outside the listed mutations)",
      "execution boundary, authority, cleanup fences",
      "ownership table, qualified snapshot, repeat-run gaps",
      "secret references held by the owning service",
      "sandbox-inspection v1: request, record, observed fields, source policy and outcomes",
      "inspection route: media type, abuse budgets, owner credential scope, status per outcome",
      "runner error codes and their HTTP statuses",
      "how each observed field, the SDK version and the identity checks are derived",
    ]
  );
});

test("each single fault is reported as exactly one reason with exactly this field", async () => {
  const faults: [
    string,
    string,
    string,
    (inspection: any) => void,
  ][] = [
    ["incompatible", "public_exposure", "public", (i) => (i.observed.public = true)],
    ["incompatible", "egress_allow_list_unsafe", "domainAllowList", (i) => (i.observed.domainAllowListMatchesPolicy = false)],
    ["incompatible", "egress_allow_list_unsafe", "networkAllowList", (i) => (i.observed.networkAllowListConfigured = true)],
    ["incompatible", "egress_allow_list_unsafe", "outboundProxy", (i) => (i.observed.outboundProxyConfigured = true)],
    ["incompatible", "lifecycle_auto_stop", "autoStopInterval", (i) => (i.observed.autoStopInterval = 4)],
    ["incompatible", "lifecycle_auto_archive", "autoArchiveInterval", (i) => (i.observed.autoArchiveInterval = 59)],
    ["incompatible", "lifecycle_auto_delete", "autoDeleteInterval", (i) => (i.observed.autoDeleteInterval = 0)],
    ["incompatible", "lifecycle_auto_pause", "autoPauseInterval", (i) => (i.observed.autoPauseInterval = 1)],
    ["incompatible", "lifecycle_ttl", "autoDestroyAtConfigured", (i) => (i.observed.autoDestroyAtConfigured = true)],
    ["incompatible", "image_unqualified", "snapshot", (i) => (i.observed.snapshot = "another-snapshot")],
    ["incompatible", "target_unsupported", "target", (i) => (i.observed.target = "ap")],
    ["incompatible", "resources_out_of_policy", "resources", (i) => (i.observed.cpu = 5)],
    ["incompatible", "gpu_present", "gpu", (i) => (i.observed.gpu = 1)],
    ["incompatible", "volumes_present", "volumes", (i) => (i.observed.volumes = 1)],
    ["incompatible", "warm_pool_member", "warmPool", (i) => (i.observed.warmPool = true)],
    ["incompatible", "linked_sandbox_present", "linkedSandbox", (i) => (i.observed.linkedSandbox = true)],
    ["incompatible", "sdk_generation_mismatch", "policy.sdkVersion", (i) => (i.policy.sdkVersion = "0.230.0")],
    ["stopped", "sandbox_stopped", "state", (i) => (i.observed.state = "stopped")],
    ["stopped", "sandbox_stopped", "state", (i) => (i.observed.state = "archived")],
    ["unavailable", "sandbox_destroyed", "state", (i) => (i.observed.state = "destroyed")],
    ["unavailable", "lifecycle_not_settled", "state", (i) => (i.observed.state = "transitioning")],
    ["unavailable", "lifecycle_not_settled", "state", (i) => (i.observed.state = "error")],
    ["unavailable", "lifecycle_not_settled", "state", (i) => (i.observed.state = "unknown")],
    ["unauthorized", "owner_mismatch", "record.agentId", (i) => (i.record.agentId = "fixture-agent-0002")],
    ["unauthorized", "binding_mismatch", "record.sandboxId", (i) => (i.record.sandboxId = "fixture-sandbox-0002")],
    ["unauthorized", "owner_mismatch", "identity.ownershipLabels", (i) => (i.observed.identity.ownershipLabels = false)],
    ["unauthorized", "binding_mismatch", "identity.configuration", (i) => (i.observed.identity.configuration = "mismatch")],
    ["reconciliation-required", "generation_mismatch", "record.generation", (i) => (i.record.generation = 4)],
    ["reconciliation-required", "generation_mismatch", "identity.generationLabel", (i) => (i.observed.identity.generationLabel = false)],
    ["reconciliation-required", "binding_lifecycle_pending", "record.lifecycle", (i) => (i.record.lifecycle = "resizing")],
    ["reconciliation-required", "attempt_fence_held", "record.fence", (i) => (i.record.fence = "attempt_outstanding")],
    ["reconciliation-required", "credential_boundary_unverified", "identity.credentialBoundary", (i) => (i.observed.identity.credentialBoundary = false)],
    ["reconciliation-required", "credential_boundary_unverified", "policy.credentialBoundaryVersion", (i) => (i.policy.credentialBoundaryVersion = "attempt-reset-v2")],
  ];
  for (const [status, code, field, edit] of faults) {
    const result = await withInspection(edit);
    assert.equal(result.status, status, code);
    assert.deepEqual(result.reasons, [{ code, field }], code);
  }
});

test("egress: an unreadable allow list is not also called unrestricted, and a block-all that is not a boolean restricts nothing", async () => {
  for (const field of ["domainAllowListConfigured", "networkAllowListConfigured"]) {
    for (const value of [5, "false", {}, null, undefined]) {
      const unreadable = await withSandbox((sandbox) => {
        sandbox.networkBlockAll = false;
        sandbox.domainAllowListConfigured = false;
        sandbox.networkAllowListConfigured = false;
        sandbox[field] = value;
      });
      assert.deepEqual(
        unreadable.reasons,
        [{ code: "metadata_missing", field }],
        `${field}=${String(value)}`
      );
    }
  }
  for (const value of ["yes", "true", 1, {}]) {
    const notBoolean = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = value;
      sandbox.domainAllowListConfigured = false;
      sandbox.networkAllowListConfigured = false;
    });
    assert.deepEqual(
      notBoolean.reasons,
      [
        { code: "metadata_missing", field: "networkBlockAll" },
        { code: "egress_unrestricted", field: "egress" },
      ],
      String(value)
    );
    assert.equal(notBoolean.observed?.exposure.networkBlockAll, null);
  }
});

test("sdk version echo: a leading zero in any part, or a separator that is not a dot, is unrecognised", async () => {
  for (const version of [
    "00.231.1",
    "0.0231.1",
    "0.231.01",
    "0x231.1",
    "0.231x1",
    "0-231-1",
  ]) {
    const result = await withInspection((inspection) => {
      inspection.policy.sdkVersion = version;
    });
    assert.equal(result.observed?.sdk.version, "unrecognised", version);
    assert.deepEqual(result.reasons, [
      { code: "sdk_generation_mismatch", field: "policy.sdkVersion" },
    ]);
  }
});

test("volumes: anything present that is not a zero count is an attachment, and the count is echoed", async () => {
  // v1 reports a count, so an array (empty or not) is not one.
  for (const value of [{}, { length: 0 }, [], ["fixture-volume"], "", "0", "fixture-volume", 1.5, false, true]) {
    const result = await withSandbox((sandbox) => {
      sandbox.volumes = value;
    });
    assert.deepEqual(
      result.reasons,
      [{ code: "volumes_present", field: "volumes" }],
      JSON.stringify(value)
    );
    assert.equal(result.observed?.attachments.volumes, null);
  }
  const two = await withSandbox((sandbox) => {
    sandbox.volumes = 2;
  });
  assert.deepEqual(two.reasons, [{ code: "volumes_present", field: "volumes" }]);
  assert.equal(two.observed?.attachments.volumes, 2);

  const empty = await withSandbox((sandbox) => {
    sandbox.volumes = 0;
  });
  assert.equal(empty.status, "ready");
  assert.equal(empty.observed?.attachments.volumes, 0);

  // Missing metadata refuses with an unknown count. v1 states "no volume"
  // as 0, so an explicit null is unstated too (it was stated absence before).
  for (const edit of [
    (sandbox: Record<string, unknown>) => delete sandbox.volumes,
    (sandbox: Record<string, unknown>) => (sandbox.volumes = null),
  ]) {
    const unstated = await withSandbox(edit);
    assert.equal(unstated.status, "incompatible");
    assert.deepEqual(unstated.reasons, [{ code: "metadata_missing", field: "volumes" }]);
    assert.equal(unstated.observed?.attachments.volumes, null);
  }
});

test("observed attachments, TTL and exposure report what the seam stated, field by field", async () => {
  const attachments = async (edit: (sandbox: Record<string, unknown>) => void) =>
    (await withSandbox(edit)).observed?.attachments;
  assert.deepEqual(
    await attachments((sandbox) => {
      sandbox.linkedSandbox = true;
    }),
    { linkedSandbox: true, volumes: 0, warmPool: false }
  );
  assert.deepEqual(
    await attachments((sandbox) => {
      sandbox.warmPool = true;
    }),
    { linkedSandbox: false, volumes: 0, warmPool: true }
  );
  // v1 states each as a boolean: anything else is unstated, not "present".
  for (const value of ["", 0, "true", 1, null, undefined]) {
    const result = await withSandbox((sandbox) => {
      sandbox.linkedSandbox = value;
      sandbox.warmPool = value;
      sandbox.autoDestroyAtConfigured = value;
    });
    assert.deepEqual(result.observed?.attachments, {
      linkedSandbox: null,
      volumes: 0,
      warmPool: null,
    });
    assert.equal(result.observed?.lifecycle.autoDestroyAt, null);
    assert.deepEqual(result.reasons, [
      { code: "metadata_missing", field: "autoDestroyAtConfigured" },
      { code: "metadata_missing", field: "warmPool" },
      { code: "metadata_missing", field: "linkedSandbox" },
    ]);
  }
  const ttl = await withSandbox((sandbox) => {
    sandbox.autoDestroyAtConfigured = true;
  });
  assert.equal(ttl.observed?.lifecycle.autoDestroyAt, "present");
  assert.deepEqual(codes(ttl), ["lifecycle_ttl"]);
  const noTtl = await withSandbox((sandbox) => {
    sandbox.autoDestroyAtConfigured = false;
  });
  assert.equal(noTtl.observed?.lifecycle.autoDestroyAt, "absent");

  // `public`, `networkBlockAll` and each egress comparison are separate
  // readings.
  const restricted = {
    domainAllowListConfigured: true,
    domainAllowListMatchesPolicy: true,
    networkAllowListConfigured: false,
    outboundProxyConfigured: false,
  };
  const blocked = await withSandbox((sandbox) => {
    sandbox.public = false;
    sandbox.networkBlockAll = true;
  });
  assert.deepEqual(blocked.observed?.exposure, {
    ...restricted,
    networkBlockAll: true,
    public: false,
  });
  const exposed = await withSandbox((sandbox) => {
    sandbox.public = true;
    sandbox.networkBlockAll = false;
  });
  assert.deepEqual(exposed.observed?.exposure, {
    ...restricted,
    networkBlockAll: false,
    public: true,
  });
  const drifted = await withSandbox((sandbox) => {
    sandbox.domainAllowListMatchesPolicy = false;
    sandbox.networkAllowListConfigured = true;
    sandbox.outboundProxyConfigured = true;
  });
  assert.deepEqual(drifted.observed?.exposure, {
    domainAllowListConfigured: true,
    domainAllowListMatchesPolicy: false,
    networkAllowListConfigured: true,
    networkBlockAll: false,
    outboundProxyConfigured: true,
    public: false,
  });
  for (const value of ["false", 0, null, undefined]) {
    const unstated = await withSandbox((sandbox) => {
      sandbox.public = value;
    });
    assert.equal(unstated.observed?.exposure.public, null);
    assert.deepEqual(unstated.reasons, [
      { code: "metadata_missing", field: "public" },
    ]);
  }
});

test("a credential-boundary check that is not exactly true is not a check", async () => {
  // Upstream withholds the labels and reports its own check of the marker.
  // An array carrying an extra key is not plain data: the whole answer is
  // refused (v1 review tests).
  const odd = await withInspection((inspection) => {
    inspection.observed.identity.credentialBoundary = Object.assign([], {
      credentialBoundaryVersion: "attempt-reset-v1",
    });
  });
  assert.deepEqual(codes(odd), ["inspection_contract_violation"]);
  for (const check of [
    [],
    ["attempt-reset-v1"],
    "attempt-reset-v1",
    "true",
    1,
    {},
    null,
    false,
  ]) {
    const result = await withInspection((inspection) => {
      inspection.observed.identity.credentialBoundary = check;
    });
    assert.deepEqual(result.reasons, [
      {
        code: "credential_boundary_unverified",
        field: "identity.credentialBoundary",
      },
    ]);
    assert.equal(result.observed?.identity.credentialBoundary === true, false);
  }
});

test("binding: a profile is compared exactly, with no trimming and no case folding", async () => {
  const id = "castles.daytona-private-linux.v1";
  for (const profile of [
    ` ${id}`,
    `${id} `,
    `${id}\n`,
    `\t${id}`,
    id.toUpperCase(),
    "Castles.daytona-private-linux.v1",
    " ",
    "\n",
  ]) {
    const environment = { ...VALID_ENV, CASTLES_PROFILE: profile };
    const parsed = parseBinding(environment);
    assert.equal(parsed.ok, false, JSON.stringify(profile));
    assert.equal(
      parsed.ok ? null : parsed.problem,
      "unknown_profile",
      JSON.stringify(profile)
    );
    const result = await runPreflight(environment, null);
    assert.equal(result.status, "incompatible");
    assert.deepEqual(result.reasons, [{ code: "unknown_profile" }]);
    assert.equal(result.target.profile, null);
  }
});

function withFixtureFile<T>(content: unknown, use: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "castles-fixture-"));
  try {
    const path = join(directory, "case.json");
    writeFileSync(
      path,
      typeof content === "string" ? content : JSON.stringify(content)
    );
    return use(path);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("fixture loader: each refusal is an Error with exactly this message", () => {
  const original = JSON.parse(readFileSync(casePath("ready"), "utf8"));
  const unlabelled = {
    message: "Refusing a fixture file without the synthetic label.",
    name: "Error",
  };
  const incomplete = {
    message: "Synthetic fixture is missing its env or expect block.",
    name: "Error",
  };
  const { fixture: _label, ...withoutLabel } = original;
  for (const content of ["null", "7", '"text"', "[]", withoutLabel]) {
    withFixtureFile(content, (path) => {
      assert.throws(() => loadFixtureCase(path), unlabelled);
    });
  }
  const { env: _env, ...withoutEnv } = original;
  const { expect: _expect, ...withoutExpect } = original;
  for (const content of [
    withoutEnv,
    withoutExpect,
    { ...original, env: null },
    { ...original, env: "CASTLES_SANDBOX_ID=x" },
    { ...original, expect: null },
    { ...original, expect: 3 },
  ]) {
    withFixtureFile(content, (path) => {
      assert.throws(() => loadFixtureCase(path), incomplete);
    });
  }
});

test("fixture loader: only string binding values are taken, and the case name is a string or \"unnamed\"", () => {
  const original = JSON.parse(readFileSync(casePath("ready"), "utf8"));
  withFixtureFile(
    {
      ...original,
      env: {
        ...original.env,
        CASTLES_OWNER_AGENT_ID: null,
        CASTLES_PROFILE: ["castles.daytona-private-linux.v1"],
        CASTLES_SANDBOX_GENERATION: 3,
      },
    },
    (path) => {
      assert.deepEqual(loadFixtureCase(path).env, {
        CASTLES_SANDBOX_ID: "fixture-sandbox-0001",
      });
    }
  );
  assert.equal(loadFixtureCase(casePath("ready")).case, "ready");
  withFixtureFile({ ...original, case: "synthetic-é-名" }, (path) => {
    assert.equal(loadFixtureCase(path).case, "synthetic-é-名");
  });
  const { case: _case, ...withoutCase } = original;
  for (const content of [
    withoutCase,
    { ...original, case: 7 },
    { ...original, case: null },
    { ...original, case: ["ready"] },
  ]) {
    withFixtureFile(content, (path) => {
      assert.equal(loadFixtureCase(path).case, "unnamed");
    });
  }
});

test("the fixture client answers with a promise for the case's own inspection object", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const client = createFixtureInspectionClient(fixture);
  const answer = client.inspectBoundSandbox({
    agentId: "fixture-agent-0001",
    expectedGeneration: 3,
    sandboxId: "fixture-sandbox-0001",
  });
  assert.ok(answer instanceof Promise);
  assert.equal(await answer, fixture.inspection);
});

test("the abort signal handed to the seam is live during the call and aborted once the check settles", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const outcomes: [string, () => Promise<unknown>, string, number?][] = [
    ["answer", () => Promise.resolve(fixture.inspection), "ready"],
    ["throw", () => Promise.reject(new Error("fixture failure")), "unavailable"],
    ["silence", () => new Promise(() => undefined), "unavailable", 20],
  ];
  for (const [name, respond, status, timeoutMs] of outcomes) {
    const seen: { signal: unknown; abortedAtCall: unknown }[] = [];
    const client: SandboxInspectionClient = {
      inspectBoundSandbox: (_request, options) => {
        seen.push({
          abortedAtCall: options?.signal.aborted,
          signal: options?.signal,
        });
        return respond();
      },
    };
    const result = await runPreflight(
      fixture.env,
      client,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    assert.equal(result.status, status, name);
    assert.equal(seen.length, 1, name);
    const [{ signal, abortedAtCall }] = seen as [(typeof seen)[number]];
    assert.ok(signal instanceof AbortSignal, name);
    assert.equal(abortedAtCall, false, name);
    assert.equal(signal.aborted, true, name);
  }
});

test("N11: the seam method receives exactly the request and options holding only the signal", async () => {
  // Review rv11 N11. The test above pins the signal; this pins the rest of
  // what crosses the seam: two arguments, the request with the three binding
  // values and nothing else, and options with nothing but the signal.
  const fixture = loadFixtureCase(casePath("ready"));
  const received: unknown[][] = [];
  const client: SandboxInspectionClient = {
    inspectBoundSandbox(...args: unknown[]) {
      received.push(args);
      return Promise.resolve(fixture.inspection);
    },
  } as SandboxInspectionClient;
  const result = await runPreflight(fixture.env, client, { timeoutMs: 5_000 });
  assert.equal(result.status, "ready");
  assert.equal(received.length, 1);
  const [args] = received as [unknown[]];
  assert.equal(args.length, 2);
  const [request, options] = args as [Record<string, unknown>, Record<string, unknown>];
  assert.deepEqual(request, {
    agentId: fixture.env.CASTLES_OWNER_AGENT_ID,
    expectedGeneration: Number(fixture.env.CASTLES_SANDBOX_GENERATION),
    sandboxId: fixture.env.CASTLES_SANDBOX_ID,
  });
  assert.deepEqual(Object.keys(options), ["signal"]);
  assert.ok(options.signal instanceof AbortSignal);
});

function runScript(source: string, args: readonly string[] = []) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "castles-script-"))
  );
  try {
    const script = join(directory, "script.mts");
    writeFileSync(script, source);
    return spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), script, ...args],
      {
        cwd: directory,
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH ?? "" },
        timeout: 15_000,
      }
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const PREFLIGHT_MODULE = JSON.stringify(
  new URL("../src/preflight.ts", import.meta.url).href
);

test("an answered check leaves no deadline timer behind: the process ends at once", () => {
  // With the default 30-second deadline still armed, this process would
  // stay alive until the timer fired and the run would be killed at 15 s.
  const run = runScript(
    `import { createFixtureInspectionClient, loadFixtureCase, runPreflight } from ${PREFLIGHT_MODULE};
const fixture = loadFixtureCase(process.argv[2]);
const result = await runPreflight(fixture.env, createFixtureInspectionClient(fixture));
process.stdout.write(result.status + "\\n");
`,
    [casePath("ready")]
  );
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "ready\n");
});

test("the deadline keeps the process alive: a silent provider still yields a result, not an empty exit", () => {
  // If the deadline timer did not hold the event loop open, Node would end
  // this process with nothing pending, no result and a non-zero status.
  const run = runScript(
    `import { loadFixtureCase, runPreflight } from ${PREFLIGHT_MODULE};
const fixture = loadFixtureCase(process.argv[2]);
const result = await runPreflight(
  fixture.env,
  { inspectBoundSandbox: () => new Promise(() => undefined) },
  { timeoutMs: 200 }
);
process.stdout.write(result.status + " " + result.reasons.map((reason) => reason.code).join(",") + "\\n");
`,
    [casePath("ready")]
  );
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "unavailable provider_unavailable\n");
});

// --- Absent keys: four checks that passed when the key was missing ----------
//
// Second read on #3 by rv3-d0dc225b, "Fail-open paths" item 2, executed in
// the checks posted on #3 (issuecomment-6848457839): a client that carries
// over only the upstream fields that fit leaves these keys absent, and each
// check used to pass. They were `todo` tests (mut2-0cb24bd4) while the
// decision was open. This revision decides: an ABSENT key is missing
// metadata (`metadata_missing` with the key as its field, so `incompatible`),
// because a response that omits a key says nothing about it. An explicit
// `null` still read as "not set", as at 13ab3bc. Proposed until accepted.
//
// v1 (coven-agents 0696af12) states each of these as a boolean, so "not set"
// is `false` and an explicit `null` is unstated too: missing metadata. That
// is a change from the line above, listed in the PR as following the
// pending v1 decisions on coven-castles#2.

for (const [key, read, label] of [
  ["autoDestroyAtConfigured", (r: PreflightResult) => r.observed?.lifecycle.autoDestroyAt, "no TTL"],
  ["warmPool", (r: PreflightResult) => r.observed?.attachments.warmPool, "no warm pool"],
  ["linkedSandbox", (r: PreflightResult) => r.observed?.attachments.linkedSandbox, "no linked sandbox"],
] as const) {
  test(`absent key: an absent ${key} is missing metadata, not "${label}"`, async () => {
    const result = await withSandbox((sandbox) => {
      delete sandbox[key];
    });
    assert.equal(result.status, "incompatible");
    assert.deepEqual(result.reasons, [{ code: "metadata_missing", field: key }]);
    assert.equal(read(result), null);
  });
}

test("absent key: with block-all set, absent allow-list comparisons are missing metadata, not \"no list\"", async () => {
  // The case the second read executed: block-all set and both lists dropped
  // by the client. Block-all does not excuse a list nobody stated, since a
  // list can open what block-all closes.
  const result = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = true;
    delete sandbox.domainAllowListConfigured;
    delete sandbox.domainAllowListMatchesPolicy;
    delete sandbox.networkAllowListConfigured;
  });
  assert.equal(result.status, "incompatible");
  assert.deepEqual(result.reasons, [
    { code: "metadata_missing", field: "domainAllowListConfigured" },
    { code: "metadata_missing", field: "domainAllowListMatchesPolicy" },
    { code: "metadata_missing", field: "networkAllowListConfigured" },
  ]);
  assert.equal(result.observed?.exposure.domainAllowListConfigured, null);
  assert.equal(result.observed?.exposure.networkAllowListConfigured, null);
});

test("absent key: each allow list is judged on its own, and an unstated list is not called unrestricted", async () => {
  const cases: [string, (sandbox: Record<string, unknown>) => void, unknown[]][] = [
    [
      "domain list unstated, network list stated as not configured",
      (sandbox) => {
        delete sandbox.domainAllowListConfigured;
        sandbox.networkAllowListConfigured = false;
        sandbox.networkBlockAll = true;
      },
      [{ code: "metadata_missing", field: "domainAllowListConfigured" }],
    ],
    [
      "network list unstated beside a domain list that matches policy",
      (sandbox) => {
        delete sandbox.networkAllowListConfigured;
      },
      [{ code: "metadata_missing", field: "networkAllowListConfigured" }],
    ],
    [
      "proxy unstated",
      (sandbox) => {
        delete sandbox.outboundProxyConfigured;
      },
      [{ code: "metadata_missing", field: "outboundProxyConfigured" }],
    ],
    [
      "both unstated and block-all off: unknown, so not called unrestricted",
      (sandbox) => {
        sandbox.networkBlockAll = false;
        delete sandbox.domainAllowListConfigured;
        delete sandbox.networkAllowListConfigured;
      },
      [
        { code: "metadata_missing", field: "domainAllowListConfigured" },
        { code: "metadata_missing", field: "networkAllowListConfigured" },
      ],
    ],
  ];
  for (const [label, edit, reasons] of cases) {
    const result = await withSandbox(edit);
    assert.equal(result.status, "incompatible", label);
    assert.deepEqual(result.reasons, reasons, label);
  }
});

test("absent key: in v1 false is the stated \"not set\", and an explicit null is unstated", async () => {
  const stated = await withSandbox((sandbox) => {
    sandbox.autoDestroyAtConfigured = false;
    sandbox.warmPool = false;
    sandbox.linkedSandbox = false;
    sandbox.networkBlockAll = true;
    sandbox.domainAllowListConfigured = false;
    sandbox.networkAllowListConfigured = false;
  });
  assert.equal(stated.status, "ready");
  assert.deepEqual(stated.reasons, []);
  // With block-all off and no list configured, egress is unrestricted.
  const open = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = false;
    sandbox.domainAllowListConfigured = false;
    sandbox.networkAllowListConfigured = false;
  });
  assert.deepEqual(open.reasons, [{ code: "egress_unrestricted", field: "egress" }]);
  const nulls = await withSandbox((sandbox) => {
    sandbox.autoDestroyAtConfigured = null;
    sandbox.warmPool = null;
    sandbox.linkedSandbox = null;
  });
  assert.deepEqual(nulls.reasons, [
    { code: "metadata_missing", field: "autoDestroyAtConfigured" },
    { code: "metadata_missing", field: "warmPool" },
    { code: "metadata_missing", field: "linkedSandbox" },
  ]);
});

// --- The deadline timer --------------------------------------------------------
//
// Deleting `clearTimeout(timer)` leaves individual results unchanged but
// keeps the full suite alive. The earlier "an answered check leaves no
// deadline timer behind" subprocess test also catches it when run alone.
// This test checks every created timer directly for each inspected outcome.

test("the deadline timer is cleared once the inspection settles, whatever the outcome", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created: unknown[] = [];
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id = realSet(handler, ms);
    created.push(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(id);
    realClear(id);
  }) as typeof clearTimeout;
  try {
    for (const inspect of [
      async () => fixture.inspection,
      async () => {
        throw new Error("synthetic refusal");
      },
      async () => ({ synthetic: "not an inspection" }),
    ]) {
      await runPreflight(
        fixture.env,
        { inspectBoundSandbox: inspect } as unknown as SandboxInspectionClient,
        { timeoutMs: 60_000 }
      );
    }
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(created.length, 3, "one deadline timer per inspection");
  assert.deepEqual(
    created.filter((id) => !cleared.has(id)),
    [],
    "every deadline timer is cleared"
  );
});

test("missing volumes cannot certify an empty attachment set", async () => {
  // Restoring the absent-as-empty branch must fail this boundary test.
  for (const networkBlockAll of [false, true]) {
    for (const omit of [true, false]) {
      const result = await withSandbox((sandbox) => {
        sandbox.networkBlockAll = networkBlockAll;
        if (omit) delete sandbox.volumes;
        else sandbox.volumes = undefined;
      });
      assert.equal(result.status, "incompatible");
      assert.deepEqual(result.reasons, [
        { code: "metadata_missing", field: "volumes" },
      ]);
      assert.equal(result.observed?.attachments.volumes, null);
      assert.equal(result.providerCalls.inspect, 1);
      assert.equal(result.evidence, "fixture");
      assert.equal(isLiveReady(result), false);
    }
  }
});

test("unstated metadata is echoed as unknown rather than a safe observation", async () => {
  // Collapsing undefined into null/false/zero would contradict these reasons.
  const result = await withSandbox((sandbox) => {
    delete sandbox.autoDestroyAtConfigured;
    delete sandbox.warmPool;
    delete sandbox.linkedSandbox;
    delete sandbox.domainAllowListConfigured;
    delete sandbox.networkAllowListConfigured;
  });
  assert.equal(result.status, "incompatible");
  assert.deepEqual(result.reasons, [
    { code: "metadata_missing", field: "domainAllowListConfigured" },
    { code: "metadata_missing", field: "networkAllowListConfigured" },
    { code: "metadata_missing", field: "autoDestroyAtConfigured" },
    { code: "metadata_missing", field: "warmPool" },
    { code: "metadata_missing", field: "linkedSandbox" },
  ]);
  assert.deepEqual(result.observed?.attachments, {
    linkedSandbox: null,
    volumes: 0,
    warmPool: null,
  });
  assert.equal(result.observed?.lifecycle.autoDestroyAt, null);
  assert.equal(result.observed?.exposure.domainAllowListConfigured, null);
  assert.equal(result.observed?.exposure.networkAllowListConfigured, null);
  const json = JSON.parse(renderJson(result));
  assert.equal(json.observed.lifecycle.autoDestroyAt, null);
  assert.equal(json.observed.attachments.warmPool, null);
  assert.equal(json.observed.attachments.linkedSandbox, null);
  assert.equal(json.observed.exposure.domainAllowListConfigured, null);
  const human = renderHuman(result);
  assert.ok(human.includes("ttl ?"));
  assert.ok(human.includes("domain allow list configured ?"));
  assert.ok(human.includes("network allow list ?"));
});

// --- Upstream sandbox-inspection v1 (coven-agents 0696af12) ----------------
// The seam landed upstream (coven-agents #311 and #312). These tests pin the
// translation from its v1 answer to Castles' reasons. Every value is
// synthetic, shaped like upstream's strict v1 schema: no answer here was
// captured from a deployment.

const V1_UPSTREAM_SHA = "0696af127207fb82cce734cd8c4ffa437d6f3502";

/** A synthetic v1 answer that should be ready: HTTP status plus JSON body. */
function v1Ready(): { body: any; status: number } {
  return {
    body: {
      observed: {
        autoArchiveInterval: 10_080,
        autoDeleteInterval: -1,
        autoDestroyAtConfigured: false,
        autoPauseInterval: 0,
        autoStopInterval: 15,
        cpu: 2,
        diskGib: 10,
        domainAllowListConfigured: true,
        domainAllowListMatchesPolicy: true,
        gpu: 0,
        identity: {
          configuration: "current",
          credentialBoundary: true,
          generationLabel: true,
          ownershipLabels: true,
        },
        linkedSandbox: false,
        memoryGib: 4,
        networkAllowListConfigured: false,
        networkBlockAll: false,
        outboundProxyConfigured: false,
        public: false,
        snapshot: "coven-agents-copilot-2",
        state: "started",
        target: "us",
        volumes: 0,
        warmPool: false,
      },
      outcome: "observed",
      policy: {
        adapterVersion: "fixture-adapter-1",
        capabilityContractVersion: "fixture-capability-1",
        credentialBoundaryVersion: "attempt-reset-v1",
        harnesses: [],
        resources: { cpu: 2, diskGib: 10, memoryGib: 4 },
        sdkVersion: "0.231.1",
        snapshotName: "coven-agents-copilot-2",
        target: "us",
      },
      record: {
        agentId: "fixture-agent-0001",
        fence: "none",
        generation: 3,
        lifecycle: "ready",
        sandboxId: "fixture-sandbox-0001",
      },
      version: 1,
    },
    status: 200,
  };
}

async function v1(
  edit: (answer: { body: any; status: number }) => void = () => undefined
) {
  const answer = v1Ready();
  edit(answer);
  const wire = tripwireClient(() => answer);
  const result = await runPreflight(VALID_ENV, wire.client);
  return { result, wire };
}

const V1_DB_RECORD = Object.freeze({
  agentId: "fixture-agent-0001",
  fence: "none",
  generation: 3,
  lifecycle: "ready",
  sandboxId: null,
});

test("v1: a conforming observed answer is ready and asks for exactly the configured binding", async () => {
  const { result, wire } = await v1();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
  assert.deepEqual(wire.requests, [
    {
      agentId: "fixture-agent-0001",
      expectedGeneration: 3,
      sandboxId: "fixture-sandbox-0001",
    },
  ]);
  assert.equal(result.evidence, "fixture");
  assert.equal(isLiveReady(result), false);
});

test("v1: the HTTP status decides a refusal and its body is never read", async () => {
  const refusals: [number, string, string][] = [
    [401, "unauthorized", "unauthenticated"],
    // Pending maintainer decision: 403 (no subscription, or origin refused)
    // and 404 (a missing agent or another tenant's, indistinguishable).
    [403, "unauthorized", "owner_mismatch"],
    [404, "unauthorized", "owner_mismatch"],
    [429, "unavailable", "provider_unavailable"],
    [503, "unavailable", "provider_unavailable"],
  ];
  for (const [status, expected, code] of refusals) {
    for (const body of [
      { error: { code: "fixture-error" } },
      v1Ready().body,
      CANARY,
      undefined,
    ]) {
      const { result, wire } = await v1((answer) => {
        answer.status = status;
        answer.body = body;
      });
      assert.equal(result.status, expected, String(status));
      assert.deepEqual(result.reasons, [{ code }], String(status));
      assert.equal(result.observed, null, String(status));
      assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
      assert.doesNotMatch(renderJson(result) + renderHuman(result), /CANARY/u);
    }
  }
  // 500 is upstream's retryable internal error: see the v1 review tests.
  for (const status of [0, 100, 201, 204, 302, 400, 409, 413, 422, 501, 502, 599, 600, 200.5, -200, "200", null, undefined]) {
    const { result } = await v1((answer) => {
      answer.status = status as number;
    });
    assert.equal(result.status, "unavailable", String(status));
    assert.deepEqual(codes(result), ["inspection_contract_violation"], String(status));
  }
  // A bare v1 body, without its HTTP status, is not an answer.
  const bare = await runPreflight(
    VALID_ENV,
    tripwireClient(() => v1Ready().body).client
  );
  assert.deepEqual(codes(bare), ["inspection_contract_violation"]);
});

test("v1: each refusal body maps to an existing Castles reason", async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ outcome: "not_found", policy: v1Ready().body.policy, record: { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" } }, "unavailable", "sandbox_not_found"],
    [{ outcome: "ambiguous", reason: "generation_mismatch", record: V1_DB_RECORD }, "reconciliation-required", "generation_mismatch"],
    [{ outcome: "ambiguous", reason: "sandbox_id_mismatch", record: V1_DB_RECORD }, "unauthorized", "binding_mismatch"],
    [{ outcome: "ambiguous", reason: "returned_id_mismatch", record: { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" } }, "reconciliation-required", "returned_id_mismatch"],
    [{ outcome: "ambiguous", reason: "pending_lifecycle", record: V1_DB_RECORD }, "reconciliation-required", "binding_lifecycle_pending"],
    [{ outcome: "ambiguous", reason: "no_recorded_sandbox", record: V1_DB_RECORD }, "reconciliation-required", "ambiguous_lookup"],
    [{ outcome: "unauthorized" }, "unauthorized", "owner_mismatch"],
    [{ outcome: "unavailable", source: "provider" }, "unavailable", "provider_unavailable"],
    [{ outcome: "unavailable", source: "database" }, "unavailable", "provider_unavailable"],
    [{ outcome: "ambiguous", reason: "fixture-reason", record: V1_DB_RECORD }, "unavailable", "inspection_contract_violation"],
    [{ outcome: "ambiguous", record: V1_DB_RECORD }, "unavailable", "inspection_contract_violation"],
    [{ outcome: "ready" }, "unavailable", "inspection_contract_violation"],
  ];
  for (const [body, status, code] of cases) {
    const { result, wire } = await v1((answer) => {
      answer.body = { ...body, version: 1 };
    });
    const where = JSON.stringify(body);
    assert.equal(result.status, status, where);
    assert.deepEqual(result.reasons, [{ code }], where);
    assert.equal(result.observed, null, where);
    assert.deepEqual(wire.calls, ["inspectBoundSandbox"], where);
  }
});

test("v1: a version other than 1, or any key v1 does not define, is a contract violation", async () => {
  const edits: [string, (body: any) => void][] = [
    ["version 2", (b) => (b.version = 2)],
    ["version text", (b) => (b.version = "1")],
    ["version absent", (b) => delete b.version],
    ["the fixture contract string", (b) => (b.contract = "castles.fixture.sandbox-inspection.v1")],
    ["body key", (b) => (b.labels = {})],
    ["record key", (b) => (b.record.name = "fixture-sandbox-0001")],
    ["observed key", (b) => (b.observed.platform = { architecture: "x86_64", os: "linux" })],
    ["observed key, a future safety field", (b) => (b.observed.ingressConfigured = true)],
    ["identity key", (b) => (b.observed.identity.labels = true)],
    ["policy key", (b) => (b.policy.region = "us")],
    ["record absent", (b) => delete b.record],
    ["observed absent", (b) => delete b.observed],
    ["identity absent", (b) => delete b.observed.identity],
    ["policy absent", (b) => delete b.policy],
    ["record.agentId absent", (b) => delete b.record.agentId],
    ["record.sandboxId absent", (b) => delete b.record.sandboxId],
    ["record.generation text", (b) => (b.record.generation = "3")],
    ["record.generation negative", (b) => (b.record.generation = -1)],
    ["record.lifecycle absent", (b) => delete b.record.lifecycle],
    ["record.fence absent", (b) => delete b.record.fence],
  ];
  for (const [label, edit] of edits) {
    const { result } = await v1((answer) => edit(answer.body));
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(codes(result), ["inspection_contract_violation"], label);
    assert.equal(result.observed, null, label);
  }
  for (const body of [null, "observed", [], 1]) {
    const { result } = await v1((answer) => {
      answer.body = body;
    });
    assert.deepEqual(codes(result), ["inspection_contract_violation"], String(body));
  }
});

test("v1: the echoed record must be this binding's, and the fence must be clear", async () => {
  const owner = await v1((a) => (a.body.record.agentId = "fixture-agent-9999"));
  assert.equal(owner.result.status, "unauthorized");
  assert.deepEqual(owner.result.reasons, [{ code: "owner_mismatch", field: "record.agentId" }]);
  assert.equal(owner.result.observed, null);
  assert.doesNotMatch(renderJson(owner.result), /fixture-agent-9999/u);
  // Upstream's schema allows a null recorded ID on an observed answer; the
  // ID is required here, so a null one is a binding mismatch.
  for (const sandboxId of [null, "fixture-sandbox-9999"]) {
    const { result } = await v1((a) => (a.body.record.sandboxId = sandboxId));
    assert.equal(result.status, "unauthorized", String(sandboxId));
    assert.deepEqual(result.reasons, [{ code: "binding_mismatch", field: "record.sandboxId" }]);
    assert.equal(result.observed, null);
    assert.doesNotMatch(renderJson(result), /fixture-sandbox-9999/u);
  }
  const stale = await v1((a) => (a.body.record.generation = 9));
  assert.equal(stale.result.status, "reconciliation-required");
  assert.deepEqual(stale.result.reasons, [{ code: "generation_mismatch", field: "record.generation" }]);
  assert.equal(stale.result.observed?.binding.generation, 9);
  const pending = await v1((a) => (a.body.record.lifecycle = "provisioning"));
  assert.deepEqual(pending.result.reasons, [{ code: "binding_lifecycle_pending", field: "record.lifecycle" }]);
  for (const [fence, echoed] of [
    ["attempt_outstanding", "attempt_outstanding"],
    ["cleanup_required", "cleanup_required"],
    ["clear", "unrecognised"],
    ["fixture-fence", "unrecognised"],
  ] as const) {
    const { result } = await v1((a) => (a.body.record.fence = fence));
    assert.equal(result.status, "reconciliation-required", fence);
    assert.deepEqual(result.reasons, [{ code: "attempt_fence_held", field: "record.fence" }], fence);
    assert.equal(result.observed?.binding.attemptFence, echoed, fence);
  }
  // Castles' own vocabulary: upstream's "none" is echoed as "clear".
  assert.equal((await v1()).result.observed?.binding.attemptFence, "clear");
});

test("v1: upstream's identity checks refuse with existing reasons", async () => {
  const cases: [string, (body: any) => void, string, { code: string; field: string }, boolean][] = [
    ["credential boundary false", (b) => (b.observed.identity.credentialBoundary = false), "reconciliation-required", { code: "credential_boundary_unverified", field: "identity.credentialBoundary" }, true],
    ["credential boundary text", (b) => (b.observed.identity.credentialBoundary = "true"), "reconciliation-required", { code: "credential_boundary_unverified", field: "identity.credentialBoundary" }, true],
    ["credential boundary version", (b) => (b.policy.credentialBoundaryVersion = "attempt-reset-v0"), "reconciliation-required", { code: "credential_boundary_unverified", field: "policy.credentialBoundaryVersion" }, true],
    ["generation label false", (b) => (b.observed.identity.generationLabel = false), "reconciliation-required", { code: "generation_mismatch", field: "identity.generationLabel" }, true],
    ["ownership labels false", (b) => (b.observed.identity.ownershipLabels = false), "unauthorized", { code: "owner_mismatch", field: "identity.ownershipLabels" }, false],
    ["ownership labels absent", (b) => (b.observed.identity.ownershipLabels = null), "unauthorized", { code: "owner_mismatch", field: "identity.ownershipLabels" }, false],
    ["configuration mismatch", (b) => (b.observed.identity.configuration = "mismatch"), "unauthorized", { code: "binding_mismatch", field: "identity.configuration" }, false],
    ["configuration unknown", (b) => (b.observed.identity.configuration = "fixture-config"), "unauthorized", { code: "binding_mismatch", field: "identity.configuration" }, false],
  ];
  for (const [label, edit, status, reason, disclosed] of cases) {
    const { result } = await v1((answer) => edit(answer.body));
    assert.equal(result.status, status, label);
    assert.deepEqual(result.reasons, [reason], label);
    assert.equal(result.observed !== null, disclosed, label);
  }
  // A prior configuration is upstream's adoptable older policy, not drift.
  const prior = await v1((a) => (a.body.observed.identity.configuration = "prior"));
  assert.equal(prior.result.status, "ready");
  assert.equal(prior.result.observed?.identity.configuration, "prior");
});

test("v1: TTL and attachments follow upstream's booleans and count (fold accepted pending coven-agents#322)", async () => {
  const refusals: [string, unknown, string, string][] = [
    ["autoDestroyAtConfigured", true, "lifecycle_ttl", "autoDestroyAtConfigured"],
    ["warmPool", true, "warm_pool_member", "warmPool"],
    ["linkedSandbox", true, "linked_sandbox_present", "linkedSandbox"],
    ["volumes", 1, "volumes_present", "volumes"],
    ["volumes", 1024, "volumes_present", "volumes"],
    // Not a count: never read as "no volume".
    ["volumes", -1, "volumes_present", "volumes"],
    ["volumes", 0.5, "volumes_present", "volumes"],
    ["volumes", "0", "volumes_present", "volumes"],
  ];
  for (const [key, value, code, field] of refusals) {
    const { result } = await v1((a) => (a.body.observed[key] = value));
    assert.equal(result.status, "incompatible", `${key}=${String(value)}`);
    assert.deepEqual(result.reasons, [{ code, field }], `${key}=${String(value)}`);
  }
  for (const key of ["autoDestroyAtConfigured", "warmPool", "linkedSandbox", "volumes"]) {
    for (const edit of [(o: any) => delete o[key], (o: any) => (o[key] = null)]) {
      const { result } = await v1((a) => edit(a.body.observed));
      assert.equal(result.status, "incompatible", key);
      assert.deepEqual(result.reasons, [{ code: "metadata_missing", field: key }], key);
    }
  }
  const none = await v1();
  assert.deepEqual(none.result.observed?.attachments, {
    linkedSandbox: false,
    volumes: 0,
    warmPool: false,
  });
  assert.equal(none.result.observed?.lifecycle.autoDestroyAt, "absent");
});

test("v1: egress is the owner-policy comparison, and any network list or proxy is unsafe", async () => {
  const cases: [string, (o: any) => void, string, { code: string; field: string }[]][] = [
    ["domain list differs from policy", (o) => (o.domainAllowListMatchesPolicy = false), "incompatible", [{ code: "egress_allow_list_unsafe", field: "domainAllowList" }]],
    ["network list configured", (o) => (o.networkAllowListConfigured = true), "incompatible", [{ code: "egress_allow_list_unsafe", field: "networkAllowList" }]],
    ["outbound proxy configured", (o) => (o.outboundProxyConfigured = true), "incompatible", [{ code: "egress_allow_list_unsafe", field: "outboundProxy" }]],
    ["block-all does not excuse a proxy", (o) => { o.networkBlockAll = true; o.outboundProxyConfigured = true; }, "incompatible", [{ code: "egress_allow_list_unsafe", field: "outboundProxy" }]],
    ["no list and no block-all", (o) => (o.domainAllowListConfigured = false), "incompatible", [{ code: "egress_unrestricted", field: "egress" }]],
    ["block-all unstated", (o) => (o.networkBlockAll = null), "incompatible", [{ code: "metadata_missing", field: "networkBlockAll" }]],
    ["comparison unstated", (o) => delete o.domainAllowListMatchesPolicy, "incompatible", [{ code: "metadata_missing", field: "domainAllowListMatchesPolicy" }]],
    ["proxy unstated", (o) => (o.outboundProxyConfigured = "no"), "incompatible", [{ code: "metadata_missing", field: "outboundProxyConfigured" }]],
  ];
  for (const [label, edit, status, reasons] of cases) {
    const { result } = await v1((a) => edit(a.body.observed));
    assert.equal(result.status, status, label);
    assert.deepEqual(result.reasons, reasons, label);
  }
  const blockAll = await v1((a) => {
    a.body.observed.domainAllowListConfigured = false;
    a.body.observed.networkBlockAll = true;
  });
  assert.equal(blockAll.result.status, "ready");
  assert.deepEqual(blockAll.result.observed?.exposure, {
    domainAllowListConfigured: false,
    domainAllowListMatchesPolicy: true,
    networkAllowListConfigured: false,
    networkBlockAll: true,
    outboundProxyConfigured: false,
    public: false,
  });
});

test("v1: upstream's coarse states keep their Castles outcomes", async () => {
  const states: [string, string, string[]][] = [
    ["stopped", "stopped", ["sandbox_stopped"]],
    ["archived", "stopped", ["sandbox_stopped"]],
    ["destroyed", "unavailable", ["sandbox_destroyed"]],
    ["transitioning", "unavailable", ["lifecycle_not_settled"]],
    ["error", "unavailable", ["lifecycle_not_settled"]],
    ["unknown", "unavailable", ["lifecycle_not_settled"]],
  ];
  for (const [state, status, expected] of states) {
    const { result } = await v1((a) => (a.body.observed.state = state));
    assert.equal(result.status, status, state);
    assert.deepEqual(codes(result), expected, state);
    assert.equal(result.observed?.state, state, state);
  }
  const unlisted = await v1((a) => (a.body.observed.state = "paused"));
  assert.notEqual(unlisted.result.status, "ready");
  assert.equal(unlisted.result.observed?.state, "unrecognised");
});

test("v1: renamed resources and the server-selected SDK version are checked", async () => {
  const { caps, floor } = SUPPORTED_PROFILE.resources;
  for (const [key, value] of [
    ["memoryGib", caps.memoryGiB + 1],
    ["memoryGib", floor.memoryGiB - 1],
    ["diskGib", caps.diskGiB + 1],
    ["diskGib", floor.diskGiB - 1],
  ] as const) {
    const { result } = await v1((a) => (a.body.observed[key] = value));
    assert.deepEqual(result.reasons, [{ code: "resources_out_of_policy", field: "resources" }], `${key}=${value}`);
  }
  for (const key of ["memoryGib", "diskGib", "cpu"]) {
    const { result } = await v1((a) => delete a.body.observed[key]);
    assert.deepEqual(result.reasons, [{ code: "metadata_missing", field: key }], key);
  }
  const ready = await v1();
  assert.deepEqual(ready.result.observed?.resources, {
    cpu: 2,
    diskGiB: 10,
    gpu: 0,
    matchesTarget: true,
    memoryGiB: 4,
  });
  assert.equal(ready.result.observed?.sdk.version, "0.231.1");
  for (const version of ["0.230.0", "0.220.0", "0.231.2", 231]) {
    const { result } = await v1((a) => (a.body.policy.sdkVersion = version));
    assert.equal(result.status, "incompatible", String(version));
    assert.deepEqual(result.reasons, [{ code: "sdk_generation_mismatch", field: "policy.sdkVersion" }], String(version));
  }
});

test("v1: platform is source policy implied by the qualified snapshot, never an observation", async () => {
  assert.deepEqual(SUPPORTED_PROFILE.platform, {
    architecture: "not-pinned",
    basis: "qualified-snapshot",
    os: "linux",
  });
  const ready = await v1();
  assert.equal(ready.result.status, "ready");
  assert.deepEqual(ready.result.observed?.platform, { architecture: null, os: null });
  assert.equal(JSON.parse(renderJson(ready.result)).sourcePolicy.platform.basis, "qualified-snapshot");
  // Without the qualified snapshot the platform is unknown, and not ready.
  for (const snapshot of ["fixture-other-image", null]) {
    const { result } = await v1((a) => (a.body.observed.snapshot = snapshot));
    assert.equal(result.status, "incompatible", String(snapshot));
    assert.deepEqual(
      codes(result),
      [snapshot === null ? "metadata_missing" : "image_unqualified"],
      String(snapshot)
    );
  }
});

test("v1: the profile pins one upstream revision for the contract and the SDK", () => {
  assert.equal(SUPPORTED_PROFILE.sdk.version, "0.231.1");
  for (const entry of SOURCE_PINS) {
    assert.ok(entry.pin.startsWith(`OpenCoven/coven-agents@${V1_UPSTREAM_SHA}:`), entry.pin);
  }
  for (const path of [
    "packages/agent-contracts/src/sandbox-inspection.ts",
    "lib/runner/sandbox-inspection-http.ts",
    "lib/runner/transport.ts",
    "lib/runner/daytona/resource-inspection.ts",
  ]) {
    assert.ok(
      SOURCE_PINS.some((entry) => entry.pin.endsWith(`:${path}`)),
      path
    );
  }
});

// --- Second read rv18-7c3e91a4 on PR #18 at f902a80 -------------------------
// Each test below failed at f902a80. Findings 2 and 3: an answer held in
// memory is not JSON, so the strict-key check must see every own key and
// each field must be read once. Finding 4: upstream's 500 is retryable.
// Finding 5: a refusal must carry the keys v1 requires for it.

/** Runs the ready v1 answer after `edit`, through an in-memory client. */
async function v1Answer(edit: (answer: any) => unknown) {
  const answer = v1Ready();
  const replaced = edit(answer);
  return runPreflight(
    VALID_ENV,
    tripwireClient(() => replaced ?? answer).client
  );
}

test("v1 review: a key strict checking cannot see by enumeration still refuses the answer", async () => {
  const cases: [string, (answer: any) => unknown][] = [
    [
      "non-enumerable platform on observed",
      (a) =>
        Object.defineProperty(a.body.observed, "platform", {
          enumerable: false,
          value: { os: "fixture-os" },
        }) && undefined,
    ],
    [
      "undefined keys inherited by observed",
      (a) => {
        a.body.observed = Object.assign(
          Object.create({ platform: { os: "fixture-os" } }),
          a.body.observed
        );
      },
    ],
    [
      "symbol key on the body",
      (a) => {
        a.body[Symbol("fixture")] = "fixture-extra";
      },
    ],
    [
      "body that is a class instance",
      (a) => {
        class FixtureBody {}
        a.body = Object.assign(new FixtureBody(), a.body);
      },
    ],
    [
      "record that is a class instance",
      (a) => {
        class FixtureRecord {}
        a.body.record = Object.assign(new FixtureRecord(), a.body.record);
      },
    ],
    [
      "identity with a non-enumerable extra key",
      (a) =>
        Object.defineProperty(a.body.observed.identity, "fixtureExtra", {
          enumerable: false,
          value: true,
        }) && undefined,
    ],
  ];
  for (const [label, edit] of cases) {
    const result = await v1Answer(edit);
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(codes(result), ["inspection_contract_violation"], label);
    assert.equal(result.observed, null, label);
  }
  // An object with no base is plain, as some schema libraries produce it.
  // JSON parsed in another realm is not: its objects carry that realm's own
  // base object and are refused, which fails closed.
  const bare = await v1Answer((a) => {
    a.body.observed = Object.assign(Object.create(null), a.body.observed);
  });
  assert.equal(bare.status, "ready");
});

test("v1 review: each field of an answer is read once, so status and output agree", async () => {
  let reads = 0;
  const flips = [false, false, true];
  const result = await v1Answer((a) => {
    Object.defineProperty(a.body.observed, "public", {
      enumerable: true,
      get: () => flips[Math.min(reads++, flips.length - 1)],
    });
  });
  assert.equal(reads, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.observed?.exposure.public, false);
});

test("v1 review: upstream's retryable 500 is provider_unavailable", async () => {
  const result = await runPreflight(
    VALID_ENV,
    tripwireClient(() => ({
      body: { error: { code: "internal_error", retryable: true } },
      status: 500,
    })).client
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(codes(result), ["provider_unavailable"]);
  assert.equal(result.observed, null);
});

test("v1 review: a refusal without the keys v1 requires for it is a contract violation", async () => {
  const policy = v1Ready().body.policy;
  const bound = { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" };
  const violations: [string, Record<string, unknown>][] = [
    ["not_found without record or policy", { outcome: "not_found" }],
    ["not_found without policy", { outcome: "not_found", record: bound }],
    ["not_found without record", { outcome: "not_found", policy }],
    ["not_found with a text record", { outcome: "not_found", policy, record: "x" }],
    ["not_found with a number policy", { outcome: "not_found", policy: 5, record: bound }],
    ["not_found with an undefined policy key", { outcome: "not_found", policy: { ...policy, fixtureExtra: 1 }, record: bound }],
    ["not_found with a record key undefined by v1", { outcome: "not_found", policy, record: { ...bound, fixtureExtra: 1 } }],
    ["ambiguous without record", { outcome: "ambiguous", reason: "no_recorded_sandbox" }],
    ["returned_id_mismatch without record", { outcome: "ambiguous", reason: "returned_id_mismatch" }],
    ["database ambiguity disclosing a sandbox ID", { outcome: "ambiguous", reason: "generation_mismatch", record: bound }],
    ["ambiguous with a mistyped record", { outcome: "ambiguous", reason: "pending_lifecycle", record: { ...V1_DB_RECORD, generation: "3" } }],
    ["unavailable without source", { outcome: "unavailable" }],
    ["unavailable from an unknown source", { outcome: "unavailable", source: "zzz" }],
  ];
  for (const [label, body] of violations) {
    const result = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ body: { ...body, version: 1 }, status: 200 })).client
    );
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(codes(result), ["inspection_contract_violation"], label);
  }
});

// Third read rv18b-f2bd3f93 on PR #18, at 51bf206.

test("v1 third read: a policy field Castles does not read must still have v1's shape", async () => {
  const pin257 = "a".repeat(257);
  const harness = { id: "fixture-harness", package: "fixture-package", version: "1.0.0" };
  const edits: [string, (policy: any) => unknown][] = [
    ["only the two read keys", (p) => {
      for (const key of ["adapterVersion", "capabilityContractVersion", "harnesses", "resources", "snapshotName", "target"]) delete p[key];
    }],
    ["adapterVersion absent", (p) => delete p.adapterVersion],
    ["adapterVersion empty", (p) => (p.adapterVersion = "")],
    ["adapterVersion a number", (p) => (p.adapterVersion = 1)],
    ["capabilityContractVersion too long", (p) => (p.capabilityContractVersion = pin257)],
    ["snapshotName absent", (p) => delete p.snapshotName],
    ["snapshotName null", (p) => (p.snapshotName = null)],
    ["target empty", (p) => (p.target = "")],
    ["target too long", (p) => (p.target = "u".repeat(65))],
    ["harnesses absent", (p) => delete p.harnesses],
    ["harnesses an object", (p) => (p.harnesses = {})],
    ["harnesses too many", (p) => (p.harnesses = Array.from({ length: 17 }, () => ({ ...harness })))],
    ["harness with an extra key", (p) => (p.harnesses = [{ ...harness, fixtureExtra: 1 }])],
    ["harness without a version", (p) => (p.harnesses = [{ id: "x", package: "y" }])],
    ["harness with a number id", (p) => (p.harnesses = [{ ...harness, id: 1 }])],
    ["harness that is text", (p) => (p.harnesses = ["x"])],
    ["resources absent", (p) => delete p.resources],
    ["resources without cpu", (p) => delete p.resources.cpu],
    ["resources with an extra key", (p) => (p.resources.gpu = 0)],
    ["resources cpu above 4096", (p) => (p.resources.cpu = 4097)],
    ["resources cpu negative", (p) => (p.resources.cpu = -1)],
    ["resources cpu fractional", (p) => (p.resources.cpu = 2.5)],
    ["resources cpu text", (p) => (p.resources.cpu = "2")],
  ];
  for (const [label, edit] of edits) {
    const { result } = await v1((a) => void edit(a.body.policy));
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(codes(result), ["inspection_contract_violation"], label);
    assert.equal(result.observed, null, label);
  }
  const accepted: [string, (policy: any) => unknown][] = [
    ["sixteen harnesses", (p) => (p.harnesses = Array.from({ length: 16 }, () => ({ ...harness })))],
    ["a 256-character pin", (p) => (p.adapterVersion = "a".repeat(256))],
    ["resources at the v1 bounds", (p) => (p.resources = { cpu: 0, diskGib: 4096, memoryGib: 4096 })],
  ];
  for (const [label, edit] of accepted) {
    const { result } = await v1((a) => void edit(a.body.policy));
    assert.equal(result.status, "ready", label);
  }
});

test("v1 third read: a refusal's record and policy must match v1 exactly", async () => {
  const policy = v1Ready().body.policy;
  const bound = { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" };
  const violations: [string, Record<string, unknown>][] = [
    ["not_found with an empty policy", { outcome: "not_found", policy: {}, record: bound }],
    ["not_found with a policy missing sdkVersion", { outcome: "not_found", policy: { ...policy, sdkVersion: undefined }, record: bound }],
    ["not_found with a number sdkVersion", { outcome: "not_found", policy: { ...policy, sdkVersion: 231 }, record: bound }],
    ["not_found with an unknown lifecycle", { outcome: "not_found", policy, record: { ...bound, lifecycle: "zzz" } }],
    ["not_found with an unknown fence", { outcome: "not_found", policy, record: { ...bound, fence: "zzz" } }],
    ["not_found with a negative generation", { outcome: "not_found", policy, record: { ...bound, generation: -1 } }],
    ["not_found with an empty sandbox ID", { outcome: "not_found", policy, record: { ...bound, sandboxId: "" } }],
    ["not_found with a sandbox ID not an identifier", { outcome: "not_found", policy, record: { ...bound, sandboxId: "-fixture" } }],
    ["not_found with a sandbox ID too long", { outcome: "not_found", policy, record: { ...bound, sandboxId: "s".repeat(129) } }],
    ["ambiguous with an unknown lifecycle", { outcome: "ambiguous", reason: "pending_lifecycle", record: { ...V1_DB_RECORD, lifecycle: "zzz" } }],
    ["ambiguous with an agent ID not an identifier", { outcome: "ambiguous", reason: "no_recorded_sandbox", record: { ...V1_DB_RECORD, agentId: "fixture agent" } }],
    ["returned_id_mismatch with an unknown fence", { outcome: "ambiguous", reason: "returned_id_mismatch", record: { ...bound, fence: "zzz" } }],
  ];
  for (const [label, body] of violations) {
    const result = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ body: { ...body, version: 1 }, status: 200 })).client
    );
    assert.equal(result.status, "unavailable", label);
    assert.deepEqual(codes(result), ["inspection_contract_violation"], label);
  }
});

test("v1 third read: a refusal about another agent or sandbox is never read as this binding's", async () => {
  const policy = v1Ready().body.policy;
  const bound = { ...V1_DB_RECORD, sandboxId: "fixture-sandbox-0001" };
  const other = "fixture-agent-9999";
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["not_found about another agent", { outcome: "not_found", policy, record: { ...bound, agentId: other } }, "unauthorized", "owner_mismatch"],
    ["not_found about another sandbox", { outcome: "not_found", policy, record: { ...bound, sandboxId: "fixture-sandbox-9999" } }, "unauthorized", "binding_mismatch"],
    ["returned_id_mismatch about another agent", { outcome: "ambiguous", reason: "returned_id_mismatch", record: { ...bound, agentId: other } }, "unauthorized", "owner_mismatch"],
    ["returned_id_mismatch about another sandbox", { outcome: "ambiguous", reason: "returned_id_mismatch", record: { ...bound, sandboxId: "fixture-sandbox-9999" } }, "unauthorized", "binding_mismatch"],
  ];
  for (const reason of ["generation_mismatch", "no_recorded_sandbox", "pending_lifecycle", "sandbox_id_mismatch"]) {
    cases.push([`${reason} about another agent`, { outcome: "ambiguous", reason, record: { ...V1_DB_RECORD, agentId: other } }, "unauthorized", "owner_mismatch"]);
  }
  for (const [label, body, status, code] of cases) {
    const result = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ body: { ...body, version: 1 }, status: 200 })).client
    );
    assert.equal(result.status, status, label);
    assert.deepEqual(codes(result), [code], label);
    assert.equal(result.observed, null, label);
  }
});

test("v1 third read: a non-200 answer's body is never read or copied", async () => {
  let nested: unknown = 1;
  for (let level = 0; level < 10; level += 1) nested = { nested };
  const bodies: [string, () => unknown][] = [
    ["a throwing getter", () => Object.defineProperty({}, "error", {
      enumerable: true,
      get() {
        throw new Error("fixture: a refusal body must not be read");
      },
    })],
    ["a date", () => ({ when: new Date(0) })],
    ["ten levels of JSON", () => nested],
    ["a 1,001-entry array", () => Array.from({ length: 1_001 }, () => 0)],
  ];
  const refusals: [number, string, string][] = [
    [401, "unauthorized", "unauthenticated"],
    [403, "unauthorized", "owner_mismatch"],
    [404, "unauthorized", "owner_mismatch"],
    [429, "unavailable", "provider_unavailable"],
    [500, "unavailable", "provider_unavailable"],
    [503, "unavailable", "provider_unavailable"],
  ];
  for (const [status, expected, code] of refusals) {
    for (const [label, body] of bodies) {
      let bodyReads = 0;
      const answer = Object.defineProperty({ status }, "body", {
        enumerable: true,
        get() {
          bodyReads += 1;
          return body();
        },
      });
      const result = await runPreflight(VALID_ENV, tripwireClient(() => answer).client);
      assert.equal(result.status, expected, `${status} ${label}`);
      assert.deepEqual(codes(result), [code], `${status} ${label}`);
      assert.equal(bodyReads, 0, `${status} ${label}`);
    }
  }
  // The answer itself is still strict: a key besides status and body is a
  // contract violation whatever the status.
  const extra = await runPreflight(
    VALID_ENV,
    tripwireClient(() => ({ body: null, fixtureExtra: 1, status: 401 })).client
  );
  assert.deepEqual(codes(extra), ["inspection_contract_violation"]);
});

test("v1 third read: the copy stops at an overall size limit", async () => {
  let reads = 0;
  const shared = (depth: number): unknown => {
    const node: Record<string, unknown> = {};
    for (let index = 0; index < 16; index += 1) {
      Object.defineProperty(node, `k${index}`, {
        enumerable: true,
        get() {
          reads += 1;
          return depth === 0 ? 0 : child;
        },
      });
    }
    const child = depth === 0 ? 0 : shared(depth - 1);
    return node;
  };
  // Within the depth limit: 16 + 256 + 4,096 + 65,536 values.
  const result = await v1Answer((a) => {
    a.body.observed.identity = shared(3);
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(codes(result), ["inspection_contract_violation"]);
  assert.ok(reads <= 20_000, `read ${reads} values`);
});

test("v1 third read: an inherited value never fills an absent key", async () => {
  const baseline = await v1Answer((a) => {
    delete a.body.observed.public;
    delete a.body.observed.volumes;
  });
  assert.notEqual(baseline.status, "ready");
  const base = Object.prototype as Record<string, unknown>;
  Object.defineProperty(base, "public", { configurable: true, value: false });
  Object.defineProperty(base, "volumes", { configurable: true, value: 0 });
  try {
    const polluted = await v1Answer((a) => {
      delete a.body.observed.public;
      delete a.body.observed.volumes;
    });
    assert.equal(polluted.status, baseline.status);
    assert.deepEqual(codes(polluted), codes(baseline));
  } finally {
    delete base.public;
    delete base.volumes;
  }
});

// #322: negotiated detail mode. Synthetic input, never live readiness.
const DETAIL_OPTIONS = { includeProviderMetadata: true } as const;
const DETAIL_FIELDS = ["autoDestroyAtConfigured", "warmPool", "linkedSandbox", "volumes"] as const;
function detailReady() {
  const answer = v1Ready();
  answer.body.observed.providerMetadata = {
    autoDestroyAtConfigured: false, warmPool: false, linkedSandbox: false,
    volumes: 0, platform: { architecture: null, os: null },
  };
  return answer;
}
async function detailCase(edit: (answer: any) => void = () => undefined) {
  const answer = detailReady(); edit(answer);
  const wire = tripwireClient(() => answer);
  const result = await runPreflight(VALID_ENV, wire.client, DETAIL_OPTIONS);
  assert.deepEqual(wire.calls, ["inspectBoundSandbox"]);
  assert.equal(isLiveReady(result), false);
  return { result, wire };
}
test("#322 detail: negotiation forwards literal true and keeps default v1 strict", async () => {
  const { result, wire } = await detailCase();
  assert.equal(result.status, "ready");
  assert.equal((wire.requests[0] as any).includeProviderMetadata, true);
  assert.equal(result.observed?.lifecycle.autoDestroyAt, "absent");
  assert.deepEqual(result.observed?.attachments, { warmPool: false, linkedSandbox: false, volumes: 0 });
  const unsolicited = tripwireClient(detailReady);
  const legacy = await runPreflight(VALID_ENV, unsolicited.client);
  assert.deepEqual(codes(legacy), ["inspection_contract_violation"]);
});
for (const field of DETAIL_FIELDS) {
  test(`#322 detail: unknown ${field} never falls back to legacy absence`, async () => {
    const { result } = await detailCase(a => a.body.observed.providerMetadata[field] = null);
    assert.equal(result.status, "incompatible");
    assert.ok(result.reasons.some(r => r.code === "metadata_missing" && r.field === field));
    const echoed = JSON.parse(renderJson(result)).observed;
    assert.equal(field === "autoDestroyAtConfigured" ? echoed.lifecycle.autoDestroyAt : echoed.attachments[field], null);
  });
}
test("#322 detail: all unknown and mixed presence retain every reason and JSON distinction", async () => {
  const { result } = await detailCase(a => { for (const field of DETAIL_FIELDS) a.body.observed.providerMetadata[field] = null; });
  assert.equal(result.reasons.filter(r => r.code === "metadata_missing").length, 4);
  const mixed = await detailCase(a => { a.body.observed.providerMetadata.warmPool = true; a.body.observed.providerMetadata.volumes = null; });
  assert.ok(codes(mixed.result).includes("warm_pool_member"));
  assert.ok(codes(mixed.result).includes("metadata_missing"));
  assert.equal(mixed.result.observed?.attachments.warmPool, true);
  assert.equal(mixed.result.observed?.attachments.volumes, null);
});
for (const [field, code] of [["autoDestroyAtConfigured", "lifecycle_ttl"], ["warmPool", "warm_pool_member"], ["linkedSandbox", "linked_sandbox_present"], ["volumes", "volumes_present"]] as const) {
  test(`#322 detail: present ${field} overrides legacy absence`, async () => {
    const { result } = await detailCase(a => a.body.observed.providerMetadata[field] = field === "volumes" ? 1 : true);
    assert.ok(codes(result).includes(code));
    assert.notEqual(result.status, "ready");
  });
}
test("#322 detail: validates exact nested shape and count bounds", async () => {
  const edits: ((a: any) => void)[] = [
    a => delete a.body.observed.providerMetadata,
    a => a.body.observed.providerMetadata = null,
    a => a.body.observed.providerMetadata = [],
    a => a.body.observed.providerMetadata.extra = false,
    a => a.body.observed.providerMetadata.platform.extra = null,
    a => a.body.observed.providerMetadata.platform.os = 1,
    a => a.body.observed.providerMetadata.platform.os = "",
    a => a.body.observed.providerMetadata.platform.architecture = "a".repeat(65),
    a => delete a.body.observed.providerMetadata.platform,
    a => a.body.version = 2,
  ];
  for (const field of DETAIL_FIELDS) edits.push(a => delete a.body.observed.providerMetadata[field]);
  for (const field of DETAIL_FIELDS.slice(0, 3)) for (const value of ["false", 0, {}, []]) edits.push(a => a.body.observed.providerMetadata[field] = value);
  for (const value of [-1, 0.5, 1025, "0", false, {}, []]) edits.push(a => a.body.observed.providerMetadata.volumes = value);
  for (const edit of edits) {
    const { result } = await detailCase(edit);
    assert.deepEqual(codes(result), ["inspection_contract_violation"]);
    assert.equal(result.observed, null);
  }
  const maximum = await detailCase(a => a.body.observed.providerMetadata.volumes = 1024);
  assert.equal(maximum.result.observed?.attachments.volumes, 1024);
});
test("#322 detail: invalid negotiation refuses before any inspection", async () => {
  for (const value of [false, null, 1, "true", {}, []]) {
    const wire = tripwireClient(detailReady);
    const result = await runPreflight(VALID_ENV, wire.client, { includeProviderMetadata: value } as any);
    assert.deepEqual(codes(result), ["inspection_contract_violation"]);
    assert.deepEqual(wire.calls, []);
  }
});
test("#322 detail: preserves owner, binding, generation and fence classification", async () => {
  for (const [key, value, code] of [["agentId", "fixture-other-agent", "owner_mismatch"], ["sandboxId", "fixture-other-sandbox", "binding_mismatch"], ["generation", 4, "generation_mismatch"], ["fence", "attempt_outstanding", "attempt_fence_held"]] as const) {
    const { result } = await detailCase(a => a.body.record[key] = value);
    assert.ok(codes(result).includes(code));
    if (key === "agentId" || key === "sandboxId") assert.equal(result.observed, null);
  }
});
test("#322 detail: Codex and Claude CLI policy entries are valid source policy, never installation proof", async () => {
  const { result } = await detailCase(a => { a.body.policy.harnesses = [
    { id: "codex", package: "@openai/codex", version: "0.152.1" },
    { id: "claude", package: "@anthropic-ai/claude-code", version: "2.1.258" },
  ]; });
  assert.equal(result.status, "ready");
  assert.equal(isLiveReady(result), false);
  assert.deepEqual(result.observed?.platform, { architecture: null, os: null });
});
test("#322 detail: labelled fixtures, repeatability, redaction and public JSON", async () => {
  for (const name of ["absence", "unknown"]) {
    const fixture = loadFixtureCase(join(root, "fixtures", "preflight", "metadata", `${name}.json`));
    const before = JSON.stringify(fixture);
    const first = await runPreflight(fixture.env, createFixtureInspectionClient(fixture), DETAIL_OPTIONS);
    const second = await runPreflight(fixture.env, createFixtureInspectionClient(fixture), DETAIL_OPTIONS);
    assert.deepEqual(first, second);
    assert.equal(first.status, fixture.expect.status);
    assert.deepEqual(first.reasons, fixture.expect.reasons);
    const json = renderJson(first);
    assert.deepEqual(JSON.parse(json), first);
    assert.ok(!json.includes("fixture-agent-0001"));
    assert.ok(!json.includes("fixture-sandbox-0001"));
    assert.equal(JSON.stringify(fixture), before);
    assert.equal(isLiveReady(first), false);
  }
});
test("#322 detail: the plain-data budget and refusal-body guards remain active", async () => {
  const answer = detailReady();
  Object.defineProperty(answer.body.observed.providerMetadata, "warmPool", { get: () => new Date() });
  const result = await runPreflight(VALID_ENV, tripwireClient(() => answer).client, DETAIL_OPTIONS);
  assert.deepEqual(codes(result), ["inspection_contract_violation"]);
  let reads = 0;
  const non200 = { status: 401, get body() { reads++; throw new Error("must not read"); } };
  const refusal = await runPreflight(VALID_ENV, tripwireClient(() => non200).client, DETAIL_OPTIONS);
  assert.deepEqual(codes(refusal), ["unauthenticated"]);
  assert.equal(reads, 0);
});
