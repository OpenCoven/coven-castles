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
    sandbox: Record<string, unknown>;
  };
  inspection.sandbox.state = "archived";
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
  const result = await runPreflight(fixture.env, wire.client);
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
    { ...(fixture.inspection as object), sandbox: null },
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
    const result = await runPreflight(fixture.env, wire.client);
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
  return runPreflight(fixture.env, wire.client);
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

// --- Domain rule: ASCII names only, no IP literals (review N9) --------------

test("a domain entry is an ASCII multi-label name, never Unicode or an IP literal", async () => {
  const refused = [
    "examp\u017Fe.invalid", // long s: folds to "s" under /iu
    "\u212Aelvin.invalid", // Kelvin sign: folds to "k" under /iu
    "fixture.inva\u017Fid",
    "f\u0131xture.invalid", // dotless i
    "\uFF46ixture.invalid", // full-width f
    "fixture\u3002invalid", // ideographic full stop
    "0.0.0.0",
    "1.1.1.1",
    "127.0.0.1",
    "192.0.2.1",
    "10.1",
    "fixture.invalid.123",
    "1.2.3.4.5",
    "1.0x7f", // a hexadecimal final label is still an address to some parsers
    "fixture.0invalid",
  ];
  for (const value of refused) {
    for (const list of [value, `fixture.invalid,${value}`]) {
      const result = await withSandbox((sandbox) => {
        sandbox.domainAllowList = list;
      });
      assert.equal(result.status, "incompatible", JSON.stringify(list));
      assert.deepEqual(
        result.reasons,
        [{ code: "egress_allow_list_unsafe", field: "domainAllowList" }],
        JSON.stringify(list)
      );
    }
  }
  for (const value of [
    "FIXTURE.Invalid",
    "Kelvin.invalid",
    "123.fixture.invalid",
    "1.2.3.x4",
    "xn--fixture-9ya.invalid",
  ]) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = value;
    });
    assert.equal(result.status, "ready", value);
  }
});

// --- Gates that had no test (review N1) ------------------------------------

async function withInspection(edit: (inspection: any) => void) {
  const fixture = loadFixtureCase(casePath("ready"));
  const inspection = structuredClone(fixture.inspection);
  edit(inspection);
  const wire = tripwireClient(() => inspection);
  return runPreflight(fixture.env, wire.client);
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
  assert.equal(parsed.sourcePolicy.pins.length, 18);
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
    sdk: Record<string, unknown>;
  };
  inspection.sdk.version = "0.221.0";
  const wire = tripwireClient(() => inspection);
  const result = await runPreflight(fixture.env, wire.client);
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
  const result = await runPreflight(fixture.env, wire.client);
  const json = renderJson(result);
  assert.ok(Buffer.byteLength(json) <= PREFLIGHT_JSON_MAX_BYTES);
  assert.doesNotMatch(json, new RegExp(CANARY, "u"));
  assert.doesNotMatch(renderHuman(result), new RegExp(CANARY, "u"));
  assert.notEqual(result.status, "ready");
});

// --- Provider free text is never echoed (review N1) ------------------------

const ECHOED_FIELDS: readonly (readonly [
  string,
  (inspection: any, value: unknown) => void,
])[] = [
  ["sandbox.state", (i, v) => (i.sandbox.state = v)],
  ["sandbox.target", (i, v) => (i.sandbox.target = v)],
  ["sandbox.snapshot", (i, v) => (i.sandbox.snapshot = v)],
  ["platform.os", (i, v) => (i.platform.os = v)],
  ["platform.architecture", (i, v) => (i.platform.architecture = v)],
  ["sdk.version", (i, v) => (i.sdk.version = v)],
  ["binding.lifecycle", (i, v) => (i.binding.lifecycle = v)],
  ["binding.attemptFence", (i, v) => (i.binding.attemptFence = v)],
];

