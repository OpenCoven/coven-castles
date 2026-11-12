import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
  MUTATION_OWNERS,
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
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
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
    sandbox: Record<string, unknown>;
  };
  inspection.sandbox.state = "archived";
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client, { evidence: "fixture" });
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
  const fixture = loadFixtureCase(casePath("mismatched-returned-id"));
  const inspection = structuredClone(fixture.inspection) as {
    sandbox: Record<string, unknown>;
  };
  inspection.sandbox.name = "fixture-sandbox-0001";
  inspection.sandbox.labels = {
    agentId: "fixture-agent-0001",
    credentialBoundaryVersion: "attempt-reset-v1",
    sandboxId: "fixture-sandbox-0001",
  };
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(codes(result), ["returned_id_mismatch"]);
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
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
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
  const result = await runPreflight(fixture.env, client, {
    evidence: "fixture",
    timeoutMs: 20,
  });
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
    { ...(fixture.inspection as object), sandbox: null },
  ]) {
    const wire = tripwireClient(() => response);
    const result = await runPreflight(fixture.env, wire.client, {
      evidence: "fixture",
    });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(codes(result), ["inspection_contract_violation"]);
    assert.equal(result.observed, null);
  }
});

test("an unsettled or unrecognised lifecycle state is never ready", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  for (const state of [
    "starting",
    "stopping",
    "error",
    "paused",
    "resizing",
    "destroyed",
    "not-a-state",
    undefined,
  ]) {
    const inspection = structuredClone(fixture.inspection) as {
      sandbox: Record<string, unknown>;
    };
    inspection.sandbox.state = state;
    const wire = tripwireClient(() => inspection);
    const result = await runPreflight(fixture.env, wire.client, {
      evidence: "fixture",
    });
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
    lifecycle_ttl: ["autoDestroyAt", "2099-01-01T00:00:00Z"],
    image_unqualified: ["snapshot", "fixture-other-image"],
    linked_sandbox_present: ["linkedSandboxId", "fixture-sandbox-0002"],
    resources_out_of_policy: ["cpu", 16],
    gpu_present: ["gpu", 1],
    volumes_present: ["volumes", [{ volumeId: "fixture-volume" }]],
    warm_pool_member: ["warmPoolId", "fixture-pool"],
  };
  for (const [code, [field, value]] of Object.entries(edits)) {
    const inspection = structuredClone(fixture.inspection) as {
      sandbox: Record<string, unknown>;
    };
    inspection.sandbox[field] = value;
    const wire = tripwireClient(() => inspection);
    const result = await runPreflight(fixture.env, wire.client, {
      evidence: "fixture",
    });
    assert.equal(result.status, "incompatible", code);
    assert.deepEqual(codes(result), [code]);
  }
});

// --- Egress: an allow list must actually restrict (review finding B1) -------

async function withSandbox(edit: (sandbox: Record<string, unknown>) => void) {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as {
    sandbox: Record<string, unknown>;
  };
  edit(inspection.sandbox);
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client, { evidence: "fixture" });
}

test("allow-list entries that do not restrict egress fail closed", async () => {
  const unsafe: [string, unknown][] = [
    ["domainAllowList", "*"],
    ["domainAllowList", "*.*"],
    ["domainAllowList", "*.invalid"],
    ["domainAllowList", "*.fixture.invalid"],
    ["domainAllowList", "fixture.invalid,*.sub.fixture.invalid"],
    ["domainAllowList", "fixture.invalid,*"],
    ["domainAllowList", "https://fixture.invalid"],
    ["domainAllowList", "fixture.invalid:443"],
    ["domainAllowList", "fixture.invalid/path"],
    ["domainAllowList", "fixture .invalid"],
    ["domainAllowList", "fix*ture.invalid"],
    ["networkAllowList", "0.0.0.0/0"],
    ["networkAllowList", "::/0"],
    ["networkAllowList", "0.0.0.0/1,128.0.0.0/1"],
    ["networkAllowList", "10.0.0.0/7"],
    ["networkAllowList", "192.0.2.0/24,0.0.0.0/0"],
    ["networkAllowList", "10.0.0.0"],
    ["networkAllowList", "999.0.0.0/24"],
    ["networkAllowList", "10.0.0.0/33"],
    ["networkAllowList", "10.0.0.0/08"],
    ["networkAllowList", "fd00::/8"],
    ["networkAllowList", "any"],
  ];
  for (const [field, value] of unsafe) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox[field] = value;
    });
    assert.equal(result.status, "incompatible", `${field}=${String(value)}`);
    assert.deepEqual(
      codes(result),
      ["egress_allow_list_unsafe"],
      `${field}=${String(value)}`
    );
    assert.deepEqual(result.reasons[0], {
      code: "egress_allow_list_unsafe",
      field,
    });
  }
});

