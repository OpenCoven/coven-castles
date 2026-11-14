/** Synthetic qualification only. No real admission or provider evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runsAsProgram, smokeRefusal, type SmokeRefusal } from "../scripts/smoke.ts";
import { createFixtureInspectionClient, isLiveReady, loadFixtureCase, renderHuman, renderJson,
  runPreflight, type SandboxInspectionClient } from "../src/preflight.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(root, "fixtures/report-task");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
type ReportRule = { id: string; kind: string; value?: number | string[]; level?: number;
  pattern?: string; flags?: string; in?: string[]; sections?: string[] };
type Part = string | { repeat: string; times: number };
type Step = { append?: Part[]; replace?: [string, Part[]]; padToBytes?: number; with?: string; crlf?: true };
type Recipe = {id: string; base: string; steps: Step[]; expect: "accept" | "reject";
  mustFail?: string[]; knownLimit?: "false accept" | "false reject"};
const properties = readJson(resolve(fixtureRoot, "expected/report-properties.json")) as {
  schema: string; synthetic: boolean; parsing: {revision: number}; onReportText: ReportRule[];
  samples: {pass: string[]; fail: {path: string; mustFail: string[]}[]; generated: {cases: Recipe[]}};
};
const recipes = properties.samples.generated.cases;
const parts = (values: Part[]) => values.map(value => {
  if (typeof value === "string") return value;
  assert.ok(Number.isSafeInteger(value.times) && value.times >= 0 && value.times <= 100_000);
  return value.repeat.repeat(value.times);
}).join("");

function buildReport(recipe: Recipe): Buffer {
  assert.ok(properties.samples.pass.includes(recipe.base), "recipe must use a declared passing file");
  let text = readFileSync(resolve(fixtureRoot, recipe.base), "utf8");
  for (const step of recipe.steps) {
    assert.equal(["append", "replace", "padToBytes", "crlf"].filter(key => key in step).length, 1);
    if (step.append) text += parts(step.append);
    else if (step.replace) {
      const [find, replacement] = step.replace;
      const offset = text.indexOf(find);
      assert.ok(offset >= 0, `${recipe.id}: replacement target must exist`);
      // Slice rather than String.replace: recipe parts are literal, including $&.
      text = text.slice(0, offset) + parts(replacement) + text.slice(offset + find.length);
    } else if (step.padToBytes !== undefined) {
      assert.equal(Buffer.byteLength(step.with!), 1);
      const remaining = step.padToBytes - Buffer.byteLength(text);
      assert.ok(Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= 100_000);
      text += step.with!.repeat(remaining);
    } else if (step.crlf) text = text.replace(/\n/g, "\r\n");
    else assert.fail("unknown recipe operation");
    assert.ok(Buffer.byteLength(text) <= 200_000, "bounded recipe expansion");
  }
  return Buffer.from(text);
}

/** Test-only checker of the pinned synthetic report rules, never run evidence. */
function reportFailures(bytes: Uint8Array): string[] {
  let valid = !bytes.includes(0);
  try { new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { valid = false; }
  const normal = Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n");
  const visible = normal.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const lines = visible.split("\n");
  const headings: {level: number; title: string; line: number}[] = [];
  let fence: {char: string; length: number} | undefined;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const end = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (end && end[1][0] === fence.char && end[1].length >= fence.length) fence = undefined;
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (start) { fence = {char: start[1][0], length: start[1].length}; continue; }
    const heading = /^ {0,3}(#{1,6})[ \t]+([^\n]*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) headings.push({level: heading[1].length, title: heading[2], line: index});
  }
  const sections = new Map<string, string>();
  const levelTwo = headings.filter(heading => heading.level === 2);
  for (const [i, heading] of levelTwo.entries()) {
    if (!sections.has(heading.title))
      sections.set(heading.title, lines.slice(heading.line + 1, levelTwo[i + 1]?.line).join("\n"));
  }
  let finalLine = "";
  for (const line of lines) {
    const stripped = line.replace(/<[^>]*>/g, "").replace(/&#?[A-Za-z0-9]+;/g, "").replace(/\p{Cf}/gu, "");
    if (/[\p{L}\p{N}]/u.test(stripped)) finalLine = stripped;
  }
  return properties.onReportText.filter(rule => {
    const text = rule.in ? rule.in.map(section => (sections.get(section) ?? "").replace(/\s+/g, " ").trim()).join(" ") : normal;
    switch (rule.kind) {
      case "encoding": return !valid;
      case "maxBytes": return bytes.byteLength > (rule.value as number);
      case "minBytes": return bytes.byteLength < (rule.value as number);
      case "headingsInOrder": return JSON.stringify(headings.filter(heading => heading.level === rule.level).map(heading => heading.title)) !== JSON.stringify(rule.value);
      case "sectionMinChars": return rule.sections!.some(section =>
        [...(sections.get(section) ?? "").replace(/\s/g, "")].length < (rule.value as number));
      case "mustMatch": return !new RegExp(rule.pattern!, rule.flags).test(text);
      case "mustNotMatch": return new RegExp(rule.pattern!, rule.flags).test(text);
      case "finalLineMustNotMatch": return new RegExp(rule.pattern!, rule.flags).test(finalLine);
      default: throw new Error(`Unknown pinned property kind: ${rule.id}`);
    }
  }).map(rule => rule.id);
}

test("report corpus pins parsing revision, counts, and known limitations", () => {
  assert.equal(properties.synthetic, true);
  assert.equal(properties.parsing.revision, 3);
  assert.equal(properties.onReportText.length, 18);
  assert.equal(properties.samples.pass.length + properties.samples.fail.length, 9);
  assert.equal(recipes.length, 201);
  assert.equal(new Set(recipes.map(recipe => recipe.id)).size, 201);
  assert.equal(recipes.filter(recipe => recipe.knownLimit === "false accept").length, 40);
  assert.equal(recipes.filter(recipe => recipe.knownLimit === "false reject").length, 24);
});
for (const path of properties.samples.pass) test(`report file accept: ${path}`, () => {
  assert.deepEqual(reportFailures(readFileSync(resolve(fixtureRoot, path))), []);
});
for (const sample of properties.samples.fail) test(`report file reject: ${sample.path}`, () => {
  assert.deepEqual(reportFailures(readFileSync(resolve(fixtureRoot, sample.path))).sort(), [...sample.mustFail].sort());
});
for (const recipe of recipes) test(`report recipe ${recipe.id}${recipe.knownLimit ? ` (known ${recipe.knownLimit})` : ""}`, () => {
  const expected = recipe.expect === "accept" ? [] : recipe.mustFail;
  assert.ok(Array.isArray(expected), "a rejected recipe must declare its exact failure set");
  assert.deepEqual(reportFailures(buildReport(recipe)).sort(), [...expected].sort(), recipe.id);
});
test("report bytes reject malformed UTF-8, NUL, and too-short text", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82]), Buffer.from([0])])
    assert.ok(reportFailures(bytes).includes("RP-01"));
  assert.ok(reportFailures(Buffer.from("short")).includes("RP-03"));
});
test("report parser preserves byte limits and normalizes lone CR without changing meaning", () => {
  const pass = readFileSync(resolve(fixtureRoot, properties.samples.pass[0]), "utf8");
  assert.deepEqual(reportFailures(Buffer.from(pass.replace(/\n/g, "\r"))), []);
  const unicode = pass + "🦉".repeat(Math.ceil((8000 - Buffer.byteLength(pass)) / 4));
  assert.ok(unicode.length < 8000 && Buffer.byteLength(unicode) >= 8000);
  assert.ok(reportFailures(Buffer.from(unicode)).includes("RP-15"));
});

