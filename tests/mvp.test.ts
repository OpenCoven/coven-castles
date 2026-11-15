/** Synthetic qualification only. No real admission or provider evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, lstatSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import nodeTest, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runsAsProgram, smokeRefusal, type SmokeRefusal } from "../scripts/smoke.ts";
import { createFixtureInspectionClient, isLiveReady, loadFixtureCase, renderHuman, renderJson,
  runPreflight, type SandboxInspectionClient } from "../src/preflight.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Every title registered in this file, so docs/acceptance.md can cite only tests that exist (review N3). */
const titles: string[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  titles.push(name);
  return nodeTest(name, fn);
}
/**
 * scripts/smoke.ts is also imported into this process: smokeRefusal is called
 * directly. A planted process.exit(0) there ends this file early with exit
 * code 0, and the runner then reports only the tests it saw, as a pass. That
 * is how edit S6 of rv5b-7a31c9e4 escaped once smokeRefusal ran here with a
 * large budget. Any exit before the last test has finished fails the file.
 */
function guardEarlyExit(registerAfter: (fn: () => void) => void) {
  let finished = false;
  registerAfter(() => { finished = true; });
  process.on("exit", code => {
    if (finished || code !== 0) return;
    process.stderr.write("the test process exited before its tests finished\n");
    process.exitCode = 1;
  });
}
guardEarlyExit(after);
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
/**
 * N2 of rv5b-7a31c9e4: the grader claims parsing revision 3, but 12 of 23
 * single edits to it passed. Each case below is pass.md with one change whose
 * exact failure set follows from the `parsing` text of report-properties.json.
 */