test("an unsafe allow list is not excused by block-all or by a second safe list", async () => {
  const blockAll = await withSandbox((sandbox) => {
    sandbox.networkBlockAll = true;
    sandbox.domainAllowList = "*";
  });
  assert.equal(blockAll.status, "incompatible");
  assert.deepEqual(codes(blockAll), ["egress_allow_list_unsafe"]);

  const mixed = await withSandbox((sandbox) => {
    sandbox.networkAllowList = "0.0.0.0/0";
  });
  assert.equal(mixed.status, "incompatible");
  assert.deepEqual(codes(mixed), ["egress_allow_list_unsafe"]);
});

test("an allow list that is present but not a string is missing metadata", async () => {
  for (const field of ["domainAllowList", "networkAllowList"]) {
    const result = await withSandbox((sandbox) => {
      sandbox[field] = ["*"];
    });
    assert.equal(result.status, "incompatible", field);
    assert.ok(codes(result).includes("metadata_missing"), field);
    assert.notEqual(result.status, "ready");
  }
});

test("plain domains and bounded IPv4 ranges are accepted as restricted egress", async () => {
  const safe: [string, string][] = [
    ["domainAllowList", "fixture.invalid"],
    ["domainAllowList", "api.sub.fixture.invalid"],
    ["domainAllowList", "a.fixture.invalid, b.fixture.invalid"],
    ["networkAllowList", "10.0.0.0/8"],
    ["networkAllowList", "192.0.2.0/24"],
    ["networkAllowList", "192.0.2.1/32, 198.51.100.0/24"],
  ];
  for (const [field, value] of safe) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox[field] = value;
    });
    assert.equal(result.status, "ready", `${field}=${value}`);
    assert.deepEqual(result.reasons, []);
  }
});

// --- Egress: a restriction is a property of the whole list (review B1r) -----

const slash8 = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `${from + index}.0.0.0/8`).join(
    ","
  );

test("a network allow list split into many ranges is not a restriction", async () => {
  const unsafe: [string, string][] = [
    ["256 x /8, every IPv4 address", slash8(0, 256)],
    ["11 x /8", slash8(1, 11)],
    ["11 x /32", Array.from({ length: 11 }, (_, i) => `192.0.2.${i}/32`).join(",")],
    ["11 entries with spaces", slash8(1, 11).replaceAll(",", " , ")],
  ];
  for (const [label, value] of unsafe) {
    for (const networkBlockAll of [false, true]) {
      const result = await withSandbox((sandbox) => {
        sandbox.domainAllowList = null;
        sandbox.networkBlockAll = networkBlockAll;
        sandbox.networkAllowList = value;
      });
      assert.equal(result.status, "incompatible", label);
      assert.deepEqual(
        result.reasons,
        [{ code: "egress_allow_list_unsafe", field: "networkAllowList" }],
        label
      );
    }
  }
  // A safe domain list beside it does not excuse it either.
  const beside = await withSandbox((sandbox) => {
    sandbox.networkAllowList = slash8(1, 11);
  });
  assert.equal(beside.status, "incompatible");
  assert.deepEqual(codes(beside), ["egress_allow_list_unsafe"]);
});