type InputFile = {path: string; bytes: Buffer; symlink?: boolean};
const manifest = readJson(resolve(fixtureRoot, "manifest.json"));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function inputFiles(directory: string, prefix = ""): InputFile[] {
  const directoryStat = lstatSync(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), "input root must be a real directory");
  return readdirSync(directory).sort().flatMap(name => {
    const path = prefix + name;
    const absolute = resolve(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return [{path, bytes: Buffer.alloc(0), symlink: true}];
    if (stat.isDirectory()) return inputFiles(absolute, path + "/");
    assert.ok(stat.isFile(), "fixture input has no special filesystem entries");
    return [{path, bytes: readFileSync(absolute)}];
  });
}
function auditInput(task: Buffer, files: InputFile[], hashes: string, taskHashText: string): void {
  const bounds = manifest.bounds.input;
  const validPath = (path: string) => {
    const match = new RegExp(bounds.allowedPathPattern).exec(path);
    assert.equal(match?.[0], path, "input path must be a full match");
    assert.ok(path.length <= bounds.maxPathLength && path.split("/").length <= bounds.maxDepth);
  };
  const checksums = (text: string) => {
    const result = new Map<string, string>();
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      assert.ok(match, "checksum line has SHA-256 and relative path");
      validPath(match[2]);
      assert.ok(!result.has(match[2]), "duplicate checksum path");
      result.set(match[2], match[1]);
    }
    return result;
  };
  const validText = (bytes: Buffer) => {
    assert.ok(!bytes.includes(0) && !bytes.includes(13), "UTF-8 text, LF only and no NUL");
    new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);
  };
  assert.ok(task.length <= manifest.bounds.task.maxBytes);
  validText(task);
  assert.deepEqual([...checksums(taskHashText)], [["task.md", sha(task)]]);
  assert.ok(files.length <= bounds.maxFiles);
  const expected = checksums(hashes);
  assert.equal(new Set(files.map(file => file.path)).size, files.length, "duplicate input path");
  assert.deepEqual(files.map(file => file.path).sort(), [...expected.keys()].sort(), "exact input inventory");
  let total = 0;
  for (const file of files) {
    validPath(file.path);
    assert.ok(!file.symlink, "symlinks are forbidden");
    assert.ok(file.bytes.length <= bounds.maxFileBytes);
    validText(file.bytes);
    assert.equal(sha(file.bytes), expected.get(file.path), "input hash must match");
    total += file.bytes.length;
  }
  assert.ok(total <= bounds.maxTotalBytes);
  assert.ok(total + task.length <= manifest.bounds.taskPlusInput.maxBytes);
}
const fixtureTask = readFileSync(resolve(fixtureRoot, "task.md"));
const fixtureFiles = inputFiles(resolve(fixtureRoot, "input"));
const inputHashes = readFileSync(resolve(fixtureRoot, "input.SHA256SUMS"), "utf8");
const taskHashes = readFileSync(resolve(fixtureRoot, "task.SHA256SUMS"), "utf8");
test("fixture manifest and exact task/input inventory conform to declared hashes and bounds", () => {
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.evidenceClass, "fixture");
  assert.equal(manifest.schema, "castles.fixture.report-task.v1");
  assert.equal(manifest.task.path, "task.md");
  assert.equal(manifest.input.root, "input");
  assert.equal(manifest.bounds.report.maxBytes, 7999);
  assert.equal(manifest.bounds.report.hardMaxBytes, 16384);
  assert.equal(manifest.bounds.runtime.maxSeconds, 900);
  auditInput(fixtureTask, fixtureFiles, inputHashes, taskHashes);
});
test("fixture audit detects changed bytes, added/missing files, symlinks and task drift", () => {
  const first = fixtureFiles[0];
  const remaining = fixtureFiles.slice(1);
  for (const files of [
    [{...first, bytes: Buffer.concat([first.bytes, Buffer.from("changed")])}, ...remaining],
    [...fixtureFiles, {path: "extra.txt", bytes: Buffer.from("extra")}],
    remaining,
    [{...first, symlink: true}, ...remaining],
    [first, first, ...remaining],
  ]) assert.throws(() => auditInput(fixtureTask, files, inputHashes, taskHashes));
  assert.throws(() => auditInput(Buffer.from("changed task"), fixtureFiles, inputHashes, taskHashes));
});
test("fixture filesystem inventory refuses a symlinked root and never reads a symlink target", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-input-"));
  try {
    writeFileSync(resolve(directory, "actual.txt"), "synthetic target\n");
    symlinkSync(resolve(directory, "actual.txt"), resolve(directory, "link.txt"));
    const link = inputFiles(directory).find(file => file.path === "link.txt");
    assert.equal(link?.symlink, true);
    assert.equal(link?.bytes.length, 0);
    symlinkSync(directory, resolve(directory, "root-link"));
    assert.throws(() => inputFiles(resolve(directory, "root-link")), "root symlink must be refused");
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test("OUT-01 OUT-02 fixture audit enforces full path matches, UTF-8 and every inclusive input bound", () => {
  const rehash = (files: InputFile[]) => files.map(file => `${sha(file.bytes)}  ${file.path}\n`).join("");
  const audit = (files: InputFile[], task = Buffer.from("task")) =>
    auditInput(task, files, rehash(files), `${sha(task)}  task.md\n`);
  const atLimit = [{path: "a/b/c.txt", bytes: Buffer.alloc(2048, "x")}];
  assert.doesNotThrow(() => audit(atLimit));
  for (const path of ["../escape", "/absolute", "a/../b", "a//b", "a\\b", "a\n", ".hidden", "a/b/c/d", "x".repeat(65)])
    assert.throws(() => audit([{path, bytes: Buffer.from("x")}]), "unsafe input path");
  assert.doesNotThrow(() => audit([{path: "x".repeat(64), bytes: Buffer.from("x")}]))
  assert.throws(() => audit([{path: "x", bytes: Buffer.alloc(2049, "x")}]));
  assert.throws(() => audit(Array.from({length: 9}, (_, i) => ({path: `x${i}`, bytes: Buffer.from("x")}))));
  assert.doesNotThrow(() => audit(Array.from({length: 8}, (_, i) => ({path: `x${i}`, bytes: Buffer.alloc(1024, "x")}))));
  assert.throws(() => audit(Array.from({length: 8}, (_, i) => ({path: `x${i}`, bytes: Buffer.alloc(1025, "x")}))));
  assert.doesNotThrow(() => audit(atLimit, Buffer.alloc(2048, "x")));
  assert.throws(() => audit(atLimit, Buffer.alloc(2049, "x")));
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.from("line\r\n")])
    assert.throws(() => audit([{path: "x", bytes}]));
  assert.throws(() => auditInput(fixtureTask, fixtureFiles, inputHashes + inputHashes, taskHashes));
});
const syntheticBinding = {
  CASTLES_PROFILE: "castles.daytona-private-linux.v1",
  CASTLES_SANDBOX_ID: "synthetic-sandbox-qualification",
  CASTLES_OWNER_AGENT_ID: "synthetic-owner-qualification",
  CASTLES_SANDBOX_GENERATION: "0",
};
const liveArgs = ["--live", "--sandbox-id", syntheticBinding.CASTLES_SANDBOX_ID,
  "--max-spend-usd", "0.01", "--max-seconds", "900"];