const passText = readFileSync(resolve(fixtureRoot, "expected/samples/pass.md"), "utf8");
const failures = (text: string) => reportFailures(Buffer.from(text)).sort();
const summaryEndsWith = (lines: string) => {
  assert.ok(passText.includes("\n\n## Findings\n"));
  return passText.replace("\n\n## Findings\n", `\n${lines}\n\n## Findings\n`);
};
test("N2 grader: a fence closes only on the same character, at least as long, with nothing after it", () => {
  assert.deepEqual(failures(summaryEndsWith("```\ncode\n````")), [], "a longer closing run closes");
  assert.deepEqual(failures(summaryEndsWith("```\n~~~\n## Inside\n```")), [], "the other character does not close");
  assert.deepEqual(failures(summaryEndsWith("```\n``` trailing\n## Inside\n```")), [], "text after the run does not close");
});
test("N2 grader: fences and headings open with at most three spaces of indent", () => {
  assert.deepEqual(failures(summaryEndsWith("    ## Indented")), [], "four spaces: not a heading");
  assert.deepEqual(failures(summaryEndsWith("   ## Three")), ["RP-04"], "three spaces: a heading");
  assert.deepEqual(failures(summaryEndsWith("    ```")), [], "four spaces: not a fence");
});
test("N2 grader: a repeated title uses its first section, and only level-2 headings cut sections", () => {
  assert.deepEqual(failures(`${passText}\n## Findings\n\nNothing to see here at all.\n`), ["RP-04"]);
  assert.ok(passText.includes("## Findings\n\n"));
  assert.deepEqual(failures(passText.replace("## Findings\n\n", "## Findings\n\n### Detail\n\n")), []);
});
test("N2 grader: section length counts code points, flat text collapses whitespace, 'in' sections join with a space", () => {
  const limitations = passText.slice(passText.indexOf("## Limitations\n"));
  assert.deepEqual(failures(passText.replace(limitations, "## Limitations\n\n" + "🦉".repeat(6) + "\n")), ["RP-16"],
    "six astral characters are 12 UTF-16 units but 6 characters");
  assert.deepEqual(failures(passText.replace(limitations, "## Limitations\n\n" + "🦉".repeat(12) + "\n")), []);
  const findings = passText.slice(passText.indexOf("## Findings\n"), passText.indexOf("## Evidence\n"));
  const wrapped = "## Findings\n\nThe defect is in `src/tide.mjs`, function `highWaterIndex`. The loop is off by\none, so 14:00, 4.31 m is missed.\n\n";
  assert.deepEqual(failures(passText.replace(findings, wrapped)), [], "RP-07 sees \"off by one\" across the line wrap");
  const joined = summaryEndsWith("There is no defect").replace("## Findings\n\n", "## Findings\n\nin the code. ");
  assert.deepEqual(failures(joined), ["RP-17"], "Summary and Findings are joined by one space");
});
test("N2 grader: RP-03 accepts exactly 200 bytes, and rules without 'in' read comments too", () => {
  assert.ok(!reportFailures(Buffer.alloc(200, "a")).includes("RP-03"));
  assert.ok(reportFailures(Buffer.alloc(199, "a")).includes("RP-03"));
  const marker = "-----BEGIN " + "PRIVATE KEY-----";
  assert.deepEqual(failures(`${passText}\n<!-- ${marker} -->\n`), ["RP-11"]);
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
/**
 * N1 and N4 of rv5b-7a31c9e4, N1 of rv5-aa741628. The checksum files prove
 * only that the inputs agree with them: an input changed together with its
 * line in input.SHA256SUMS passed, and so did an empty directory, an
 * executable bit, an unlisted sample, a deleted rule block and moved
 * known-limit labels. This pins every entry of fixtures/report-task (type,
 * path, executable bit, SHA-256) to the corpus merged at
 * 302bb4533aaccde8165d8efe596502da286891b0, so any fixture change must change
 * this digest in the same reviewed commit.
 */
const REPORT_TASK_TREE = "6ab2be1f0c4e5945740c2c816c99c74e66343acdeb7fd9a75bf22cee508e8e1d";
function treeEntries(directory: string, prefix = ""): string[] {
  return readdirSync(directory).sort().flatMap(name => {
    const path = prefix + name;
    const absolute = resolve(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return [`link ${path}`];
    if (stat.isDirectory()) return [`dir ${path}`, ...treeEntries(absolute, path + "/")];
    return [`file ${path} ${stat.mode & 0o111 ? "x" : "-"} ${sha(readFileSync(absolute))}`];
  });
}
test("N1 N4 fixtures/report-task is entry for entry the corpus merged at 302bb45", () => {
  const entries = treeEntries(fixtureRoot);
  assert.equal(entries.length, 28);
  assert.equal(sha(Buffer.from(entries.join("\n"))), REPORT_TASK_TREE);
});
test("N4 inventory: no empty directory or executable input, exactly the declared samples, all six run-evidence rules", () => {
  const walk = (directory: string): void => {
    const names = readdirSync(directory);
    assert.ok(names.length > 0, "an empty directory is outside the checksum inventory");
    for (const name of names) {
      const stat = lstatSync(resolve(directory, name));
      if (stat.isDirectory()) walk(resolve(directory, name));
      else assert.equal(stat.mode & 0o111, 0, `${name}: input files are data, never executable`);
    }
  };
  walk(resolve(fixtureRoot, "input"));
  const declared = [...properties.samples.pass, ...properties.samples.fail.map(sample => sample.path)];
  assert.deepEqual(readdirSync(resolve(fixtureRoot, "expected/samples")).map(name => `expected/samples/${name}`).sort(),
    [...declared].sort());
  const evidence = (properties as unknown as {onRunEvidence: {items: {id: string}[]}}).onRunEvidence;
  assert.deepEqual(evidence.items.map(item => item.id), ["RE-01", "RE-02", "RE-03", "RE-04", "RE-05", "RE-06"]);
});
test("N1 every known-limit label agrees with its recipe's expectation", () => {
  for (const recipe of recipes) {
    if (recipe.knownLimit === "false accept") assert.equal(recipe.expect, "accept", recipe.id);
    else if (recipe.knownLimit === "false reject") assert.equal(recipe.expect, "reject", recipe.id);
    else assert.equal(recipe.knownLimit, undefined, recipe.id);
  }
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
test("OUT-02 OUT-03 the catalogue's own examples: its refused paths are refused, its shell-character content is audited as bytes (review N9)", () => {
  const catalogue = readJson(resolve(fixtureRoot, "negative-cases.json")) as
    {cases: {id: string, examples?: {refusedPaths?: string[], stagedPaths?: string[], content?: string}}[]};
  const example = (id: string) => catalogue.cases.find(entry => entry.id === id)?.examples;
  const audit = (files: InputFile[]) => auditInput(fixtureTask, files,
    files.map(file => `${sha(file.bytes)}  ${file.path}\n`).join(""), taskHashes);
  const refused = example("OUT-02")?.refusedPaths ?? [];
  assert.deepEqual(refused, ["a;b.txt", "$x.txt", "a b.txt", "notes/../x.txt", "/abs.txt", ".hidden"]);
  for (const path of refused)
    assert.throws(() => audit([...fixtureFiles, {path, bytes: Buffer.from("synthetic\n")}]), path);
  const staged = example("OUT-03");
  assert.deepEqual(staged?.stagedPaths, ["notes/shell-chars.txt"]);
  const content = Buffer.from(staged?.content ?? "");
  assert.ok(/[;$`|&>*]/.test(content.toString()) && content.includes("castles-injection-marker.txt"));
  // The fixture audit is the only consumer here: it accepts the file and hashes the bytes it was given.
  // Staging and launch are #3; this pins that the audit needs no escaping and runs nothing.
  const before = readdirSync(root).sort();
  const files = [...fixtureFiles, {path: "notes/shell-chars.txt", bytes: Buffer.from(content)}];
  assert.doesNotThrow(() => audit(files));
  assert.ok(files.at(-1)?.bytes.equals(content));
  assert.deepEqual(readdirSync(root).sort(), before);
});
const syntheticBinding = {
  CASTLES_PROFILE: "castles.daytona-private-linux.v1",
  CASTLES_SANDBOX_ID: "synthetic-sandbox-qualification",
  CASTLES_OWNER_AGENT_ID: "synthetic-owner-qualification",
  CASTLES_SANDBOX_GENERATION: "0",
};
const liveArgs = ["--live", "--sandbox-id", syntheticBinding.CASTLES_SANDBOX_ID,
  "--max-spend-usd", "0.01", "--max-seconds", "900"];

/**
 * B2: a preload for every smoke subprocess. It reports on stderr, and refuses,
 * any effect started from a file under scripts/: a file read or write, a
 * child process, a socket, DNS, HTTP, fetch, a worker, an env-file load, a
 * process exit or signal, and any environment read other than the four
 * binding keys. Effects of the loader and of Node itself pass. Every smoke
 * run requires empty stderr, so any report fails the test. It does not rely
 * on the script's own providerCalls literal.
 */
const TRIPWIRE_SOURCE = String.raw`
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dns from "node:dns";
import dnsp from "node:dns/promises";
import dgram from "node:dgram";
import workers from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

const write = process.stderr.write.bind(process.stderr);
const fromScript = () => /[\\/]scripts[\\/][^\\/()]+\.[cm]?[jt]s:\d+:\d+/.test(new Error().stack ?? "");
const tripped = (what) => {
  if (!fromScript()) return false;
  write("TRIPWIRE " + what + "\n");
  return true;
};
const refuse = () => { throw new Error("synthetic tripwire: effect refused"); };
const modules = [[fs, "fs"], [fsp, "fs.promises"], [cp, "child_process"], [net, "net"], [tls, "tls"],
  [http, "http"], [https, "https"], [http2, "http2"], [dns, "dns"], [dnsp, "dns.promises"],
  [dgram, "dgram"], [workers, "worker_threads"]];
for (const [target, label] of modules) {
  for (const name of Object.keys(target)) {
    const original = target[name];
    if (typeof original !== "function" || !/^[a-z]/.test(name)) continue;
    target[name] = function (...args) {
      if (tripped(label + "." + name)) refuse();
      return original.apply(this, args);
    };
  }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (tripped("net.Socket.connect")) refuse();
  return connect.apply(this, args);
};
for (const name of ["fetch", "WebSocket", "EventSource"]) {
  const original = globalThis[name];
  if (typeof original !== "function") continue;
  globalThis[name] = new Proxy(original, {
    apply(target, self, args) { if (tripped(name)) refuse(); return Reflect.apply(target, self, args); },
    construct(target, args, next) { if (tripped(name)) refuse(); return Reflect.construct(target, args, next); },
  });
}
for (const name of ["loadEnvFile", "exit", "kill", "chdir", "dlopen", "binding", "abort", "getBuiltinModule"]) {
  const original = process[name];
  if (typeof original !== "function") continue;
  process[name] = function (...args) {
    if (tripped("process." + name)) refuse();
    return original.apply(this, args);
  };
}
const binding = new Set(["CASTLES_PROFILE", "CASTLES_SANDBOX_ID", "CASTLES_OWNER_AGENT_ID", "CASTLES_SANDBOX_GENERATION"]);
const named = (key) => typeof key === "string" && !binding.has(key);
process.env = new Proxy(process.env, {
  get(target, key) { if (named(key)) tripped("env read " + key); return Reflect.get(target, key); },
  has(target, key) { if (named(key)) tripped("env probe " + key); return Reflect.has(target, key); },
  ownKeys(target) { tripped("env enumeration"); return Reflect.ownKeys(target); },
  set(target, key, value) { if (tripped("env write " + String(key))) refuse(); return Reflect.set(target, key, value); },
  deleteProperty(target, key) { if (tripped("env delete " + String(key))) refuse(); return Reflect.deleteProperty(target, key); },
});
syncBuiltinESMExports();
`;
const tripwireDirectory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-tripwire-"));
const tripwire = resolve(tripwireDirectory, "tripwire.mjs");
writeFileSync(tripwire, TRIPWIRE_SOURCE);
after(() => rmSync(tripwireDirectory, {recursive: true, force: true}));
// Absolute, so a smoke run can start in any working directory.
const guarded = ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(tripwire).href];

function smoke(args: string[], binding: Record<string, string> = syntheticBinding) {
  return smokeRun([process.execPath, ...guarded, "scripts/smoke.ts", ...args], binding);
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
test("R1 import-time exits cannot pass an MVP file that never reaches its tests", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-import-exit-"));
  try {
    for (const name of ["scripts", "src", "tests", "fixtures", "docs"])
      cpSync(resolve(root, name), resolve(directory, name), {recursive: true});
    cpSync(resolve(root, "package.json"), resolve(directory, "package.json"));
    symlinkSync(resolve(root, "node_modules"), resolve(directory, "node_modules"));
    const source = readFileSync(resolve(directory, "scripts/smoke.ts"), "utf8");
    for (const effect of ["process.exit(0);", "process.reallyExit(0);",
      'const p = process; p["stdout"]["write"](JSON.stringify({status:"re"+"ady"})+"\\n"); p["exit"](0);']) {
      writeFileSync(resolve(directory, "scripts/smoke.ts"), effect + "\n" + source);
      const child = spawnSync(process.execPath, ["--import", "tsx", "--test",
        "--test-name-pattern=^CFG-03 smoke without explicit opt-in refuses$", "tests/mvp.test.ts"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536,
        env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1"},
      });
      assert.equal(child.error, undefined, effect);
      assert.equal(child.status, 1, effect + ": an incomplete MVP file must fail");
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
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
test("CFG-04 smoke spend is at most six integer digits and two fractional digits (review N5)", () => {
  const spend = (value: string) => smokeRefusal(["--live", "--sandbox-id", syntheticBinding.CASTLES_SANDBOX_ID,
    `--max-spend-usd=${value}`, "--max-seconds", "900"], syntheticBinding).reason;
  for (const value of ["999999.99", "999999", "0.01", "1.5", "10"])
    assert.equal(spend(value), "canonical_capabilities_unavailable", value);
  for (const value of ["1000000", "9999999.99", "0.001", "1.234", "01", "1.", ".5", "+1", "1_000", "0.00"])
    assert.equal(spend(value), "budget_invalid", value);
});
test("CFG-05 smoke compares the target exactly and never echoes it (review N5)", () => {
  const other = `synthetic-other-${randomBytes(8).toString("hex")}`;
  const keys = ["evidence", "providerCalls", "reason", "schema", "status"];
  for (const target of [other, syntheticBinding.CASTLES_SANDBOX_ID.toUpperCase(), `${syntheticBinding.CASTLES_SANDBOX_ID} `]) {
    const args = liveArgs.map(value => value === syntheticBinding.CASTLES_SANDBOX_ID ? target : value);
    const result = smokeRefusal(args, syntheticBinding);
    assert.equal(result.reason, "target_mismatch", target);
    assert.deepEqual(Object.keys(result).sort(), keys);
    const child = smoke(args);
    assert.equal(child.reason, "target_mismatch", target);
    assert.deepEqual(Object.keys(child).sort(), keys);
  }
  // The given target never reaches output, mismatched or not.
  const child = spawnSync(process.execPath, [...guarded, "scripts/smoke.ts",
    ...liveArgs.map(value => value === syntheticBinding.CASTLES_SANDBOX_ID ? other : value)], {
    cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
    env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...syntheticBinding},
  });
  assert.equal(child.status, 1);
  assert.ok(!(child.stdout + child.stderr).includes(other));
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
  const child = spawnSync(process.execPath, [...guarded, "scripts/smoke.ts", ...liveArgs], {
    cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
    env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...syntheticBinding,
      DAYTONA_API_KEY: canary, DATABASE_URL: canary, OPENAI_API_KEY: canary},
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reason, "canonical_capabilities_unavailable");
  assert.ok(!(child.stdout + child.stderr).includes(canary));
  assert.equal(child.stderr, "");
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

/**
 * B2: what a file under scripts/ may use. Imports from this list only; no
 * dynamic import, network global, reflection, process control, env-file name
 * or second output channel; one environment read, of the binding keys; one
 * output; exit code 1. A script that needs more changes this test on purpose.
 */
const SCRIPT_IMPORTS = new Set(["node:util", "../src/profile.ts"]);
function scriptProblems(source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g))
    if (!SCRIPT_IMPORTS.has(match[1])) problems.push("import " + match[1]);
  const forbidden: [string, RegExp][] = [
    ["dynamic import or require", /\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b/],
    ["network global", /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest)\b/],
    ["reflection", /\b(?:globalThis|Function|eval|Reflect|Proxy)\b/],
    ["process control or env-file load", /\bprocess\s*\.\s*(?:binding|dlopen|loadEnvFile|exit(?!Code)|kill|chdir|abort|getBuiltinModule)\b/],
    ["env-file name", /["'`][^"'`\n]*\.env\b[^"'`\n]*["'`]/],
    ["second output channel", /\bprocess\s*\.\s*stderr\b|\bconsole\s*\./],
    ["success state", /["'`][^"'`\n]*\bready\b/i],
  ];
  for (const [label, pattern] of forbidden) if (pattern.test(source)) problems.push(label);
  if ((source.match(/\bprocess\s*\.\s*env\b/g) ?? []).length !== 1 ||
      !source.includes("for (const key of BINDING_ENVIRONMENT_KEYS) environment[key] = process.env[key];"))
    problems.push("environment read beyond the binding keys");
  const exitCodes = [...source.matchAll(/\bprocess\s*\.\s*exitCode\s*=\s*([^;\n]+)/g)].map(match => match[1].trim());
  if (exitCodes.length !== 1 || exitCodes[0] !== "1") problems.push("exit code other than 1");
  if ((source.match(/\bprocess\s*\.\s*stdout\s*\.\s*write\b/g) ?? []).length !== 1) problems.push("more than one output");
  return problems;
}
function scriptFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
    ? scriptFiles(resolve(directory, entry.name), prefix + entry.name + "/") : [prefix + entry.name]);
}
const smokeSource = () => readFileSync(resolve(root, "scripts/smoke.ts"), "utf8");
const MAIN_LINE = "  process.stdout.write(`${JSON.stringify(smokeRefusal(process.argv.slice(2), environment))}\\n`);";
const UTIL_IMPORT = 'import { parseArgs } from "node:util";';
/** Edits S1 to S6 of the second read by rv5b-7a31c9e4 (issuecomment-6849185944), anchored on this script. */
const PLANTED: [string, [string, string][]][] = [
  ["S1 credential variable read", [["  const parsed = parseBinding(environment);",
    "  const credential = process.env.DAYTONA_API_KEY ?? process.env.DATABASE_URL; void credential;\n  const parsed = parseBinding(environment);"]]],
  ["S2 env-file load", [["  const environment: Record<string, string | undefined> = {};",
    "  try { process.loadEnvFile(\".env.local\"); } catch {}\n  const environment: Record<string, string | undefined> = {};"]]],
  ["S3 network call", [[MAIN_LINE, "  await fetch(\"http://127.0.0.1:9/synthetic-provider\", {headers: {authorization: `Bearer ${process.env.DAYTONA_API_KEY}`}}).catch(() => {});\n" + MAIN_LINE]]],
  ["S4 file write", [[UTIL_IMPORT, UTIL_IMPORT + "\nimport { appendFileSync } from \"node:fs\";"],
    [MAIN_LINE, "  appendFileSync(\"synthetic-smoke-wrote-this.log\", \"x\\n\");\n" + MAIN_LINE]]],
  ["S5 child process", [[UTIL_IMPORT, UTIL_IMPORT + "\nimport { spawnSync } from \"node:child_process\";"],
    [MAIN_LINE, "  spawnSync(process.execPath, [\"-e\", \"0\"]);\n" + MAIN_LINE]]],
  ["S6 success branch", [["  return refuse(\"canonical_capabilities_unavailable\");",
    "  if (Number(dollars) >= 1) { process.stdout.write(\"{\\\"status\\\":\\\"ready\\\"}\\n\"); process.exit(0); }\n  return refuse(\"canonical_capabilities_unavailable\");"]]],
];
const plant = (source: string, edits: [string, string][]) => edits.reduce((text, [find, to]) => {
  assert.ok(text.includes(find), "planted edit anchor must exist: " + find.slice(0, 40));
  return text.replace(find, () => to);
}, source);
const largestBudget = ["--live", "--sandbox-id", syntheticBinding.CASTLES_SANDBOX_ID,
  "--max-spend-usd", "999999.99", "--max-seconds", "900"];

test("B2 scan: every file under scripts/ imports, reads and prints nothing beyond the refusal", () => {
  const files = scriptFiles(resolve(root, "scripts"));
  assert.ok(files.includes("smoke.ts"));
  for (const file of files) {
    assert.match(file, /\.ts$/, "only TypeScript is scanned");
    assert.deepEqual(scriptProblems(readFileSync(resolve(root, "scripts", file), "utf8")), [], file);
  }
});
test("B2 scan controls: each planted effect S1 to S6 is found", () => {
  for (const [id, edits] of PLANTED) assert.notDeepEqual(scriptProblems(plant(smokeSource(), edits)), [], id);
});
test("B2 tripwire controls: each planted effect S1 to S6 is reported, and an unchanged copy runs clean", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-planted-"));
  try {
    const base = smokeSource().replace('"../src/profile.ts"', JSON.stringify(pathToFileURL(resolve(root, "src/profile.ts")).href));
    for (const [id, edits] of [["unchanged copy", []], ...PLANTED] as [string, [string, string][]][]) {
      const copy = resolve(directory, String(id.split(" ")[0]));
      mkdirSync(resolve(copy, "scripts"), {recursive: true});
      writeFileSync(resolve(copy, "package.json"), "{\"type\": \"module\"}\n");
      writeFileSync(resolve(copy, "scripts/smoke.ts"), plant(base, edits));
      const child = spawnSync(process.execPath, [...guarded, resolve(copy, "scripts/smoke.ts"), ...largestBudget], {
        cwd: copy, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536,
        env: {PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...syntheticBinding, DAYTONA_API_KEY: "synthetic-canary"},
      });
      assert.equal(child.error, undefined, id);
      if (edits.length === 0) {
        assert.equal(child.stderr, "", id);
        assert.equal(child.status, 1, id);
        assert.equal(JSON.parse(child.stdout).reason, "canonical_capabilities_unavailable", id);
      } else assert.match(child.stderr, /^TRIPWIRE /m, id);
      assert.ok(!(child.stdout + child.stderr).includes("synthetic-canary"), id);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test("S6 an exit inside the test process before its tests finish fails the file instead of passing it", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-exit-"));
  try {
    const run = (guarded: boolean) => {
      const file = resolve(directory, `${guarded ? "guarded" : "unguarded"}.test.mjs`);
      writeFileSync(file, 'import test, { after } from "node:test";\n' +
        (guarded ? `(${guardEarlyExit.toString()})(after);\n` : "") +
        'test("first", () => {});\ntest("exits", () => process.exit(0));\ntest("never reached", () => {});\n');
      return spawnSync(process.execPath, ["--test", file], {cwd: directory, encoding: "utf8", timeout: 10_000,
        env: {PATH: process.env.PATH}});
    };
    assert.equal(run(false).status, 0, "control: without the guard an early exit passes");
    assert.equal(run(true).status, 1, "with the guard it fails");
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test("B2 the largest valid budget with complete inputs still refuses: there is no success branch", () => {
  assert.equal(smoke(largestBudget).reason, "canonical_capabilities_unavailable");
});
test("B2 a smoke run loads no env file from its working directory and leaves it unchanged", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "castles-synthetic-cwd-"));
  try {
    const lines = Object.entries(syntheticBinding).map(([key, value]) => key + "=" + value + "\n").join("");
    for (const name of [".env", ".env.local"]) writeFileSync(resolve(directory, name), lines);
    const before = inputFiles(directory);
    const script = [process.execPath, ...guarded, resolve(root, "scripts/smoke.ts")];
    assert.equal(smokeRun([...script, ...liveArgs], {}, directory).reason, "binding_invalid");
    assert.equal(smokeRun([...script, ...liveArgs], syntheticBinding, directory).reason, "canonical_capabilities_unavailable");
    assert.equal(smokeRun([...script, ...largestBudget], syntheticBinding, directory).reason, "canonical_capabilities_unavailable");
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

test("catalogue coverage lists each of the 76 cases once, each with evidence and a remaining limit", () => {
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

/**
 * N3 and N6 to N8 of rv5b-7a31c9e4, N2 of rv5-aa741628, and its edits D1 to
 * D3: a row set to verified, the matrix deleted and a row citing a missing
 * test all passed. A status change, a citation or a dropped rule now has to
 * change this file in the same reviewed commit. Prose is still read, not
 * tested: these check what the document claims, not that the claims are true.
 */
const acceptance = () => readFileSync(resolve(root, "docs/acceptance.md"), "utf8");
const STANDING: Record<string, string> = {
  G1: "blocked", G2: "unverified", G3: "unverified", G4: "blocked", G5: "blocked", G6: "blocked",
  "#2-A1": "fixture-only", "#2-A2": "fixture-only", "#2-A3": "fixture-only", "#2-A4": "fixture-only",
  "#2-A5": "fixture-only", "#2-A6": "fixture-only", "#2-A7": "blocked",
  "#3-A1": "blocked", "#3-A2": "unverified", "#3-A3": "unverified", "#3-A4": "unverified",
  "#3-A5": "unverified", "#3-A6": "unverified", "#3-A7": "unverified", "#3-A8": "blocked",
  "#4-A1": "unverified", "#4-A2": "blocked", "#4-A3": "unverified", "#4-A4": "unverified",
  "#4-A5": "blocked", "#4-A6": "unverified", "#4-A7": "unverified", "#4-A8": "blocked",
  "#5-R1": "unverified", "#5-R2": "unverified", "#5-R3": "blocked", "#5-R4": "blocked", "#5-R5": "unverified",
  "#5-R6": "unverified", "#5-R7": "unverified", "#5-R8": "unverified", "#5-R9": "unverified",
};
const cells = (row: string) => row.split("|").slice(1, -1).map(cell => cell.trim());
const matrixRows = (text: string) => text.split("\n").filter(line => /^\| (?:G\d|#\d-[AR]\d) \|/.test(line)).map(cells);
const coverageRows = (text: string) => (text.split("## Catalogue coverage\n")[1]?.split("\n## ")[0] ?? "")
  .split("\n").filter(line => /^\| [A-Z]{3}-\d\d \|/.test(line)).map(cells);
const citations = (text: string) => [...text.matchAll(/\b(mvp|preflight) `([^`]+)`/g)].map(match => [match[1], match[2]]);
function preflightTitles(): string[] {
  const source = readFileSync(resolve(root, "tests/preflight.test.ts"), "utf8");
  const failClosed = [...(source.split("const FAIL_CLOSED_CASES = [")[1]?.split("] as const;")[0] ?? "")
    .matchAll(/"([^"]+)"/g)].map(match => match[1]);
  return [...source.matchAll(/\btest\(\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g)].flatMap(([, literal]) =>
    literal.startsWith("`") ? (literal === "`fail-closed fixture: $" + "{name}`"
      ? failClosed.map(name => "fail-closed fixture: " + name) : [literal]) : [JSON.parse(literal) as string]);
}
test("N7 D1 D2 the matrix keeps the 38 promises at their standing, none verified, and the count line agrees", () => {
  const rows = matrixRows(acceptance());
  assert.deepEqual(rows.map(row => row[0]), Object.keys(STANDING), "each promise once, in issue order");
  for (const row of rows) assert.ok(["verified", "fixture-only", "unverified", "blocked"].includes(row[2]), row[0]);
  assert.deepEqual(rows.filter(row => row[2] === "verified").map(row => row[0]), [],
    "verified needs independently reviewed real-daemon or live-provider evidence; none exists");
  assert.deepEqual(Object.fromEntries(rows.map(row => [row[0], row[2]])), STANDING);
  const count = (status: string) => rows.filter(row => row[2] === status).length;
  assert.ok(acceptance().includes("**Count:** 38 promises. verified " + count("verified") + ", fixture-only " +
    count("fixture-only") + ", unverified " + count("unverified") + ", blocked " + count("blocked") + "."));
});
test("N3 D3 every test the notes cite exists by its exact title, and every row with partial evidence cites one", () => {
  const known = {mvp: new Set(titles), preflight: new Set(preflightTitles())};
  const cited = citations(acceptance());
  assert.ok(cited.length >= 40);
  for (const [file, title] of cited) assert.ok(known[file as "mvp" | "preflight"].has(title), file + " test not found: " + title);
  for (const [id, evidence] of coverageRows(acceptance()))
    assert.ok(evidence.startsWith("Blocked:") || citations(evidence).length > 0, id + ": partial evidence names its test");
  for (const row of matrixRows(acceptance()).filter(row => row[2] === "fixture-only"))
    assert.ok(citations(row[3]).length > 0, row[0] + ": fixture-only names its tests");
});
test("N6 N8 the notes keep the merged rules, the full live gate and the catalogue facts, and open nothing", () => {
  const text = acceptance();
  for (const rule of ["A higher class is never inferred from a lower one.",
    "they are not evidence for any row here", "One passing case never establishes a checkbox by itself.",
    "the scan is a tripwire, not a proof"])
    assert.ok(text.includes(rule), rule);
  const live = text.split("\n").find(line => line.startsWith("| Live qualification |")) ?? "";
  for (const condition of ["Accepted #2 to #4 revisions", "real admission", "safe containment", "exact sandbox assignment",
    "separate explicit provider and spending authorization", "named operator and window"])
    assert.ok(live.includes(condition), condition);
  const catalogue = readJson(resolve(fixtureRoot, "negative-cases.json")) as {cases: {id: string, basis?: unknown, dependsOn: string[]}[]};
  const basis = catalogue.cases.filter(entry => entry.basis !== undefined).map(entry => entry.id);
  assert.equal(basis.length, 13);
  const basisLine = text.split("\n\n").find(paragraph => paragraph.startsWith("Thirteen cases carry a `basis` field")) ?? "";
  assert.deepEqual(basisLine.match(/[A-Z]{3}-\d\d/g), basis);
  assert.equal(catalogue.cases.filter(entry => entry.dependsOn.some(item => item.startsWith("#2 binding/preflight contract"))).length, 19);
  assert.ok(text.includes("Nineteen cases name"));
  assert.ok(coverageRows(text).find(row => row[0] === "ADM-05")?.[2].includes("coven-agents#298"), "ADM-05 names the dispatch half");
  assert.doesNotMatch(text, /supersede/i, "a #5 document supersedes no shared file");
  assert.doesNotMatch(text, /\bopened by\b|\bgate (?:is )?open(?:ed)?\b/i, "no gate is recorded as open");
});