test("a network allow list of exactly the maximum number of ranges is accepted", async () => {
  for (const count of [1, 9, 10]) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox.networkAllowList = slash8(1, count);
    });
    assert.equal(result.status, "ready", `${count} ranges`);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.observed?.exposure.egressAllowListEntries, count);
  }
});

test("the network allow-list bounds are recorded as literal Castles policy", async () => {
  // Literals on purpose: a widened constant must turn this red.
  assert.deepEqual(SUPPORTED_PROFILE.network.networkAllowList, {
    basis: "castles-decision",
    maxEntries: 10,
    minIpv4Prefix: 8,
  });
  const { result } = await runCase("ready");
  assert.deepEqual(
    JSON.parse(renderJson(result)).sourcePolicy.network.networkAllowList,
    { basis: "castles-decision", maxEntries: 10, minIpv4Prefix: 8 }
  );
});

// --- Gates that had no test (review N1) ------------------------------------

async function withInspection(edit: (inspection: any) => void) {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection);
  edit(inspection);
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client, { evidence: "fixture" });
}

test("a missing or different credential-boundary marker needs reconciliation", async () => {
  for (const labels of [
    undefined,
    null,
    {},
    { credentialBoundaryVersion: "attempt-reset-v0" },
    ["attempt-reset-v1"],
  ]) {
    const result = await withInspection((inspection) => {
      inspection.sandbox.labels = labels;
    });
    assert.equal(result.status, "reconciliation-required");
    assert.deepEqual(codes(result), ["credential_boundary_unverified"]);
  }
});

test("a binding whose lifecycle is not ready needs reconciliation", async () => {
  for (const lifecycle of ["provisioning", "resetting", "failed", ""]) {
    const result = await withInspection((inspection) => {
      inspection.binding.lifecycle = lifecycle;
    });
    assert.equal(result.status, "reconciliation-required", lifecycle);
    assert.deepEqual(codes(result), ["binding_lifecycle_pending"]);
  }
});

test("a different SDK package is incompatible even at the pinned version", async () => {
  const result = await withInspection((inspection) => {
    inspection.sdk.package = "@fixture/other-sdk";
  });
  assert.equal(result.status, "incompatible");
  assert.deepEqual(codes(result), ["sdk_generation_mismatch"]);
});

test("an unsupported target or a non-Linux platform is incompatible", async () => {
  const target = await withInspection((inspection) => {
    inspection.sandbox.target = "fixture-region";
  });
  assert.equal(target.status, "incompatible");
  assert.deepEqual(codes(target), ["target_unsupported"]);

  const platform = await withInspection((inspection) => {
    inspection.platform.os = "fixture-os";
  });
  assert.equal(platform.status, "incompatible");
  assert.deepEqual(codes(platform), ["platform_unsupported"]);
});