function smoke(args: string[], binding: Record<string, string> = syntheticBinding) {
  return smokeRun([process.execPath, "--import", "tsx", "scripts/smoke.ts", ...args], binding);
}
/** Runs one smoke invocation, given as a full command line, and requires the refusal contract. */
function smokeRun(command: string[], binding: Record<string, string> = syntheticBinding, cwd = root) {
  const child = spawnSync(command[0], command.slice(1), {
    cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
    env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...binding },
  });
  assert.equal(child.error, undefined, "smoke subprocess must finish before its deadline");
  assert.equal(child.signal, null);
  assert.equal(child.status, 1, "every current smoke invocation must refuse");
  assert.equal(child.stderr, "");
  const result: SmokeRefusal = JSON.parse(child.stdout);
  assert.equal(result.schema, "castles.smoke-refusal.v1");
  assert.equal(result.status, "blocked");
  assert.equal(result.evidence, "none");
  assert.equal(result.providerCalls, 0);
  assert.ok(Buffer.byteLength(child.stdout) < 1_024);
  assert.ok(!child.stdout.includes(syntheticBinding.CASTLES_SANDBOX_ID));
  assert.ok(!child.stdout.includes(syntheticBinding.CASTLES_OWNER_AGENT_ID));
  return result;
}

test("CFG-03 smoke without explicit opt-in refuses", () => {
  assert.equal(smoke([]).reason, "explicit_opt_in_required");
});
test("B1 smoke refuses however it is invoked as the program", () => {
  // Second reads rv5-aa741628 and rv5b-7a31c9e4, B1: at df7597b every spelling
  // but the exact relative path exited 0 with no output.
  const tsxBin = resolve(root, "node_modules/.bin/tsx");
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-entry-"));
  try {
    symlinkSync(resolve(root, "scripts/smoke.ts"), resolve(directory, "link.ts"));
    symlinkSync(resolve(root, "scripts/smoke.ts"), resolve(directory, "smoke-link"));
    symlinkSync(resolve(root, "scripts"), resolve(directory, "aliased-scripts"));
    const node = [process.execPath, "--import", "tsx"];
    const spellings: [string, string[]][] = [
      ["exact relative path", [...node, "scripts/smoke.ts"]],
      ["no extension", [...node, "scripts/smoke"]],
      ["dot segments", [...node, "./scripts/../scripts/smoke.ts"]],
      ["absolute path", [...node, resolve(root, "scripts/smoke.ts")]],
      ["the tsx binary, no extension", [tsxBin, "scripts/smoke"]],
      ["the tsx binary", [tsxBin, "scripts/smoke.ts"]],
      ["a symlink to the script", [...node, resolve(directory, "link.ts")]],
      ["an extensionless symlink", [...node, resolve(directory, "smoke-link")]],
      ["a path through a symlinked directory", [...node, resolve(directory, "aliased-scripts/smoke.ts")]],
    ];
    for (const [label, command] of spellings) {
      assert.equal(smokeRun(command).reason, "explicit_opt_in_required", label);
      assert.equal(smokeRun([...command, ...liveArgs]).reason, "canonical_capabilities_unavailable", `${label}, --live`);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test("B1 only Node's explicit false skips the refusal, so a Node without import.meta.main fails closed", () => {
  assert.equal(runsAsProgram(false), false);
  for (const main of [true, undefined, null, 0, "", "false", {}]) assert.equal(runsAsProgram(main), true, String(main));
});
test("B1 importing the smoke module is side-effect free", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    "const m = await import('./scripts/smoke.ts'); process.stdout.write(typeof m.smokeRefusal);"], {
    cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
    env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...syntheticBinding},
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "function");
  assert.equal(child.stderr, "");
});
test("CFG-04 smoke rejects missing and malformed budgets", () => {
  assert.equal(smoke(["--live"]).reason, "budget_required");
  for (const value of ["0", "-1", "NaN", "Infinity", "1e3", " 1"])
    assert.equal(smoke(["--live", `--max-spend-usd=${value}`, "--max-seconds", "900"]).reason, "budget_invalid");
  for (const value of ["0", "-1", "901", "1.5", "NaN", "Infinity", "0900"])
    assert.equal(smoke(["--live", "--max-spend-usd", "0.01", `--max-seconds=${value}`]).reason, "budget_invalid");
});
test("CFG-05 smoke refuses a missing or different exact target", () => {
  assert.equal(smoke(liveArgs.filter((_, i) => i !== 1 && i !== 2)).reason, "exact_target_required");
  assert.equal(smoke(liveArgs.map(v => v === syntheticBinding.CASTLES_SANDBOX_ID ? "synthetic-other" : v)).reason, "target_mismatch");
});
test("CFG-06 smoke never accepts fixture or mock flags", () => {
  for (const args of [["--fixture", "ready.json"], ["--mock"], ["--json"], ["run"], ["--live=true"],
    [...liveArgs, "--live"], [...liveArgs, "--max-seconds", "1"], [...liveArgs, "--reset"], [...liveArgs, "--ignore-cleanup"]])
    assert.equal(smoke(args).reason, "unsupported_arguments");
});
test("CFG-08 complete-looking inputs and forged authorization still refuse", () => {
  assert.equal(smoke(liveArgs).reason, "canonical_capabilities_unavailable");
  assert.equal(smoke(liveArgs, {...syntheticBinding, CASTLES_AUTHORIZED: "true", CASTLES_MODE: "fixture"}).reason,
    "canonical_capabilities_unavailable");
  assert.equal(smoke(liveArgs, {}).reason, "binding_invalid");
});

test("CFG-07 smoke consumes only binding keys and never echoes credential canaries", () => {
  const read: string[] = [];
  const environment = new Proxy(syntheticBinding, {get(target, key: string) {
    assert.ok(Object.hasOwn(target, key), "no credential or unrelated environment read");
    read.push(key);
    return target[key as keyof typeof syntheticBinding];
  }});
  const result = smokeRefusal(liveArgs, environment);
  assert.equal(result.reason, "canonical_capabilities_unavailable");
  assert.ok(read.length > 0);
  const canary = `synthetic-canary-${randomBytes(16).toString("hex")}`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/smoke.ts", ...liveArgs], {
    cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
    env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...syntheticBinding,
      DAYTONA_API_KEY: canary, DATABASE_URL: canary, OPENAI_API_KEY: canary},
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reason, "canonical_capabilities_unavailable");
  assert.ok(!(child.stdout + child.stderr).includes(canary));
});
test("CFG-10 smoke refuses arbitrary directory arguments and preserves existing files", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-smoke-"));
  try {
    writeFileSync(resolve(directory, "existing.txt"), "synthetic existing data\n");
    const before = inputFiles(directory);
    assert.equal(smoke([...liveArgs, "--test-directory", directory]).reason, "unsupported_arguments");
    assert.deepEqual(inputFiles(directory), before);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

const preflightFixtures: [string, string][] = [
  ["CFG-01", "missing-id"], ["CFG-02", "unknown-profile"],
  ["BND-01", "wrong-owner"], ["BND-02", "wrong-generation"],
  ["BND-03", "mismatched-returned-id"], ["BND-04", "missing-sandbox"],
  ["BND-05", "ambiguous-lookup"], ["BND-05", "binding-mismatch"],
  ["BND-06", "public-exposure"], ["BND-06", "unsafe-lifecycle"],
  ["BND-06", "metadata-missing"], ["BND-06", "unrestricted-egress"],
  ["BND-06", "allow-all-egress"], ["BND-07", "stopped"],
  ["BND-08", "unresolved-attempt"], ["BND-09", "unavailable-provider"],
];
for (const [id, name] of preflightFixtures) test(`${id} accepted preflight: ${name}`, async () => {
  const fixture = loadFixtureCase(resolve(root, `fixtures/preflight/cases/${name}.json`));
  const calls: string[] = [];
  const client = new Proxy({inspectBoundSandbox: async (request: unknown) => {
    calls.push("inspect");
    assert.deepEqual(request, {agentId: fixture.env.CASTLES_OWNER_AGENT_ID,
      sandboxId: fixture.env.CASTLES_SANDBOX_ID, expectedGeneration: Number(fixture.env.CASTLES_SANDBOX_GENERATION)});
    return fixture.inspection;
  }}, {get(target, key) {
    if (key !== "inspectBoundSandbox") { calls.push("forbidden"); throw new Error("synthetic forbidden capability"); }
    return target.inspectBoundSandbox;
  }});
  const result = await runPreflight(fixture.env, client);
  assert.equal(result.status, fixture.expect.status);
  assert.deepEqual(result.reasons.map(reason => reason.code), fixture.expect.reasons);
  assert.deepEqual(calls, Array(fixture.expect.inspectCalls).fill("inspect"));
  assert.equal(isLiveReady(result), false);
  assert.equal(result.evidence, "fixture");
});
test("ADM-11 readiness: fixture and null client never authorize a live run", async () => {
  const fixture = loadFixtureCase(resolve(root, "fixtures/preflight/cases/ready.json"));
  const client = Object.assign(createFixtureInspectionClient(fixture), {evidence: "live-provider", live: true});
  const result = await runPreflight(fixture.env, client);
  assert.equal(result.status, "ready");
  assert.equal(result.evidence, "fixture");
  assert.equal(isLiveReady(result), false);
  const absent = await runPreflight(fixture.env, null);
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.evidence, "none");
  assert.equal(absent.providerCalls.inspect, 0);
  assert.ok(absent.reasons.some(reason => reason.code === "upstream_seam_missing"));
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "check", "--json", "--fixture",
    "fixtures/preflight/cases/ready.json"], {cwd: root, encoding: "utf8", timeout: 5_000,
    maxBuffer: 32_768, env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1"}});
  assert.equal(child.error, undefined);
  assert.equal(child.status, 3);
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).evidence, "fixture");
});
test("BND-09 RED-02 RED-03 preflight errors, timeouts and hostile metadata stay bounded and redacted", async () => {
  const fixture = loadFixtureCase(resolve(root, "fixtures/preflight/cases/ready.json"));
  const canary = `synthetic-error-${randomBytes(16).toString("hex")}`;
  for (const inspect of [async () => {throw new Error(canary);}, async () => new Promise(() => {}),
    async () => ({unexpected: canary.repeat(10_000)})]) {
    const result = await runPreflight(fixture.env, {inspectBoundSandbox: inspect} as SandboxInspectionClient, {timeoutMs: 20});
    assert.equal(result.status, "unavailable");
    assert.equal(result.providerCalls.inspect, 1);
    assert.equal(result.observed, null);
    const output = renderJson(result) + renderHuman(result);
    assert.ok(!output.includes(canary));
    assert.ok(!output.includes(fixture.env.CASTLES_SANDBOX_ID));
    assert.ok(!output.includes(fixture.env.CASTLES_OWNER_AGENT_ID));
    assert.ok(Buffer.byteLength(renderJson(result)) <= 16_384);
  }
});

test("catalogue coverage maps every case to executable evidence or a precise dependency", () => {
  const catalogue = readJson(resolve(fixtureRoot, "negative-cases.json"));
  assert.equal(catalogue.synthetic, true);
  assert.equal(catalogue.cases.length, 76);
  const notes = readFileSync(resolve(root, "docs/acceptance.md"), "utf8");
  const table = notes.split("## Catalogue coverage\n")[1]?.split("\n## ")[0];
  assert.ok(table, "acceptance notes must contain the executable/dependency map");
  const rows = table.split("\n").filter(line => /^\| (?:CFG|BND|ADM|BST|OUT|REC|CAN|RED|REU)-\d\d \|/.test(line));
  const ids = rows.map(line => line.split("|")[1].trim());
  assert.deepEqual(ids.sort(), catalogue.cases.map((entry: {id: string}) => entry.id).sort());
  for (const row of rows) {
    const [, id, evidence, remaining] = row.split("|");
    assert.ok(evidence.trim().length > 10 && remaining.trim().length > 10, `${id.trim()}: explicit coverage and limits`);
  }
});
