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
  createFixtureInspectionClient,
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