test("each resource bound fails on its own, above and below", async () => {
  const { caps, floor } = SUPPORTED_PROFILE.resources;
  const edits: [string, number][] = [
    ["cpu", caps.cpu + 1],
    ["cpu", floor.cpu - 1],
    ["memory", caps.memoryGiB + 1],
    ["memory", floor.memoryGiB - 1],
    ["disk", caps.diskGiB + 1],
    ["disk", floor.diskGiB - 1],
  ];
  for (const [field, value] of edits) {
    const result = await withInspection((inspection) => {
      inspection.sandbox[field] = value;
    });
    assert.equal(result.status, "incompatible", `${field}=${value}`);
    assert.deepEqual(codes(result), ["resources_out_of_policy"]);
  }
  for (const [field, value] of [
    ["cpu", caps.cpu],
    ["cpu", floor.cpu],
    ["memory", caps.memoryGiB],
    ["memory", floor.memoryGiB],
  ] as const) {
    const result = await withInspection((inspection) => {
      inspection.sandbox[field] = value;
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
  assert.equal(parsed.sourcePolicy.pins.length, 16);
});

// --- Owner echo, disclosure and stated decisions (review N4 to N6) ---------

test("a response about a different agent record is refused and not disclosed", async () => {
  const result = await withInspection((inspection) => {
    inspection.binding.agentId = "fixture-agent-9999";
  });
  assert.equal(result.status, "unauthorized");
  assert.deepEqual(codes(result), ["owner_mismatch"]);
  assert.equal(result.observed, null);
  assert.doesNotMatch(renderJson(result), /fixture-agent-9999/u);

  const absent = await withInspection((inspection) => {
    delete inspection.binding.agentId;
  });
  assert.equal(absent.status, "unavailable");
  assert.deepEqual(codes(absent), ["inspection_contract_violation"]);
  assert.equal(absent.observed, null);
});

test("a stale generation is reported with the observed metadata, by decision", async () => {
  const result = await withInspection((inspection) => {
    inspection.binding.generation = 9;
  });
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(codes(result), ["generation_mismatch"]);
  assert.notEqual(result.observed, null);
  assert.equal(result.observed?.binding.generation, 9);
});

test("absent or null TTL and attachment keys read as not set, by decision", async () => {
  for (const value of [undefined, null]) {
    const result = await withInspection((inspection) => {
      for (const key of [
        "autoDestroyAt",
        "volumes",
        "warmPoolId",
        "linkedSandboxId",
      ]) {
        if (value === undefined) {
          delete inspection.sandbox[key];
        } else {
          inspection.sandbox[key] = value;
        }
      }
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.reasons, []);
  }
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

test("a different SDK generation is incompatible, not best-effort", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as {
    sdk: Record<string, unknown>;
  };
  inspection.sdk.version = "0.221.0";
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
  assert.equal(result.status, "incompatible");
  assert.deepEqual(codes(result), ["sdk_generation_mismatch"]);
});

test("identity failures outrank compatibility findings", async () => {
  const fixture = loadFixtureCase(casePath("public-exposure"));
  const inspection = structuredClone(fixture.inspection) as {
    binding: Record<string, unknown>;
  };
  inspection.binding.generation = 9;
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
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
  assert.equal(parsed.sourcePolicy.sdk.version, "0.220.0");
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
  const inspection = structuredClone(fixture.inspection) as Record<
    string,
    unknown
  > & { platform: Record<string, unknown>; sandbox: Record<string, unknown> };
  inspection.sandbox.target = `us\n${CANARY}`;
  inspection.sandbox.errorReason = CANARY.repeat(5000);
  inspection.sandbox.env = { TOKEN: CANARY };
  inspection.sandbox.labels = {
    ...Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`label-${index}`, CANARY])
    ),
    credentialBoundaryVersion: "attempt-reset-v1",
  };
  inspection.platform.architecture = "x".repeat(100_000);
  inspection.extra = CANARY.repeat(5000);
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
  const json = renderJson(result);
  assert.ok(Buffer.byteLength(json) <= PREFLIGHT_JSON_MAX_BYTES);
  assert.doesNotMatch(json, new RegExp(CANARY, "u"));
  assert.doesNotMatch(renderHuman(result), new RegExp(CANARY, "u"));
  assert.notEqual(result.status, "ready");
});

test("reasons are capped", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection) as Record<
    string,
    unknown
  >;
  inspection.sandbox = {
    id: "fixture-sandbox-0001",
    labels: { credentialBoundaryVersion: "attempt-reset-v1" },
  };
  inspection.platform = {};
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client, {
    evidence: "fixture",
  });
  assert.equal(result.status, "incompatible");
  assert.ok(result.reasons.length <= 16);
});

// --- Contract pins and mutation owners -------------------------------------

test("source pins are exact repo@sha:path references", () => {
  assert.ok(SOURCE_PINS.length > 0);
  for (const { pin } of SOURCE_PINS) {
    assert.match(pin, /^OpenCoven\/[a-z-]+@[0-9a-f]{40}:[\w./-]+$/u);
  }
  assert.equal(SUPPORTED_PROFILE.sdk.package, "@daytona/sdk");
  assert.equal(SUPPORTED_PROFILE.sdk.version, "0.220.0");
});