test("no echoed field can carry the configured IDs or free text into output", async () => {
  const hostile = [
    "fixture-sandbox-0001",
    "fixture-agent-0001",
    CANARY,
    "canary9f2c",
    "x",
    "1.2.3-canary9f2c",
    "0.220.0.canary9f2c",
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
    "binding.attemptFence": (r) => r.observed?.binding.attemptFence,
    "binding.lifecycle": (r) => r.observed?.binding.lifecycle,
    "platform.architecture": (r) => r.observed?.platform.architecture,
    "platform.os": (r) => r.observed?.platform.os,
    "sandbox.snapshot": (r) => r.observed?.image.snapshot,
    "sandbox.state": (r) => r.observed?.state,
    "sandbox.target": (r) => r.observed?.target,
    "sdk.version": (r) => r.observed?.sdk.version,
  };
  for (const [field, set] of ECHOED_FIELDS) {
    const unknown = await withInspection((inspection) =>
      set(inspection, "fixture-free-text")
    );
    assert.equal(read[field]?.(unknown), "unrecognised", field);
    // The two binding fields are required strings; absence is a contract
    // violation and discloses nothing.
    if (field.startsWith("binding.")) {
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
    ["sandbox.state", "archiving", (r) => r.observed?.state],
    ["sandbox.state", "build_failed", (r) => r.observed?.state],
    ["sandbox.target", "eu", (r) => r.observed?.target],
    ["sandbox.snapshot", "coven-agents-copilot-2", (r) => r.observed?.image.snapshot],
    ["platform.os", "linux", (r) => r.observed?.platform.os],
    ["platform.architecture", "x86_64", (r) => r.observed?.platform.architecture],
    ["platform.architecture", "arm64", (r) => r.observed?.platform.architecture],
    ["sdk.version", "0.221.0", (r) => r.observed?.sdk.version],
    ["sdk.version", "10.0.999", (r) => r.observed?.sdk.version],
    ["binding.lifecycle", "provisioning_ambiguous", (r) => r.observed?.binding.lifecycle],
    ["binding.attemptFence", "cleanup_required", (r) => r.observed?.binding.attemptFence],
  ];
  const setters = new Map(ECHOED_FIELDS);
  for (const [field, value, get] of known) {
    const result = await withInspection((inspection) =>
      setters.get(field)?.(inspection, value)
    );
    assert.equal(get(result), value, `${field}=${String(value)}`);
  }
  for (const version of ["0.220", "0.220.0.1", "v0.220.0", "0.220.0-rc1", "0000.1.1", "01.2.3"]) {
    const result = await withInspection((inspection) => {
      inspection.sdk.version = version;
    });
    assert.equal(result.observed?.sdk.version, "unrecognised", version);
  }
});

test("an architecture outside the known set is missing metadata, not ready", async () => {
  for (const architecture of ["fixture-arch", "riscv64", "X86_64", "", null, undefined, 64]) {
    const result = await withInspection((inspection) => {
      inspection.platform.architecture = architecture;
    });
    assert.equal(result.status, "incompatible", String(architecture));
    assert.deepEqual(result.reasons, [
      { code: "metadata_missing", field: "platform.architecture" },
    ]);
  }
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
  ["sandbox.cpu", (i, v) => (i.sandbox.cpu = v), (r) => r.observed?.resources.cpu],
  ["sandbox.memory", (i, v) => (i.sandbox.memory = v), (r) => r.observed?.resources.memoryGiB],
  ["sandbox.disk", (i, v) => (i.sandbox.disk = v), (r) => r.observed?.resources.diskGiB],
  ["sandbox.gpu", (i, v) => (i.sandbox.gpu = v), (r) => r.observed?.resources.gpu],
  ["sandbox.autoStopInterval", (i, v) => (i.sandbox.autoStopInterval = v), (r) => r.observed?.lifecycle.autoStopInterval],
  ["sandbox.autoArchiveInterval", (i, v) => (i.sandbox.autoArchiveInterval = v), (r) => r.observed?.lifecycle.autoArchiveInterval],
  ["sandbox.autoDeleteInterval", (i, v) => (i.sandbox.autoDeleteInterval = v), (r) => r.observed?.lifecycle.autoDeleteInterval],
  ["sandbox.autoPauseInterval", (i, v) => (i.sandbox.autoPauseInterval = v), (r) => r.observed?.lifecycle.autoPauseInterval],
  ["binding.generation", (i, v) => (i.binding.generation = v), (r) => r.observed?.binding.generation],
];

test("R1: an all-digit configured ID returned in a numeric field never reaches output", async () => {
  const fixture = loadFixtureCase(casePath("ready"));
  // Invented all-digit identifiers. The last is the smallest the rule covers.
  for (const digits of ["900719925474", "4815162342", "900719925", "100000"]) {
    for (const key of ["CASTLES_SANDBOX_ID", "CASTLES_OWNER_AGENT_ID"] as const) {
      const env = { ...fixture.env, [key]: digits };
      for (const [field, set, read] of INTEGER_FIELDS) {
        const where = `${key}=${digits} returned in ${field}`;
        const inspection = structuredClone(fixture.inspection) as any;
        inspection.binding.agentId = env.CASTLES_OWNER_AGENT_ID;
        inspection.binding.sandboxId = env.CASTLES_SANDBOX_ID;
        inspection.sandbox.id = env.CASTLES_SANDBOX_ID;
        set(inspection, Number(digits));
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
    for (const value of inside) {
      const result = await withInspection((inspection) => set(inspection, value));
      assert.equal(read(result), value, `${field}=${value}`);
    }
    // 99999 is out of policy for every field, so a value beyond the range
    // must be reported exactly as it is: same status, same reasons.
    const reference = await withInspection((inspection) => set(inspection, 99_999));
    assert.notEqual(reference.status, "ready", field);
    assert.equal(reference.reasons.length, 1, field);
    for (const value of outside) {
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
    inspection.binding.generation = 100_000;
  });
  assert.equal(stale.status, "reconciliation-required");
  assert.deepEqual(stale.reasons, [
    { code: "generation_mismatch", field: "binding.generation" },
  ]);
  assert.equal(JSON.parse(renderJson(stale)).observed.binding.generation, null);
  assert.match(renderHuman(stale), /^  binding generation \?, lifecycle ready, /mu);

  // matchesTarget follows the readings themselves, each of the three, and
  // is false for a reading that is not echoed.
  for (const [field, value] of [
    ["cpu", 3],
    ["memory", 5],
    ["disk", 11],
    ["disk", 9],
    ["cpu", 100_000],
    ["memory", 100_000],
    ["disk", 100_000],
  ] as const) {
    const off = await withInspection((inspection) => {
      inspection.sandbox[field] = value;
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
    inspection.binding.generation = generation;
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
  inspection.binding.sandboxId = "4";
  inspection.sandbox.id = "4";
  inspection.sandbox.cpu = 4;
  const result = await runPreflight(env, tripwireClient(() => inspection).client);
  assert.equal(result.status, "ready");
  assert.equal(result.observed?.resources.cpu, 4);
});

test("N4: the volume count is echoed only as an integer from 0 to 999", async () => {
  // The same leak class as R1, in a field that is not one of the nine
  // (review rv11 N4). An array parsed from JSON always has a length that is
  // an integer from 0 up, so the CLI cannot reach this. A response held in
  // memory can: an array behind a proxy reports any length it likes, and the
  // count was capped from above only.
  const fixture = loadFixtureCase(casePath("ready"));
  const digits = "900719925474";
  const env = { ...fixture.env, CASTLES_SANDBOX_ID: digits };
  const lengths: [string, unknown, number | null, string, string[]][] = [
    ["minus the ID", -Number(digits), 0, "ready", []],
    ["-1", -1, 0, "ready", []],
    ["the ID as a fraction", Number(`0.${digits}`), null, "incompatible", ["volumes_present"]],
    ["the ID as text", digits, null, "incompatible", ["volumes_present"]],
    ["not a number", Number.NaN, null, "ready", []],
    ["0", 0, 0, "ready", []],
    ["5", 5, 5, "incompatible", ["volumes_present"]],
    ["999", 999, 999, "incompatible", ["volumes_present"]],
    ["the ID", Number(digits), 999, "incompatible", ["volumes_present"]],
  ];
  for (const [label, length, echoed, status, expected] of lengths) {
    const inspection = structuredClone(fixture.inspection) as any;
    inspection.binding.sandboxId = digits;
    inspection.sandbox.id = digits;
    inspection.sandbox.volumes = new Proxy([], {
      get: (target, key, receiver) =>
        key === "length" ? length : Reflect.get(target, key, receiver),
    });
    const result = await runPreflight(env, tripwireClient(() => inspection).client);
    // Status and reasons are what they were at 13ab3bc; only the echo moves.
    assert.equal(result.status, status, label);
    assert.deepEqual(codes(result), expected, label);
    assert.equal(result.observed?.attachments.volumes, echoed, label);
    for (const output of [renderJson(result), renderHuman(result)]) {
      assert.ok(!output.includes(digits), label);
    }
  }
  // A real array is counted as before.
  for (const [volumes, echoed] of [
    [[], 0],
    [["a"], 1],
    [Array.from({ length: 1_500 }, () => "v"), 999],
  ] as const) {
    const inspection = structuredClone(fixture.inspection) as any;
    inspection.sandbox.volumes = volumes;
    const result = await runPreflight(fixture.env, tripwireClient(() => inspection).client);
    assert.equal(result.observed?.attachments.volumes, echoed);
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
  ["state", (i, v) => (i.sandbox.state = v), [7, true, {}]],
  ["public", (i, v) => (i.sandbox.public = v), ["false", 0, "no"]],
  ["networkBlockAll", (i, v) => (i.sandbox.networkBlockAll = v), ["false", 0]],
  ["autoStopInterval", (i, v) => (i.sandbox.autoStopInterval = v), ["15", 15.5, Number.NaN]],
  ["autoArchiveInterval", (i, v) => (i.sandbox.autoArchiveInterval = v), ["10080", 60.5]],
  ["autoDeleteInterval", (i, v) => (i.sandbox.autoDeleteInterval = v), ["-1", -1.5]],
  ["autoPauseInterval", (i, v) => (i.sandbox.autoPauseInterval = v), ["0", 0.5, false]],
  ["snapshot", (i, v) => (i.sandbox.snapshot = v), [2, ["coven-agents-copilot-2"]]],
  ["target", (i, v) => (i.sandbox.target = v), [1, ["us"]]],
  ["cpu", (i, v) => (i.sandbox.cpu = v), ["2", 2.5]],
  ["memory", (i, v) => (i.sandbox.memory = v), ["4", 4.5]],
  ["disk", (i, v) => (i.sandbox.disk = v), ["10", 10.5]],
  ["gpu", (i, v) => (i.sandbox.gpu = v), ["0", 0.5, false]],
  ["platform.os", (i, v) => (i.platform.os = v), [1, ["linux"]]],
  ["platform.architecture", (i, v) => (i.platform.architecture = v), [64]],
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
  const noPlatform = await withInspection((inspection) => {
    delete inspection.platform;
  });
  assert.equal(noPlatform.status, "incompatible");
  assert.deepEqual(noPlatform.reasons, [
    { code: "metadata_missing", field: "platform.os" },
    { code: "metadata_missing", field: "platform.architecture" },
  ]);
});

test("inspection parsing: a wrong label, an unknown outcome or a mistyped binding is a contract violation", async () => {
  const edits: [string, (inspection: any) => void][] = [
    ["contract absent", (i) => delete i.contract],
    ["contract other", (i) => (i.contract = "castles.fixture.sandbox-inspection.v0")],
    ["contract upper", (i) => (i.contract = "CASTLES.FIXTURE.SANDBOX-INSPECTION.V1")],
    ["contract prefixed", (i) => (i.contract = "castles.fixture.sandbox-inspection.v1 ")],
    ["contract array", (i) => (i.contract = ["castles.fixture.sandbox-inspection.v1"])],
    ["outcome absent", (i) => delete i.outcome],
    ["outcome null", (i) => (i.outcome = null)],
    ["outcome unknown", (i) => (i.outcome = "ok")],
    ["outcome cased", (i) => (i.outcome = "Observed")],
    ["outcome ready", (i) => (i.outcome = "ready")],
    ["outcome number", (i) => (i.outcome = 1)],
    ["generation float", (i) => (i.binding.generation = 3.5)],
    ["generation string", (i) => (i.binding.generation = "3")],
    ["generation null", (i) => (i.binding.generation = null)],
    ["generation absent", (i) => delete i.binding.generation],
    ["generation NaN", (i) => (i.binding.generation = Number.NaN)],
    ["generation unsafe", (i) => (i.binding.generation = 2 ** 53)],
    ["binding absent", (i) => delete i.binding],
    ["binding array", (i) => (i.binding = [])],
    ["binding.sandboxId number", (i) => (i.binding.sandboxId = 1)],
    ["binding.sandboxId absent", (i) => delete i.binding.sandboxId],
    ["binding.agentId number", (i) => (i.binding.agentId = 1)],
    ["binding.lifecycle absent", (i) => delete i.binding.lifecycle],
    ["binding.lifecycle boolean", (i) => (i.binding.lifecycle = true)],
    ["binding.attemptFence absent", (i) => delete i.binding.attemptFence],
    ["binding.attemptFence null", (i) => (i.binding.attemptFence = null)],
    ["sandbox absent", (i) => delete i.sandbox],
    ["sandbox.id absent", (i) => delete i.sandbox.id],
    ["sandbox.id number", (i) => (i.sandbox.id = 1)],
    ["sdk absent", (i) => delete i.sdk],
    ["sdk string", (i) => (i.sdk = "0.220.0")],
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

test("inspection parsing: each refusal outcome maps to one status and code, and needs the label", async () => {
  const contract = "castles.fixture.sandbox-inspection.v1";
  const table: [Record<string, unknown>, string, string][] = [
    [{ outcome: "not_found" }, "unavailable", "sandbox_not_found"],
    [{ outcome: "ambiguous" }, "reconciliation-required", "ambiguous_lookup"],
    [{ outcome: "unavailable" }, "unavailable", "provider_unavailable"],
    [{ outcome: "unauthorized", reason: "owner_mismatch" }, "unauthorized", "owner_mismatch"],
    [{ outcome: "unauthorized", reason: "unauthenticated" }, "unauthorized", "unauthenticated"],
    [{ outcome: "unauthorized" }, "unauthorized", "unauthenticated"],
    [{ outcome: "unauthorized", reason: CANARY }, "unauthorized", "unauthenticated"],
  ];
  for (const [body, status, code] of table) {
    const labelled = await runPreflight(
      VALID_ENV,
      tripwireClient(() => ({ contract, ...body })).client
    );
    assert.equal(labelled.status, status, code);
    assert.deepEqual(labelled.reasons, [{ code }]);
    assert.equal(labelled.observed, null);
    assert.doesNotMatch(renderJson(labelled), new RegExp(CANARY, "u"));

    const unlabelled = await runPreflight(
      VALID_ENV,
      tripwireClient(() => body).client
    );
    assert.equal(unlabelled.status, "unavailable", code);
    assert.deepEqual(unlabelled.reasons, [
      { code: "inspection_contract_violation" },
    ]);
  }
});

test("a recorded generation that differs in either direction is stale", async () => {
  for (const generation of [0, 1, 2, 4, 9, -1, 999_999_999]) {
    const result = await withInspection((inspection) => {
      inspection.binding.generation = generation;
    });
    assert.equal(result.status, "reconciliation-required", String(generation));
    assert.deepEqual(result.reasons, [
      { code: "generation_mismatch", field: "binding.generation" },
    ]);
  }
  const same = await withInspection((inspection) => {
    inspection.binding.generation = 3;
  });
  assert.equal(same.status, "ready");
});

test("an attempt fence other than clear needs reconciliation", async () => {
  for (const fence of ["cleanup_required", "held", "", "Clear", "clear "]) {
    const result = await withInspection((inspection) => {
      inspection.binding.attemptFence = fence;
    });
    assert.equal(result.status, "reconciliation-required", fence);
    assert.deepEqual(result.reasons, [
      { code: "attempt_fence_held", field: "binding.attemptFence" },
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
      egress: "restricted",
      networkAllowList: {
        basis: "castles-decision",
        maxEntries: 10,
        minIpv4Prefix: 8,
      },
      public: false,
    },
    platform: { architecture: "reported-not-pinned", os: "linux" },
    provider: "daytona",
    resources: {
      caps: { cpu: 4, diskGiB: 10, memoryGiB: 8 },
      floor: { cpu: 1, diskGiB: 10, memoryGiB: 1 },
      target: { cpu: 2, diskGiB: 10, memoryGiB: 4 },
    },
    sdk: { package: "@daytona/sdk", version: "0.220.0" },
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
    ["memory", 0, "incompatible", "resources_out_of_policy"],
    ["memory", 1, "ready"],
    ["memory", 8, "ready"],
    ["memory", 9, "incompatible", "resources_out_of_policy"],
    ["disk", 9, "incompatible", "resources_out_of_policy"],
    ["disk", 10, "ready"],
    ["disk", 11, "incompatible", "resources_out_of_policy"],
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
  for (const [field, value] of [["cpu", 4], ["memory", 8], ["cpu", 1]] as const) {
    const off = await withSandbox((sandbox) => {
      sandbox[field] = value;
    });
    assert.equal(off.status, "ready");
    assert.equal(off.observed?.resources.matchesTarget, false, field);
  }
});

test("pins: the upstream revision and the pinned paths are these literals", () => {
  const prefix =
    "OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180:";
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
    (i) => (i.binding.sandboxId = "fixture-sandbox-9999"),
  ];
  const returned: Finding = [
    "reconciliation-required",
    "returned_id_mismatch",
    (i) => (i.sandbox.id = "fixture-sandbox-9999"),
  ];
  const stale: Finding = [
    "reconciliation-required",
    "generation_mismatch",
    (i) => (i.binding.generation = 2),
  ];
  const exposed: Finding = [
    "incompatible",
    "public_exposure",
    (i) => (i.sandbox.public = true),
  ];
  const unsettled: Finding = [
    "unavailable",
    "lifecycle_not_settled",
    (i) => (i.sandbox.state = "starting"),
  ];
  const destroyed: Finding = [
    "unavailable",
    "sandbox_destroyed",
    (i) => (i.sandbox.state = "destroying"),
  ];
  const stopped: Finding = [
    "stopped",
    "sandbox_stopped",
    (i) => (i.sandbox.state = "stopped"),
  ];
  // Each row lists findings from highest to lowest priority. Reasons must be
  // reported in that order whatever order the edits were applied in.
  const rows: Finding[][] = [
    [unauthorized, returned],
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

test("egress pattern edges", async () => {
  const label63 = "a".repeat(63);
  const name253 = `${[label63, label63, label63].join(".")}.${"b".repeat(58)}.io`;
  const name254 = `${[label63, label63, label63].join(".")}.${"b".repeat(59)}.io`;
  assert.equal(name253.length, 253);
  assert.equal(name254.length, 254);
  const table: [string, string, "ready" | "incompatible"][] = [
    ["networkAllowList", "10.0.0.0/8", "ready"],
    ["networkAllowList", "255.255.255.255/32", "ready"],
    ["networkAllowList", "0.0.0.0/8", "ready"],
    ["networkAllowList", "256.0.0.0/8", "incompatible"],
    ["networkAllowList", "10.256.0.0/16", "incompatible"],
    ["networkAllowList", "10.0.0.256/32", "incompatible"],
    ["networkAllowList", "x10.0.0.0/8", "incompatible"],
    ["networkAllowList", "10.0.0.0/8x", "incompatible"],
    ["networkAllowList", "1.10.0.0.0/8", "incompatible"],
    ["networkAllowList", "10.0.0.0/8/8", "incompatible"],
    ["networkAllowList", "10.0.0.0/8 10.1.0.0/16", "incompatible"],
    ["networkAllowList", "10.0.0/8", "incompatible"],
    ["networkAllowList", "010.0.0.0/8", "incompatible"],
    ["networkAllowList", "10.0.0.0/7", "incompatible"],
    ["networkAllowList", "10.0.0.0/0", "incompatible"],
    ["networkAllowList", "10.0.0.0/", "incompatible"],
    ["networkAllowList", "１０.0.0.0/8", "incompatible"],
    ["domainAllowList", "localhost", "incompatible"],
    ["domainAllowList", "invalid", "incompatible"],
    ["domainAllowList", ".invalid", "incompatible"],
    ["domainAllowList", "fixture.invalid.", "incompatible"],
    ["domainAllowList", "fixture..invalid", "incompatible"],
    ["domainAllowList", "-fixture.invalid", "incompatible"],
    ["domainAllowList", "fixture-.invalid", "incompatible"],
    ["domainAllowList", "x.fixture.invalid!", "incompatible"],
    ["domainAllowList", "!x.fixture.invalid", "incompatible"],
    ["domainAllowList", `${label63}.invalid`, "ready"],
    ["domainAllowList", `${label63}a.invalid`, "incompatible"],
    ["domainAllowList", `fixture.${label63}`, "ready"],
    ["domainAllowList", `fixture.${label63}a`, "incompatible"],
    ["domainAllowList", name253, "ready"],
    ["domainAllowList", name254, "incompatible"],
  ];
  for (const [field, value, status] of table) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox[field] = value;
    });
    assert.equal(result.status, status, `${field}=${value}`);
    assert.deepEqual(
      result.reasons,
      status === "ready" ? [] : [{ code: "egress_allow_list_unsafe", field }],
      `${field}=${value}`
    );
  }
});

test("egress: no usable restriction at all is unrestricted; block-all alone is restricted", async () => {
  for (const [domains, networks] of [
    [null, null],
    [undefined, undefined],
    ["", ""],
    [" , ,", null],
    [null, ","],
  ]) {
    const open = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = false;
      sandbox.domainAllowList = domains;
      sandbox.networkAllowList = networks;
    });
    assert.equal(open.status, "incompatible");
    assert.deepEqual(open.reasons, [
      { code: "egress_unrestricted", field: "egress" },
    ]);
    assert.equal(open.observed?.exposure.egressAllowListEntries, 0);

    const blocked = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = true;
      sandbox.domainAllowList = domains;
      sandbox.networkAllowList = networks;
    });
    assert.equal(blocked.status, "ready");
    assert.equal(blocked.observed?.exposure.networkBlockAll, true);
  }
  const both = await withSandbox((sandbox) => {
    sandbox.domainAllowList = "a.fixture.invalid,b.fixture.invalid";
    sandbox.networkAllowList = "192.0.2.0/24";
  });
  assert.equal(both.status, "ready");
  assert.equal(both.observed?.exposure.egressAllowListEntries, 3);

  // The reported count is capped; the domain list itself has no entry bound.
  const many = await withSandbox((sandbox) => {
    sandbox.domainAllowList = Array.from(
      { length: 1200 },
      (_, index) => `h${index}.fixture.invalid`
    ).join(",");
  });
  assert.equal(many.status, "ready");
  assert.equal(many.observed?.exposure.egressAllowListEntries, 999);
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
    inspection.binding.generation = 2;
    inspection.binding.lifecycle = CANARY;
    inspection.binding.attemptFence = CANARY;
    inspection.sdk = { package: CANARY, version: CANARY };
    inspection.platform = { architecture: CANARY, os: CANARY };
    inspection.sandbox = {
      autoArchiveInterval: 1,
      autoDeleteInterval: 1,
      autoDestroyAt: CANARY,
      autoPauseInterval: 1,
      autoStopInterval: 1,
      cpu: 99,
      disk: 99,
      domainAllowList: `*,${CANARY}`,
      gpu: 9,
      id: "fixture-sandbox-0001",
      labels: { note: CANARY },
      linkedSandboxId: CANARY,
      memory: 99,
      networkAllowList: "0.0.0.0/0",
      networkBlockAll: CANARY,
      public: true,
      snapshot: CANARY,
      state: CANARY,
      target: CANARY,
      volumes: Array.from({ length: 5000 }, () => ({ volumeId: CANARY })),
      warmPoolId: CANARY,
    };
  });
}

test("reasons are capped at exactly 16, highest priority first, and the JSON stays bounded", async () => {
  const result = await worstCase();
  // 4 reconciliation findings and more than 12 compatibility findings exist.
  assert.equal(result.reasons.length, 16);
  assert.deepEqual(codes(result).slice(0, 5), [
    "generation_mismatch",
    "binding_lifecycle_pending",
    "attempt_fence_held",
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
    /^(?:unrecognised|absent|present|[a-z_]{2,24}|x86_64|coven-agents-copilot-2|\d{1,4}\.\d{1,4}\.\d{1,4})$/u;
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
  assert.equal(SUPPORTED_PROFILE.sdk.version, "0.220.0");
});

test("every provider mutation names its existing upstream owner, and none is Castles", () => {
  // Literal on purpose: the table is compared with what was read at the pin.
  const at = (path: string) =>
    `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180:${path}`;
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
        "OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180:lib/runner/daytona/process.ts",
      ],
      [
        "snapshot creation",
        "OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180:lib/runner/daytona/image.ts",
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

test("R4 egress: the entry cap counts every entry, duplicates included, and nothing else", async () => {
  const network = async (value: string) =>
    withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox.networkAllowList = value;
    });
  // Mutation: counting distinct entries. Eleven copies of one range are
  // eleven entries.
  const repeated = (count: number) =>
    Array.from({ length: count }, () => "10.0.0.0/8").join(",");
  for (const [label, value] of [
    ["11 x the same /8", repeated(11)],
    ["10 distinct ranges and one repeat", `${slash8(1, 10)},1.0.0.0/8`],
    ["12 entries, 2 distinct", `${repeated(6)},${Array.from({ length: 6 }, () => "11.0.0.0/8").join(",")}`],
  ] as const) {
    const result = await network(value);
    assert.equal(result.status, "incompatible", label);
    assert.deepEqual(
      result.reasons,
      [{ code: "egress_allow_list_unsafe", field: "networkAllowList" }],
      label
    );
  }
  const tenRepeats = await network(repeated(10));
  assert.equal(tenRepeats.status, "ready");
  assert.equal(tenRepeats.observed?.exposure.egressAllowListEntries, 10);

  // Mutation: counting raw comma-separated pieces. An empty piece is not an
  // entry, so ten ranges stay ten however the commas are padded.
  for (const [label, value] of [
    ["trailing commas", `${slash8(1, 10)},,`],
    ["leading commas", `,,${slash8(1, 10)}`],
    ["doubled commas", slash8(1, 10).replaceAll(",", ",,")],
    ["blank pieces", slash8(1, 10).replaceAll(",", " , , ")],
  ] as const) {
    const result = await network(value);
    assert.equal(result.status, "ready", label);
    assert.deepEqual(result.reasons, [], label);
    assert.equal(result.observed?.exposure.egressAllowListEntries, 10, label);
  }
});

test("R4 egress: the comma is the only separator in either allow list", async () => {
  // Mutation: accepting `;` (or anything else) as a second separator. Two
  // good entries joined by another character are one bad entry.
  const separators = [
    ";",
    "|",
    " ",
    "\t",
    "\n",
    "\r\n",
    ":",
    "+",
    "&",
    "\uFF0C", // full-width comma
    "\u3001", // ideographic comma
    "\u061B", // Arabic semicolon
  ];
  for (const separator of separators) {
    for (const [field, value] of [
      ["networkAllowList", `10.0.0.0/8${separator}11.0.0.0/8`],
      ["domainAllowList", `a.fixture.invalid${separator}b.fixture.invalid`],
    ] as const) {
      const where = `${field} joined by ${JSON.stringify(separator)}`;
      const result = await withSandbox((sandbox) => {
        sandbox.domainAllowList = null;
        sandbox[field] = value;
      });
      assert.equal(result.status, "incompatible", where);
      assert.deepEqual(
        result.reasons,
        [{ code: "egress_allow_list_unsafe", field }],
        where
      );
      assert.equal(result.observed?.exposure.egressAllowListEntries, 1, where);
    }
  }
});

test("R4 domain: no underscore in a label, and no label starts or ends with a hyphen", async () => {
  // Mutations: `_` allowed inside a label; a final label ending in `-`.
  const refused = [
    "fix_ture.invalid",
    "_fixture.invalid",
    "fixture_.invalid",
    "a.fix_ture.invalid",
    "fixture.in_valid",
    "fixture.invalid_",
    "fixture._invalid",
    "fixture.invalid-",
    "fixture.i-",
    "fixture.in-valid-",
    "fixture.-invalid",
    "fixture.-",
    "-.invalid",
    "a.fixture-.invalid",
  ];
  for (const value of refused) {
    for (const list of [value, `fixture.invalid,${value}`]) {
      const result = await withSandbox((sandbox) => {
        sandbox.domainAllowList = list;
      });
      assert.equal(result.status, "incompatible", JSON.stringify(list));
      assert.deepEqual(
        result.reasons,
        [{ code: "egress_allow_list_unsafe", field: "domainAllowList" }],
        JSON.stringify(list)
      );
    }
  }
  for (const value of [
    "fix-ture.invalid",
    "fixture.in-valid",
    "f--x.in--valid",
    "f.i",
    "0-0.i-0",
  ]) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = value;
    });
    assert.equal(result.status, "ready", value);
    assert.deepEqual(result.reasons, [], value);
  }
});

test("R4 sdk version: each part has at most four digits and nothing follows the version", async () => {
  const withVersion = (version: string) =>
    withInspection((inspection) => {
      inspection.sdk.version = version;
    });
  // Mutation: version parts of up to 31 digits.
  for (const version of ["9999.9999.9999", "1000.0.0", "0.1000.0", "0.0.1000"]) {
    const result = await withVersion(version);
    assert.equal(result.observed?.sdk.version, version, version);
  }
  const pinned = await withVersion("0.220.0");
  assert.equal(pinned.status, "ready");
  assert.equal(pinned.observed?.sdk.version, "0.220.0");
  const lines = renderHuman(pinned).split("\n").length;

  // Mutation: a multi-line flag on the version pattern, which would echo a
  // valid version followed by a newline and any text.
  const refused = [
    "10000.0.0",
    "0.10000.0",
    "0.0.10000",
    "12345678901234567890.0.0",
    "0.220.1234567890123456789012345678901",
    "0.220.0\n",
    "\n0.220.0",
    "0.220.0\nfixture-free-text",
    "fixture-free-text\n0.220.0",
    "0.220.0\r\nfixture-free-text",
    "0.220.0\rfixture-free-text",
    "0.220.0\u2028fixture-free-text",
    "0.220.0\u2029fixture-free-text",
    "0.220.0 ",
    " 0.220.0",
    "0.220.0\t",
    "0.220.0\u0000",
  ];
  for (const version of refused) {
    const where = JSON.stringify(version);
    const result = await withVersion(version);
    assert.equal(result.observed?.sdk.version, "unrecognised", where);
    assert.equal(result.status, "incompatible", where);
    assert.deepEqual(
      result.reasons,
      [{ code: "sdk_generation_mismatch", field: "sdk" }],
      where
    );
    const human = renderHuman(result);
    const json = renderJson(result);
    assert.match(human, /; sdk unrecognised\n/u, where);
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
// tests below red. `x64` is left out on purpose: whether it should join the
// architecture set is an open maintainer decision, and nothing here pins it.
const ECHO_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  "binding.attemptFence": ["clear", "cleanup_required"],
  "binding.lifecycle": [
    "unprovisioned",
    "provisioning",
    "provisioning_ambiguous",
    "ready",
    "resizing",
    "resetting",
    "decommissioning",
    "decommission_failed",
  ],
  "platform.architecture": ["x86_64", "amd64", "aarch64", "arm64"],
  "platform.os": ["linux"],
  "sandbox.snapshot": ["coven-agents-copilot-2"],
  "sandbox.state": [
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
  "sandbox.target": ["us", "eu"],
};
const ECHO_READERS: Readonly<
  Record<string, (result: PreflightResult) => unknown>
> = {
  "binding.attemptFence": (r) => r.observed?.binding.attemptFence,
  "binding.lifecycle": (r) => r.observed?.binding.lifecycle,
  "platform.architecture": (r) => r.observed?.platform.architecture,
  "platform.os": (r) => r.observed?.platform.os,
  "sandbox.snapshot": (r) => r.observed?.image.snapshot,
  "sandbox.state": (r) => r.observed?.state,
  "sandbox.target": (r) => r.observed?.target,
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
  "open",
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
  // Mutation: removing `amd64`, a sandbox state or a binding lifecycle.
  const setters = new Map(ECHOED_FIELDS);
  let checked = 0;
  for (const [field, members] of Object.entries(ECHO_VOCABULARY)) {
    for (const member of members) {
      const result = await withInspection((inspection) =>
        setters.get(field)?.(inspection, member)
      );
      assert.equal(ECHO_READERS[field]?.(result), member, `${field}=${member}`);
      checked += 1;
    }
  }
  assert.equal(checked, 2 + 8 + 4 + 1 + 1 + 22 + 2);
  // Each stated architecture is also accepted, not only echoed.
  for (const architecture of ECHO_VOCABULARY["platform.architecture"] ?? []) {
    const result = await withInspection((inspection) => {
      inspection.platform.architecture = architecture;
    });
    assert.equal(result.status, "ready", architecture);
    assert.deepEqual(result.reasons, [], architecture);
  }
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
    ["owner_mismatch", "unauthorized", (i) => (i.binding.agentId = "fixture-agent-9999")],
    ["binding_mismatch", "unauthorized", (i) => (i.binding.sandboxId = "fixture-sandbox-9999")],
    ["returned_id_mismatch", "reconciliation-required", (i) => (i.sandbox.id = "fixture-sandbox-9999")],
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
    `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180:${path}`;
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
  Object.defineProperty(inspection.sandbox, "cpu", { get: raise });
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
    if (!file.endsWith(".ts")) {
      problems.push(`${file}: not a TypeScript source file`);
      continue;
    }
    const code = withoutComments(source);

    const forbidden = FORBIDDEN_ANYWHERE.exec(source);
    if (forbidden) {
      problems.push(`${file}: contains ${forbidden[0]}`);
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

/** Every entry under src/, as posix paths relative to src/. */
function readSourceTree(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${relative}/`);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.set(relative, readFileSync(join(directory, entry.name), "utf8"));
      } else {
        // Not a TypeScript source file: scanSources reports it by name.
        files.set(relative, "");
      }
    }
  };
  walk(join(root, "src"), "");
  return files;
}

test("every file under src/ passes the capability scan", () => {
  const files = readSourceTree();
  assert.deepEqual([...files.keys()].sort(), [
    "cli.ts",
    "preflight.ts",
    "profile.ts",
  ]);
  assert.deepEqual(scanSources(files), []);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
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
  assert.equal(SCAN_KNOWN_GAPS.length, 6);
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
  "  profile castles.daytona-private-linux.v1; target 2 vCPU / 4 GiB / 10 GiB; @daytona/sdk@0.220.0; 18 source pins (see --json)",
];
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
      "  state started; 2 vCPU / 4 GiB RAM / 10 GiB disk; snapshot coven-agents-copilot-2; linux/x86_64; sdk 0.220.0",
      "  public false; egress allow-list entries 1; auto-stop 15 min; auto-archive 10080 min; auto-delete -1; ttl absent",
      "  binding generation 3, lifecycle ready, attempt fence clear",
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
    const { sandbox } = inspection;
    delete sandbox.state;
    sandbox.cpu = "2";
    sandbox.memory = 1.5;
    sandbox.disk = null;
    sandbox.snapshot = 7;
    delete inspection.platform;
    inspection.sdk.version = 220;
    sandbox.public = "no";
    sandbox.autoStopInterval = "15";
    sandbox.autoArchiveInterval = null;
    delete sandbox.autoDeleteInterval;
    sandbox.autoPauseInterval = 0.5;
    sandbox.gpu = "0";
    sandbox.target = 1;
    sandbox.networkBlockAll = 1;
  });
  assert.equal(
    renderHuman(result),
    [
      "castles preflight - status: incompatible",
      "evidence: FIXTURE (synthetic input; not provider evidence)",
      HUMAN_TARGET_LINE,
      "reasons:",
      "  - sdk_generation_mismatch (sdk)",
      "  - metadata_missing (state)",
      "  - metadata_missing (public)",
      "  - metadata_missing (networkBlockAll)",
      "  - metadata_missing (autoStopInterval)",
      "  - metadata_missing (autoArchiveInterval)",
      "  - metadata_missing (autoDeleteInterval)",
      "  - metadata_missing (autoPauseInterval)",
      "  - metadata_missing (snapshot)",
      "  - metadata_missing (target)",
      "  - metadata_missing (cpu)",
      "  - metadata_missing (memory)",
      "  - metadata_missing (disk)",
      "  - metadata_missing (gpu)",
      "  - metadata_missing (platform.os)",
      "  - metadata_missing (platform.architecture)",
      "observed (as reported through the seam):",
      "  state ?; ? vCPU / ? GiB RAM / ? GiB disk; snapshot ?; ?/?; sdk ?",
      "  public ?; egress allow-list entries 1; auto-stop ? min; auto-archive ? min; auto-delete ?; ttl absent",
      "  binding generation 3, lifecycle ready, attempt fence clear",
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
  inspection.binding.generation = 0;
  Object.assign(inspection.sandbox, {
    autoArchiveInterval: 0,
    autoDeleteInterval: 0,
    autoDestroyAt: "2030-01-01T00:00:00Z",
    autoStopInterval: 0,
    cpu: 0,
    disk: 0,
    memory: 0,
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
      "  - lifecycle_ttl (autoDestroyAt)",
      "  - resources_out_of_policy (resources)",
      "observed (as reported through the seam):",
      "  state started; 0 vCPU / 0 GiB RAM / 0 GiB disk; snapshot coven-agents-copilot-2; linux/x86_64; sdk 0.220.0",
      "  public false; egress allow-list entries 1; auto-stop 0 min; auto-archive 0 min; auto-delete 0; ttl present",
      "  binding generation 0, lifecycle ready, attempt fence clear",
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
    inspection.binding.agentId = "fixture-agent-0002";
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
      egress: "restricted",
      networkAllowList: {
        basis: "castles-decision",
        maxEntries: 10,
        minIpv4Prefix: 8,
      },
      public: false,
    },
    platform: { architecture: "reported-not-pinned", os: "linux" },
    profile: "castles.daytona-private-linux.v1",
    resources: {
      caps: { cpu: 4, diskGiB: 10, memoryGiB: 8 },
      floor: { cpu: 1, diskGiB: 10, memoryGiB: 1 },
      target: { cpu: 2, diskGiB: 10, memoryGiB: 4 },
    },
    sdk: { package: "@daytona/sdk", version: "0.220.0" },
  });
  assert.equal(pins.length, 18);
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
      "toolchain (pnpm 10.32.1, tsx, TypeScript) and @daytona/sdk 0.220.0",
      "resolved @daytona/sdk 0.220.0 and its API clients",
      "the tsx --test and tsc --noEmit scripts",
      "resource defaults (2 vCPU / 4 GiB / 10 GiB) and caps",
      "auto-stop and auto-archive bounds; TTL 0; auto-delete -1",
      "create parameters (private, non-ephemeral), credential-boundary marker, lifecycle mutations",
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
    ["incompatible", "public_exposure", "public", (i) => (i.sandbox.public = true)],
    ["incompatible", "lifecycle_auto_stop", "autoStopInterval", (i) => (i.sandbox.autoStopInterval = 4)],
    ["incompatible", "lifecycle_auto_archive", "autoArchiveInterval", (i) => (i.sandbox.autoArchiveInterval = 59)],
    ["incompatible", "lifecycle_auto_delete", "autoDeleteInterval", (i) => (i.sandbox.autoDeleteInterval = 0)],
    ["incompatible", "lifecycle_auto_pause", "autoPauseInterval", (i) => (i.sandbox.autoPauseInterval = 1)],
    ["incompatible", "lifecycle_ttl", "autoDestroyAt", (i) => (i.sandbox.autoDestroyAt = "2030-01-01T00:00:00Z")],
    ["incompatible", "image_unqualified", "snapshot", (i) => (i.sandbox.snapshot = "another-snapshot")],
    ["incompatible", "target_unsupported", "target", (i) => (i.sandbox.target = "ap")],
    ["incompatible", "resources_out_of_policy", "resources", (i) => (i.sandbox.cpu = 5)],
    ["incompatible", "gpu_present", "gpu", (i) => (i.sandbox.gpu = 1)],
    ["incompatible", "volumes_present", "volumes", (i) => (i.sandbox.volumes = ["fixture-volume"])],
    ["incompatible", "warm_pool_member", "warmPoolId", (i) => (i.sandbox.warmPoolId = "fixture-pool")],
    ["incompatible", "linked_sandbox_present", "linkedSandboxId", (i) => (i.sandbox.linkedSandboxId = "fixture-linked")],
    ["incompatible", "platform_unsupported", "platform.os", (i) => (i.platform.os = "windows")],
    ["stopped", "sandbox_stopped", "state", (i) => (i.sandbox.state = "stopped")],
    ["stopped", "sandbox_stopped", "state", (i) => (i.sandbox.state = "archived")],
    ["unavailable", "sandbox_destroyed", "state", (i) => (i.sandbox.state = "destroyed")],
    ["unavailable", "sandbox_destroyed", "state", (i) => (i.sandbox.state = "destroying")],
    ["unavailable", "lifecycle_not_settled", "state", (i) => (i.sandbox.state = "starting")],
    ["unauthorized", "owner_mismatch", "binding.agentId", (i) => (i.binding.agentId = "fixture-agent-0002")],
    ["unauthorized", "binding_mismatch", "binding.sandboxId", (i) => (i.binding.sandboxId = "fixture-sandbox-0002")],
    ["reconciliation-required", "returned_id_mismatch", "sandbox.id", (i) => (i.sandbox.id = "fixture-sandbox-0002")],
    ["reconciliation-required", "binding_lifecycle_pending", "binding.lifecycle", (i) => (i.binding.lifecycle = "resizing")],
    ["reconciliation-required", "credential_boundary_unverified", "labels.credentialBoundaryVersion", (i) => delete i.sandbox.labels],
  ];
  for (const [status, code, field, edit] of faults) {
    const result = await withInspection(edit);
    assert.equal(result.status, status, code);
    assert.deepEqual(result.reasons, [{ code, field }], code);
  }
});

test("egress: an unreadable allow list is not also called unrestricted, and a block-all that is not a boolean restricts nothing", async () => {
  for (const value of [5, true, {}, ["fixture.invalid"]]) {
    const unreadable = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = false;
      sandbox.domainAllowList = value;
      delete sandbox.networkAllowList;
    });
    assert.deepEqual(unreadable.reasons, [
      { code: "metadata_missing", field: "domainAllowList" },
    ]);
  }
  for (const value of ["yes", "true", 1, {}]) {
    const notBoolean = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = value;
      sandbox.domainAllowList = null;
      sandbox.networkAllowList = null;
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

test("egress: an IPv4 range needs real dots and four octets no greater than 255", async () => {
  for (const entry of [
    "10x0.0.0/8",
    "10.0x0.0/8",
    "10.0.0x0/8",
    "10.0.256.0/24",
    "10.256.0.0/24",
    "256.0.0.0/24",
    "10.0.0.256/24",
  ]) {
    const result = await withSandbox((sandbox) => {
      sandbox.domainAllowList = null;
      sandbox.networkAllowList = entry;
    });
    assert.deepEqual(
      result.reasons,
      [{ code: "egress_allow_list_unsafe", field: "networkAllowList" }],
      entry
    );
  }
  const widest = await withSandbox((sandbox) => {
    sandbox.domainAllowList = null;
    sandbox.networkAllowList = "255.255.255.255/32,0.0.0.0/8";
  });
  assert.equal(widest.status, "ready");
});

test("sdk version echo: a leading zero in any part, or a separator that is not a dot, is unrecognised", async () => {
  for (const version of [
    "00.220.0",
    "0.0220.0",
    "0.220.00",
    "0x220.0",
    "0.220x0",
    "0-220-0",
  ]) {
    const result = await withInspection((inspection) => {
      inspection.sdk.version = version;
    });
    assert.equal(result.observed?.sdk.version, "unrecognised", version);
    assert.deepEqual(result.reasons, [
      { code: "sdk_generation_mismatch", field: "sdk" },
    ]);
  }
});

test("volumes: anything present that is not an empty array is an attachment, and the count is echoed", async () => {
  for (const value of [{}, { length: 0 }, "", "fixture-volume", 0, 1, false, true]) {
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
    sandbox.volumes = ["fixture-volume-a", "fixture-volume-b"];
  });
  assert.deepEqual(two.reasons, [{ code: "volumes_present", field: "volumes" }]);
  assert.equal(two.observed?.attachments.volumes, 2);

  const empty = await withSandbox((sandbox) => {
    sandbox.volumes = [];
  });
  assert.equal(empty.status, "ready");
  assert.equal(empty.observed?.attachments.volumes, 0);

  // Absent reads as none; an explicit null passes too but is echoed as
  // null, so the two stay distinguishable in output.
  const absent = await withSandbox((sandbox) => {
    delete sandbox.volumes;
  });
  assert.equal(absent.status, "ready");
  assert.equal(absent.observed?.attachments.volumes, 0);
  const stated = await withSandbox((sandbox) => {
    sandbox.volumes = null;
  });
  assert.equal(stated.status, "ready");
  assert.equal(stated.observed?.attachments.volumes, null);
});

test("observed attachments, TTL and exposure report what the seam stated, field by field", async () => {
  const attachments = async (edit: (sandbox: Record<string, unknown>) => void) =>
    (await withSandbox(edit)).observed?.attachments;
  assert.deepEqual(
    await attachments((sandbox) => {
      sandbox.linkedSandboxId = "fixture-linked";
    }),
    { linkedSandbox: true, volumes: 0, warmPool: false }
  );
  assert.deepEqual(
    await attachments((sandbox) => {
      sandbox.warmPoolId = "fixture-pool";
    }),
    { linkedSandbox: false, volumes: 0, warmPool: true }
  );
  // A present value of any type counts, an empty string and zero included.
  for (const value of ["", 0, false]) {
    assert.deepEqual(
      await attachments((sandbox) => {
        sandbox.linkedSandboxId = value;
        sandbox.warmPoolId = value;
      }),
      { linkedSandbox: true, volumes: 0, warmPool: true }
    );
  }
  for (const value of [undefined, null]) {
    const result = await withSandbox((sandbox) => {
      sandbox.linkedSandboxId = value;
      sandbox.warmPoolId = value;
      sandbox.autoDestroyAt = value;
    });
    assert.deepEqual(result.observed?.attachments, {
      linkedSandbox: false,
      volumes: 0,
      warmPool: false,
    });
    assert.equal(result.observed?.lifecycle.autoDestroyAt, "absent");
  }
  for (const value of ["2030-01-01T00:00:00Z", "", 0, false]) {
    const result = await withSandbox((sandbox) => {
      sandbox.autoDestroyAt = value;
    });
    assert.equal(result.observed?.lifecycle.autoDestroyAt, "present");
    assert.deepEqual(codes(result), ["lifecycle_ttl"]);
  }

  // `public` and `networkBlockAll` are separate readings.
  const blocked = await withSandbox((sandbox) => {
    sandbox.public = false;
    sandbox.networkBlockAll = true;
  });
  assert.deepEqual(blocked.observed?.exposure, {
    egressAllowListEntries: 1,
    networkBlockAll: true,
    public: false,
  });
  const exposed = await withSandbox((sandbox) => {
    sandbox.public = true;
    sandbox.networkBlockAll = false;
  });
  assert.deepEqual(exposed.observed?.exposure, {
    egressAllowListEntries: 1,
    networkBlockAll: false,
    public: true,
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

test("a credential-boundary marker on labels that are not a plain record is not a marker", async () => {
  for (const labels of [
    Object.assign([], { credentialBoundaryVersion: "attempt-reset-v1" }),
    "attempt-reset-v1",
    null,
  ]) {
    const result = await withInspection((inspection) => {
      inspection.sandbox.labels = labels;
    });
    assert.deepEqual(result.reasons, [
      {
        code: "credential_boundary_unverified",
        field: "labels.credentialBoundaryVersion",
      },
    ]);
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

// --- Open contract decision: four checks that pass on an absent key ---------
//
// Second read on #3 by rv3-d0dc225b, "Fail-open paths" item 2: a client that
// carries over only the upstream fields that fit leaves these four keys
// absent, and each check then passes. Whether an absent key should keep
// passing or be refused is a contract decision for the maintainer and the #2
// steward. It is not made here: each body states what the accepted contract
// does today, and `todo` marks the decision as outstanding. Whoever decides
// replaces the body with the decided outcome and removes the mark.

const ABSENT_KEY_DECISION =
  "contract decision outstanding (#3 second read rv3-d0dc225b, fail-open paths item 2)";

test(
  "todo: an absent autoDestroyAt passes the TTL check — keep, or refuse as missing metadata?",
  { todo: ABSENT_KEY_DECISION },
  async () => {
    const result = await withSandbox((sandbox) => {
      delete sandbox.autoDestroyAt;
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.observed?.lifecycle.autoDestroyAt, "absent");
  }
);

test(
  "todo: an absent warmPoolId passes the warm-pool check — keep, or refuse as missing metadata?",
  { todo: ABSENT_KEY_DECISION },
  async () => {
    const result = await withSandbox((sandbox) => {
      delete sandbox.warmPoolId;
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.observed?.attachments.warmPool, false);
  }
);

test(
  "todo: an absent linkedSandboxId passes the linked-sandbox check — keep, or refuse as missing metadata?",
  { todo: ABSENT_KEY_DECISION },
  async () => {
    const result = await withSandbox((sandbox) => {
      delete sandbox.linkedSandboxId;
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.observed?.attachments.linkedSandbox, false);
  }
);

test(
  "todo: absent allow lists are not examined, and block-all then skips the unrestricted-egress check — keep, or require the lists to be stated?",
  { todo: ABSENT_KEY_DECISION },
  async () => {
    const result = await withSandbox((sandbox) => {
      sandbox.networkBlockAll = true;
      delete sandbox.domainAllowList;
      delete sandbox.networkAllowList;
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.observed?.exposure.egressAllowListEntries, 0);
  }
);