test("every provider mutation names its existing upstream owner, and none is Castles", () => {
  const recorded = MUTATION_OWNERS.map((entry) => entry.mutation).sort();
  assert.deepEqual(recorded, [
    "adopt-policy",
    "archive",
    "create",
    "delete",
    "reset",
    "resize",
    "start",
    "stop",
  ]);
  for (const entry of MUTATION_OWNERS) {
    assert.match(entry.owner, /^OpenCoven\/coven-agents@[0-9a-f]{40}:/u);
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

// --- Structural: no second adapter, no network, no writes ------------------

/**
 * An allowlist, not a blocklist (review N2): every import must be a static
 * named import of a binding listed here. Anything else fails, including a
 * new `node:fs` function, a namespace or default import of a module that can
 * write, a dynamic import, `require`, or a network/process global.
 */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "node:crypto": ["createHash"],
  "node:fs": ["readFileSync"],
  "node:process": ["default"],
  "node:util": ["parseArgs"],
};
const FORBIDDEN_GLOBALS =
  /\b(?:globalThis|fetch|XMLHttpRequest|WebSocket|EventSource|require|eval|Function|Worker|Deno|Bun)\b|\bimport\s*\(|\bimport\.meta\b|process\.(?:binding|dlopen|kill|chdir|getBuiltinModule|mainModule)/u;

function importsOf(source: string) {
  const found: { names: string[]; specifier: string }[] = [];
  const statement =
    /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";?$/gmu;
  for (const match of source.matchAll(statement)) {
    const clause = (match[1] ?? "").trim();
    const names = clause.startsWith("{")
      ? clause
          .replace(/^\{|\}$/gu, "")
          .split(",")
          .map((name) => name.trim().replace(/^type\s+/u, ""))
          .filter((name) => name !== "")
      : clause.startsWith("*")
        ? ["*"]
        : ["default"];
    found.push({ names, specifier: match[2] ?? "" });
  }
  return found;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

function capabilityProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  const code = withoutComments(source);
  const imports = importsOf(code);
  const importKeywords = [...code.matchAll(/^\s*import\b/gmu)].length;
  if (imports.length !== importKeywords) {
    problems.push(`${file}: an import statement is not a plain static import`);
  }
  for (const { names, specifier } of imports) {
    if (specifier.startsWith("./")) {
      continue;
    }
    const allowed = ALLOWED_IMPORTS[specifier];
    if (!allowed) {
      problems.push(`${file}: imports ${specifier}`);
      continue;
    }
    for (const name of names) {
      if (!allowed.includes(name)) {
        problems.push(`${file}: imports ${name} from ${specifier}`);
      }
    }
  }
  const forbidden = FORBIDDEN_GLOBALS.exec(code);
  if (forbidden) {
    problems.push(`${file}: uses ${forbidden[0]}`);
  }
  return problems;
}

test("source imports only allowlisted bindings and no network or process global", () => {
  for (const file of ["cli.ts", "preflight.ts", "profile.ts"]) {
    const source = readFileSync(join(root, "src", file), "utf8");
    assert.deepEqual(capabilityProblems(file, source), []);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("the capability allowlist rejects the evasions the old blocklist missed", () => {
  const evasions = [
    'import { openSync, writeSync } from "node:fs";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import * as fs from "node:fs";',
    'import fs from "node:fs";',
    'import { request } from "node:https";',
    'import { spawn } from "node:child_process";',
    'import { createRequire } from "node:module";',
    "const f = globalThis.fetch;",
    'const net = await import("node:net");',
    'const fs = require("node:fs");',
    'process.binding("fs");',
    'process.getBuiltinModule("node:fs");',
    'import("node:" + "http");',
    'import {\n  readFileSync,\n  rmSync,\n} from "node:fs";',
  ];
  for (const line of evasions) {
    assert.notDeepEqual(capabilityProblems("probe.ts", line), [], line);
  }
  assert.deepEqual(
    capabilityProblems(
      "probe.ts",
      'import { readFileSync } from "node:fs";\nimport { type Binding, parseBinding } from "./profile";'
    ),
    []
  );
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
