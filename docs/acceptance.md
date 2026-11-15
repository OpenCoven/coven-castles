# Acceptance notes: one-sandbox MVP

Owned by [#5](https://github.com/OpenCoven/coven-castles/issues/5). Draft.

**State of this document:** offline qualification only. This revision adds the #5 offline harness: the checks in `tests/mvp.test.ts` and the refusal-only `scripts/smoke.ts`. The #5 lane has made no live provider call, and no code in this repository can make one. Nothing below is live-verified: no live readiness, admission, cancellation, containment or safe reuse is established. Real-provider runs recorded upstream (for example in OpenCoven/coven-agents#262) are upstream evidence about upstream code; they are not evidence for any row here. This is not a quickstart; the quickstart is drafted only after there is tested behaviour to describe.

## How to read a status

Each promise has exactly one status.

| Status | Meaning |
| --- | --- |
| **verified** | Shown against the real daemon or the real provider at an exact revision, with a retained receipt, and independently reviewed. Nothing has this status today. |
| **fixture-only** | An offline test with synthetic input passes at an exact revision. Says nothing about the real provider or real admission. |
| **unverified** | No executable evidence. Includes everything designed but not run. |
| **blocked** | Cannot be shown until a named capability or decision exists. The blocker and its owner are stated. |

The Promise column abbreviates each item. The wording in the issue is the obligation: [#1](https://github.com/OpenCoven/coven-castles/issues/1) for G1 to G6, and the acceptance list of [#2](https://github.com/OpenCoven/coven-castles/issues/2), [#3](https://github.com/OpenCoven/coven-castles/issues/3), [#4](https://github.com/OpenCoven/coven-castles/issues/4) and [#5](https://github.com/OpenCoven/coven-castles/issues/5) for the rest.

Evidence classes, kept separate in every receipt: **fixture** (offline, synthetic), **real-daemon** (the canonical service with a real database, no provider), **live-provider** (authorized calls against the one supplied sandbox). A higher class is never inferred from a lower one.

Tests are cited by exact title, in backticks, after the word mvp (a test in `tests/mvp.test.ts`) or preflight (a test in `tests/preflight.test.ts`). The suite fails if a cited title does not exist. A cited test is evidence of the stated class for the stated scope, and nothing more.

## Revisions this draft was written against

| Component | Revision | Standing |
| --- | --- | --- |
| Castles base | `b5d7fc14add09fa94a7103031d7d625f710e519c` | `main` with PRs #6, #9 and #7 merged |
| #2 preflight | `13ab3bc2c823fe12b482a6701ab4df2c28e6733c`, merged by PR #6 | Accepted by the maintainer at this SHA ([acceptance comment](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865)). The comment records its basis: review `rv6c-3db7f9d0`, a second read, not the independent R4 review #1 names. It authorizes no live call, spend or sandbox mutation. Open at this SHA: R1 (integer fields can echo an all-digit configured ID), R2 (the capability scan does not stop a read of another environment variable), R3 (five provider fields not examined). Consumed: the harness calls this revision's API and runs its test command. |
| Later #2 revisions | draft PRs #10, #11 and #12 | Proposed, not accepted. Not consumed. |
| #7 fixture corpus | `302bb4533aaccde8165d8efe596502da286891b0`, merged by PR #7 | Unchanged here, byte for byte (mvp `N1 N4 fixtures/report-task is entry for entry the corpus merged at 302bb45`). Merging decided neither the proposed fixture limits nor the review-independence proposals. |
| #3 runtime | none | Investigation comment only; no interface |
| #4 recovery | none | Investigation comment only; no interface |
| Canonical source | `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180` | As pinned by #1; private. No canonical client or authority interface is introduced. |

`docs/contracts.md` at this base still describes `13ab3bc` as not accepted and the harness-wiring gate as closed. That page is a shared file stewarded by #2; this document neither changes it nor overrides it. Its update is proposed in draft PRs #10 and #12. Until the steward's update lands, the acceptance comment is the record of the decision, and the standing of the gate is the epic maintainer's to state (see Open gates).

The reproduction this lane ran of #2 at `13ab3bc`, before acceptance, in a fresh clone with the environment reduced to `HOME` and `PATH`, Node 24.22.0, macOS arm64:

| Command | Result | Class |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | exit 0 (warm local store) | n/a |
| `corepack pnpm test` | exit 0: 93 tests, 92 pass, 0 fail, 1 skipped; IP networking denied | fixture |
| `corepack pnpm typecheck` | exit 0; IP networking denied | static |
| `corepack pnpm check --fixture fixtures/preflight/cases/ready.json` | `status: ready`, `evidence: FIXTURE`, exit 3; IP networking denied | fixture |

IP networking was denied for `test`, `typecheck` and `check` with a macOS `sandbox-exec` profile that refuses outbound and inbound IP traffic; a `curl` to a public registry under the same profile could not connect. The install step used a warm local package store. The working tree of the clone was unchanged after the runs. The one skipped test is #2's own control that a planted network connection fails: Node 24.22.0 has no network permission, so on this version "without network" rests on the profile above, not on #2's suite. Exit 3 is #2's code for a fixture result, which is never readiness. This is a reproduction, not the independent review #1 names.

Exact-SHA receipts for a candidate (commands, results, reviewer provenance) belong in the #5 handoff and apply only to that SHA. This document does not claim that a later head was tested.

## Offline evidence and commands

`corepack pnpm test` discovers `tests/mvp.test.ts` through the existing runner. It:

- checks the exact task and input inventory and their SHA-256 sums, the inclusive manifest bounds, UTF-8 and path refusals, and the catalogue's own OUT-02 and OUT-03 examples;
- pins every entry of `fixtures/report-task/` (type, path, executable bit, SHA-256) to a digest of the corpus at `302bb45`, and independently refuses an empty directory or executable file under `input/`, an unlisted sample, missing run-evidence rules and a known-limit label that contradicts its recipe;
- applies parsing revision 3 and all 18 text properties with a test-local grader, checks the nine report files and 201 generated recipes against their exact expected failure sets, and pins with direct cases the parsing rules no recipe reaches: fence closing and indent, heading indent, repeated titles, level-3 headings, section length in characters, flat text, `in` joins, the 200-byte edge and rules without `in`;
- exercises the accepted preflight API through a tripwire inspection client;
- runs the refusal-only smoke script in subprocesses, each with a five-second deadline and under a preload that refuses effects started from `scripts/`;
- checks this document's matrix, count line and citations.

A separate bounded runner must still put a hard deadline on the whole suite: a Node test timeout cannot interrupt a synchronous regex.

What these checks are not:

- The report grader is test-local synthetic conformance code. It is not an operator report validator, a canonical result contract, a semantic diagnosis oracle or a proof of runtime enforcement. All six `onRunEvidence` properties (RE-01 to RE-06) remain blocked on #3 and #4. Runtime canaries in the smoke and preflight tests check only those client surfaces; they do not implement RE-06's guest, report, artifact and export checks.
- The 64 recipes tagged `knownLimit` pin results that are wrong on purpose: 40 reports that should be rejected and pass, 24 correct reports that fail. A green corpus check means those declared limitations were reproduced, not fixed. No text property can decide whether a diagnosis is right or whether text is visible to a reader; the classes are listed under Limits in `fixtures/report-task/README.md`. A person reads a report before it is counted.
- The corpus digest is a literal in a reviewed file, not proof of authenticity: a fixture changed together with the digest passes. Provenance is the comparison with `302bb45` (`git diff --exit-code 302bb45 HEAD -- fixtures/report-task`), kept as separate evidence. The two hash files alone do not detect an added empty directory or a changed file mode; the inventory test does.
- The smoke preload is a tripwire, like #2's capability scan. It sees effects started from a file under `scripts/` through the Node built-ins it wraps. It does not see what a native addon or a changed loader could do, and it cannot show provider-side state.

| Command | Expected terminal result | Class and limit |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | Exit 0 from a warm package store | Setup; not offline execution evidence and not a cold-store claim |
| `corepack pnpm test` | Exit 0; every test passes except the existing skips | fixture; the receipt lists every skip |
| `corepack pnpm typecheck` | Exit 0 | static; the test's import brings `scripts/smoke.ts` in without changing tsconfig |
| `corepack pnpm check --fixture fixtures/preflight/cases/ready.json` | Exit 3, synthetic ready | fixture; never readiness |
| `node --import tsx scripts/smoke.ts` | Exit 1, `explicit_opt_in_required` | refusal only; evidence none, zero provider calls. Every spelling of the path exits 1 |
| `gitleaks git --redact --no-banner .` | Exit 0, no findings | static secret scan; not a proof that arbitrary future output is safe |

Fresh-checkout verification removes inherited credentials and denies outbound and inbound IP networking at the OS level, with an allowed and a denied control. The receipt records the exact OS profile and commands. Dependency installation is a separate step. Node 24.22.0 lacks the Node network-permission option, so #2's network control (preflight `control: a planted network connection fails under the same confinement`) is skipped on that version; the OS control is separate evidence and does not relabel the skip.

## Smoke refusal contract

`scripts/smoke.ts` supports only `--live --sandbox-id <exact-id> --max-spend-usd <positive-decimal> --max-seconds <1..900>`. These are local validation inputs, never authorization. Spend is a positive decimal with at most six integer digits and two fractional digits. Seconds are canonical positive integers, at most 900. Missing opt-in, budgets, binding or target, invalid budgets, duplicate options, a different target (compared exactly, and never echoed) and unsupported arguments all refuse. Negative values can be passed unambiguously as `--max-spend-usd=-1` or `--max-seconds=-1`, and refuse too.

Even complete inputs return `canonical_capabilities_unavailable`. Every outcome exits 1 and prints one bounded JSON line with schema `castles.smoke-refusal.v1`, status `blocked`, evidence `none`, a fixed reason and `providerCalls: 0`. There is no success branch, endpoint, provider client, credential lookup, env-file loading, fixture fallback, workspace write or lifecycle operation. Only the four existing binding environment keys are read. Fixture, mock, reset, cleanup-bypass and directory options are unsupported; an authorization-looking or fixture environment variable cannot open execution. No real owner credential is validated, because its canonical contract is unavailable.

The script refuses whenever Node runs it as the program, by `import.meta.main`, so every spelling of its path exits 1: with or without the extension, through the `tsx` binary, through a symlink to the file or to its directory, and with complete `--live` arguments (mvp `B1 smoke refuses however it is invoked as the program`). A Node that does not set `import.meta.main` uses canonical module resolution of the supplied entry, including an implicit `.ts` extension and symlinks (mvp `B1 main detection uses Node metadata or canonical legacy module resolution`). This preserves the declared Node 22 floor: running the script refuses; importing it has no effect, including on Node 22.0.0 (mvp `B1 importing the smoke module is side-effect free`).

The no-effects statements are pinned, not only stated; the tests do not rely on the script's own `providerCalls` literal. mvp `B2 scan: every file under scripts/ imports, reads and prints nothing beyond the refusal` limits what any file under `scripts/` may import and use. mvp `B2 scan controls: each planted effect S1 to S6 is found` and mvp `B2 tripwire controls: each planted effect S1 to S6 is reported, and an unchanged copy runs clean` show that the scan and the preload catch six planted effects: a credential variable read, an env-file load, a network call, a file write, a child process and a success branch. mvp `B2 the largest valid budget with complete inputs still refuses: there is no success branch` and mvp `B2 a smoke run loads no env file from its working directory and leaves it unchanged` cover the rest.

This is an operator-visible refusal boundary, not the live qualification harness #5 asks for. Live qualification still needs every condition in its row under Open gates. Do not invent an authentication format to get past the refusal.

## Qualification matrix

IDs: `G1` to `G6` are the hard release gates in #1. `#N-Ak` is the k-th acceptance checkbox of issue #N. `#5-Rk` is the k-th acceptance-receipt checkbox of #5.

Where a row names cases, it names every catalogue case mapped to that item. Where it names none, the mapping is in the `tests`, `releaseGates` and `scope` fields of `fixtures/report-task/negative-cases.json`. Eleven cases carry `scope`, which names a scope rule that has no checkbox; for four of them (CFG-09, OUT-01 to OUT-03) it is the only mapping.

### #1 release gates

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| G1 | Exact owner/sandbox and familiar revision binding before task or credential effects | blocked | Sandbox half: #2 is accepted at `13ab3bc`, with fixture evidence only; binding a run to the supplied sandbox is OpenCoven/coven-agents#298 (open). Familiar-revision half: admission does not carry a familiar root/revision upstream (per the #3 investigation; no upstream issue found). Owner: canonical producer maintainers, then #3. |
| G2 | Duplicate submit/reconnect resolves one run; changed-payload reuse conflicts | unverified | No #3 interface. Cases ADM-08 to ADM-10, OUT-12, REC-01, REC-04, REC-06. |
| G3 | Results and receipts retrievable after disconnect or sandbox stop | unverified | No #4 interface. Cases REC-01, REC-05, REC-07, CAN-06. |
| G4 | Cancellation not complete without qualified containment; uncertainty visible and fenced | blocked | No qualified containment upstream; OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. |
| G5 | Second task requires live, non-destructive containment/reuse evidence; `cleanup_required` retained | blocked | No workspace-preserving reuse path upstream; OpenCoven/coven-agents#262 (open). Reported as blocked, not waived. Owner: canonical producer maintainers. |
| G6 | Two authorized client sessions inspect the same outcome. Unsupported mobile mutation remains unavailable | blocked | No non-browser owner credential for the run routes upstream: OpenCoven/coven-agents#297 (open, undecided). Owner: canonical producer maintainers. Cases REC-02, REC-03, REC-08, CAN-04. |

### #2 Bind and preflight

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #2-A1 | Fresh checkout runs offline fixture tests without credentials or network | fixture-only | Reproduced at `13ab3bc` (table above): offline install, then 93 tests, 92 pass, 0 fail, 1 skipped, with `HOME` and `PATH` only and IP networking denied. The skipped test is the network control, preflight `control: a planted network connection fails under the same confinement`, so the network half rests on the OS profile. A candidate's results for the whole suite are in its #5 handoff. Not shown live. |
| #2-A2 | Missing ID, wrong owner, wrong generation, unknown profile, unsafe lifecycle, public exposure, unavailable provider, mismatched returned ID each fail closed | fixture-only | At `13ab3bc`, one test per named condition: preflight `fail-closed fixture: missing-id`, preflight `fail-closed fixture: wrong-owner`, preflight `fail-closed fixture: wrong-generation`, preflight `fail-closed fixture: unknown-profile`, preflight `fail-closed fixture: unsafe-lifecycle`, preflight `fail-closed fixture: public-exposure`, preflight `fail-closed fixture: unavailable-provider`, preflight `fail-closed fixture: mismatched-returned-id`, with seven more fail-closed fixtures. Through the accepted API: mvp `CFG-01 accepted preflight: missing-id`, mvp `BND-01 accepted preflight: wrong-owner`. Not shown live. |
| #2-A3 | Missing sandbox causes zero create/start/update/delete; ambiguous lookup triggers no replacement or adoption | fixture-only | preflight `a missing sandbox causes zero create/start/update/delete calls`, preflight `an ambiguous lookup triggers no replacement, adoption, or second lookup`, preflight `a substituted sandbox is never adopted and its metadata is not disclosed`; mvp `BND-04 accepted preflight: missing-sandbox`, mvp `BND-05 accepted preflight: ambiguous-lookup`. Not shown live. |
| #2-A4 | Read-only checks leave files, processes and provider configuration unchanged; no harness credentials acquired | fixture-only | preflight `CLI check is read-only, credential-blind, and emits human and JSON output`, preflight `a stopped sandbox is reported as stopped and is never woken`, preflight `every file under src/ passes the capability scan` and preflight `CLI runs unchanged with writes, child processes, workers, addons, WASI and string code generation denied`. As #2's own tests say, the scan is a tripwire, not a proof (preflight `the capability scan is a tripwire, not a proof: these known evasions pass it`), and review `rv6c-3db7f9d0` (R2) shows it does not stop a read of another environment variable; that review confirms by reading `src/` that the code does none. The smoke script has its own scan and preload (Smoke refusal contract), tripwires too. Provider-side state can only be shown live. |
| #2-A5 | JSON output bounded, redacted, separates source policy from observed metadata | fixture-only | preflight `JSON output separates source policy from observed metadata`, preflight `output uses redacted aliases, never the configured private IDs`, preflight `JSON output stays bounded and clean under hostile provider metadata`, preflight `no echoed field can carry the configured IDs or free text into output`, preflight `every string in observed output is drawn from a fixed vocabulary`; mvp `BND-09 RED-02 RED-03 preflight errors, timeouts and hostile metadata stay bounded and redacted`. R1 is open at `13ab3bc`: integer fields are echoed unbounded, so an all-digit configured ID returned in a numeric field would reach output. |
| #2-A6 | Contract pins and the owner of every mutation recorded; unknown upstream capability is an explicit blocker | fixture-only | The item asks for the record: preflight `source pins are exact repo@sha:path references`, preflight `every provider mutation names its existing upstream owner, and none is Castles`, preflight `the missing upstream binding seam is an explicit blocker with a link` (OpenCoven/coven-agents#296, open). The capability being absent is what blocks live rows, not this one. |
| #2-A7 | #3 and #5 receive a reviewed contract/test-command handoff at an exact SHA; fixture paths do not overlap and shared-file ownership is recorded | blocked | A process item no fixture can show. The maintainer's acceptance at `13ab3bc` is the handoff, and this harness consumes it; its recorded basis is a second read, not the independent R4 review #1 names. Fixture paths do not overlap (`fixtures/preflight/`, `fixtures/report-task/`). `docs/ownership.md` still lists `tests/mvp.test.ts`, `scripts/smoke.ts` and `docs/acceptance.md` as not yet created, and `docs/contracts.md` still says not accepted (see above). Whether the item is met is the epic maintainer's decision. Owner: epic maintainer. |

### #3 Bootstrap and run one authorized task

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #3-A1 | Fixture completes through real admission and produces an attributable report with run/attempt references | blocked | No implementation. Upstream: OpenCoven/coven-agents#297 (owner audience), #298 (bind dispatch to the supplied sandbox), #299 (read-only permission), all open; familiar revision in admission has no upstream issue. Owner: canonical producer maintainers, then the #3 owner. Only case: ADM-11. |
| #3-A2 | Wrong revision, revoked owner, expired grant, unsupported capability, mismatched sandbox, missing authority refuse before effects | unverified | Cases ADM-01 to ADM-06, CFG-08. |
| #3-A3 | Concurrent submission denied; duplicate returns existing run; changed payload conflicts | unverified | Cases ADM-07 to ADM-10, OUT-12. |
| #3-A4 | Runtime verification against the pinned manifest is repeatable and mutates nothing; a snapshot, harness or contract mismatch reports incompatible (reworded on #3, 2026-11-11, after the decision recorded for OpenCoven/coven-agents#300) | unverified | Cases BST-01 to BST-04, rewritten for verification only. |
| #3-A5 | Execution and output limits enforced outside model instructions | unverified | Cases OUT-04 to OUT-06, OUT-10, OUT-13; run-evidence properties RE-01 to RE-05. OUT-01 to OUT-03 test #3 scope item 5 (input staged as bounded data), which has no checkbox. |
| #3-A6 | No provider/admin secret in guest configuration, output, artifacts or logs | unverified | Cases RED-01, RED-06, CFG-07. Primary check is the seeded-value property RE-06; the text patterns RP-11 to RP-14 are a secondary net. |
| #3-A7 | Source tests and fixtures labelled; a mock does not establish a deployment | unverified | Cases CFG-06, ADM-11. |
| #3-A8 | Reviewed contract references handed to #4/#5 | blocked | Waits on #2-A7, then on #3 implementation and independent R4 review. Owner: epic maintainer for #2-A7, then the #3 owner. |

### #4 Recovery, cancellation and reuse

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #4-A1 | Disconnect and lost acknowledgement recover the same run; no duplicate execution | unverified | Cases ADM-08, OUT-12, REC-01, REC-04, REC-06, CAN-06. |
| #4-A2 | Second authorized session sees the same revision, status, receipt and report; others cannot read or cancel | blocked | Receipt and familiar-revision fields absent from the canonical outcome (per the #4 investigation; no upstream issue found); no non-browser credential (OpenCoven/coven-agents#297, open). Owner: canonical producer maintainers. Cases REC-02, REC-03, CAN-04. |
| #4-A3 | Stop/restart preserves a workspace marker; outcome retrievable with the sandbox unavailable | unverified | Cases REC-05, REC-07, REU-08. Marker half is live-only and needs separate stop/start authorization. |
| #4-A4 | Cancel races, stale results, expired authorization and ambiguous responses never release an attempt or replay an effect | unverified | Cases CAN-01 to CAN-06. |
| #4-A5 | Second task only after the real containment gate; injected descendant or cleanup failure blocks it | blocked | OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. Refusal side is designable (BND-08, REU-01 to REU-04); the success side (REU-07) has no passing path upstream. |
| #4-A6 | Bounded, hash-checked export; traversing paths rejected | unverified | Cases OUT-04, OUT-07 to OUT-09, OUT-11, RED-04. |
| #4-A7 | No delete, recreate, destructive reset or authority restoration | unverified | Cases REU-05, REU-09, REC-06. |
| #4-A8 | #5 receives reviewed revisions, receipts, evidence class and remaining blocker | blocked | Waits on #3-A8, then #4 implementation and independent R4 review. Owner: the #3 owner, then the #4 owner. |

### #5 Qualification

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #5-R1 | Offline verification passes from a clean checkout without network, secrets or provider mutation | unverified | The entrypoint exists: `corepack pnpm test` runs this suite, starting from mvp `fixture manifest and exact task/input inventory conform to declared hashes and bounds`. A candidate's results from a fresh clone with an empty environment and IP networking denied are in its #5 handoff, not in the repository, and are not yet reproduced by a reviewer at an exact SHA. It becomes fixture-only when they are. |
| #5-R2 | No live call without explicit opt-in and exact sandbox/budget configuration | unverified | The refusal half is pinned: every invocation refuses before any effect, complete inputs included (mvp `CFG-03 smoke without explicit opt-in refuses`, mvp `CFG-04 smoke rejects missing and malformed budgets`, mvp `CFG-05 smoke refuses a missing or different exact target`, mvp `CFG-08 complete-looking inputs and forged authorization still refuse`). The item is about a live call made only with opt-in and exact configuration: no live path exists, and its mapped case OUT-13 is blocked. Cases CFG-03 to CFG-05, CFG-08, OUT-13. |
| #5-R3 | Fixture report returned through real admission; two sessions recover the same receipt without duplicate work | blocked | Depends on #3-A1 and #4-A2 and their owners. Cases ADM-11, REC-02. |
| #5-R4 | Safe repeat execution proven; retained `cleanup_required` reported as blocked | blocked | OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. Cases REU-01, REU-06, REU-07. |
| #5-R5 | Redacted exact-head evidence with Castles and canonical component SHAs, package hashes, SDK/image identities, environment, commands, pass/fail/skip, measurements and unresolved limitations; actual sandbox identifiers and private artifacts stay out of public issues and logs | unverified | Nothing to attest yet. Cases RED-01, RED-02, RED-05. |
| #5-R6 | Failure/unknown states visible; no test bypasses identity, credential, authorization, budget or cleanup enforcement | unverified | Cases CFG-04, CFG-06, REU-04. |
| #5-R7 | Existing user data unchanged; any start/stop specifically authorized; no provision, resize, delete, reset, payment, release or deployment | unverified | No live work performed or authorized. Trivially true so far; not evidence. Cases CFG-10, BST-04, REC-07, REU-05, REU-08. |
| #5-R8 | README uses only verified claims; a fixture pass does not mean live acceptance, and a one-shot live result does not mean the repeatable MVP is ready | unverified | README is #2's file; no #5 quickstart text exists. Case ADM-11 covers labelling only. |
| #5-R9 | Handoff maps each promise to a revision and evidence class, names owners and next action; unimplemented or skipped live checks remain unverified, never silently green | unverified | This matrix is the draft of that mapping. The suite checks its shape, not its truth: the 38 promises at their standing, the count line and every citation (mvp `N7 D1 D2 the matrix keeps the 38 promises at their standing, none verified, and the count line agrees`, mvp `N3 D3 every test the notes cite exists by its exact title, and every row with partial evidence cites one`). Case REU-06. |

**Count:** 38 promises. verified 0, fixture-only 6, unverified 20, blocked 12. All six fixture-only rows are #2 rows.

## Negative-case catalogue

`fixtures/report-task/negative-cases.json` holds 76 cases. Each names the release gates, acceptance items and scope rules it bears on and the reviewed contract it waits on. Some have a partial executable check in this suite (see Catalogue coverage); none is executed end to end, and none against the real daemon or provider. One passing case never establishes a checkbox by itself.

Thirteen cases carry a `basis` field: part of their expectation goes beyond what #1 to #5 say and is #5's proposal to the lane that owns the contract (ADM-03, ADM-06, ADM-07, ADM-10, OUT-04, OUT-08, OUT-10, OUT-11, OUT-12, OUT-13, REC-03, REC-05, RED-02). That lane's reviewed contract decides them.

Nineteen cases name "#2 binding/preflight contract (proposed, not accepted: draft PR #6)" in `dependsOn`. The maintainer has since accepted that contract at `13ab3bc`, so the wording is stale. It stays because this revision changes no fixture byte; correcting it is a fixture change with its own review. CFG-07 and BND-06 were re-read against the rules of `13ab3bc` and their expectations still agree with it: CFG-07 expects a secret in the client environment not to be read or echoed, and BND-06 expects `incompatible`, which is what `13ab3bc` reports for public exposure, an unsafe lifecycle, unrestricted egress, an unsafe allow list and missing metadata (which includes an architecture outside the known set). The catalogue does not restate #2's finer rules (the ten-entry cap on a network allow list, the fixed vocabulary for echoed fields, client-derived evidence); #2's own tests carry those.

| Area | Cases | Release gates | Acceptance items | Scope rules |
| --- | --- | --- | --- | --- |
| configuration | 10 (CFG-01 to CFG-10) | G1 | #2-A2, #2-A3, #2-A5, #3-A2, #3-A6, #3-A7, #5-R2, #5-R6, #5-R7 | #1 fixed scope; #2 scope 5; #5 scope 2 and 3 |
| binding | 9 (BND-01 to BND-09) | G1, G5 | #2-A2, #2-A3, #2-A4, #2-A5, #4-A5 | none |
| admission | 11 (ADM-01 to ADM-11) | G1, G2 | #3-A1, #3-A2, #3-A3, #3-A7, #4-A1, #5-R3, #5-R8 | none |
| bootstrap | 4 (BST-01 to BST-04) | none directly | #2-A4, #3-A4, #5-R7 | none |
| bounded outputs | 13 (OUT-01 to OUT-13) | G2, G4 | #3-A3, #3-A5, #4-A1, #4-A6, #5-R2 | #1 fixed scope; #3 scope 5 |
| reconnect | 8 (REC-01 to REC-08) | G2, G3, G6 | #4-A1, #4-A2, #4-A3, #4-A7, #5-R3, #5-R7 | second sentence of G6 |
| cancellation | 6 (CAN-01 to CAN-06) | G3, G4, G6 | #4-A1, #4-A2, #4-A4 | none |
| redaction | 6 (RED-01 to RED-06) | none directly | #2-A5, #3-A6, #4-A6, #5-R5 | none |
| reuse refusal | 9 (REU-01 to REU-09) | G4, G5 | #4-A3, #4-A5, #4-A7, #5-R4, #5-R6, #5-R7, #5-R9 | #4 scope 6; #5 scope 3 |

### Coverage that is absent or thin

Six items have no case because they are positive or process obligations rather than refusals: #2-A1 and #5-R1 (offline pass from a clean checkout), and the three handoff items #2-A7, #3-A8 and #4-A8. #2-A6 (pins recorded) has none either; #2's own tests cover it.

Items with only one case, which is not enough to carry them:

- #3-A1 has only ADM-11, a labelling case. The item is a positive one: a real admitted run. No catalogue case can stand in for it.
- #5-R8 has only ADM-11, and #5-R9 has only REU-06. Both are about what the final documents say and are checked by reading them at the exact head.

Rules in #1 and #5 with no case, recorded as a decision rather than left silent:

- "No local model, desktop/VNC, browser automation or swarm" (#1): nothing in the client can start one, and there is no surface to search until #3 publishes its runtime manifest. To be added against that manifest.
- "Run tests against production user data" (#5 scope 2): CFG-10 covers the path side. Whether data is production data cannot be decided by a test; it is an operator authorization recorded in the live handoff.

## Catalogue coverage

Every one of the 76 catalogue IDs is listed once; the suite checks that the list is complete and that every row with partial evidence cites a test. This table is coverage metadata: a cited test is a partial check of the synthetic or client-side half of a case, never the case itself. No unreviewed #3 or #4 contract is substituted.

| Case | Executable evidence in this slice | Remaining dependency or limitation |
| --- | --- | --- |
| CFG-01 | mvp `CFG-01 accepted preflight: missing-id`: missing ID, zero inspection accesses. | Real provider inspection remains coven-agents#296; fixture result only. |
| CFG-02 | mvp `CFG-02 accepted preflight: unknown-profile`: unsupported profile, zero inspection accesses. | Real provider inspection remains coven-agents#296; fixture result only. |
| CFG-03 | mvp `CFG-03 smoke without explicit opt-in refuses`; every path spelling refuses: mvp `B1 smoke refuses however it is invoked as the program`. | No live path exists; enabling one needs accepted #3/#4 and named authorization. |
| CFG-04 | mvp `CFG-04 smoke rejects missing and malformed budgets`; the spend bound: mvp `CFG-04 smoke spend is at most six integer digits and two fractional digits (review N5)`; the largest valid budget still refuses: mvp `B2 the largest valid budget with complete inputs still refuses: there is no success branch`. | An invoice-level or admitted runtime budget is not implemented; canonical #3 enforcement is required. |
| CFG-05 | mvp `CFG-05 smoke refuses a missing or different exact target`; exact comparison, never echoed: mvp `CFG-05 smoke compares the target exactly and never echoes it (review N5)`. | Canonical dispatch binding still requires coven-agents#298 and #3. |
| CFG-06 | mvp `CFG-06 smoke never accepts fixture or mock flags`; a fixture environment cannot open a fallback: mvp `CFG-08 complete-looking inputs and forged authorization still refuse`; mvp `ADM-11 readiness: fixture and null client never authorize a live run`. | No fixture execution mode exists here; real-admission evidence still needs #3. |
| CFG-07 | mvp `CFG-07 smoke consumes only binding keys and never echoes credential canaries`; a direct read of another variable is reported: mvp `B2 tripwire controls: each planted effect S1 to S6 is reported, and an unchanged copy runs clean`. | Guest credential custody and RE-06 need #3/#4; this shows only the smoke client surface. |
| CFG-08 | mvp `CFG-08 complete-looking inputs and forged authorization still refuse`. | No real expired/revoked owner credential is tested; canonical audience remains coven-agents#297 and #3. |
| CFG-09 | preflight `every file under src/ passes the capability scan`; mvp `B2 scan: every file under scripts/ imports, reads and prints nothing beyond the refusal`. | No #3 runtime surface exists to inspect. Both scans are tripwires, not capability proofs. |
| CFG-10 | mvp `CFG-10 smoke refuses arbitrary directory arguments and preserves existing files`; mvp `B2 a smoke run loads no env file from its working directory and leaves it unchanged`. | No dedicated guest test-directory staging exists until #3; no workspace traversal/write is implemented. |
| BND-01 | mvp `BND-01 accepted preflight: wrong-owner`: exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-02 | mvp `BND-02 accepted preflight: wrong-generation`: exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-03 | mvp `BND-03 accepted preflight: mismatched-returned-id`: exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-04 | mvp `BND-04 accepted preflight: missing-sandbox`: exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-05 | mvp `BND-05 accepted preflight: ambiguous-lookup`, mvp `BND-05 accepted preflight: binding-mismatch`: exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-06 | mvp `BND-06 accepted preflight: public-exposure`, mvp `BND-06 accepted preflight: unsafe-lifecycle`, mvp `BND-06 accepted preflight: metadata-missing`, mvp `BND-06 accepted preflight: unrestricted-egress`, mvp `BND-06 accepted preflight: allow-all-egress`. | No live inspection; five unexamined provider fields remain accepted #2 follow-up R3. The full ephemeral/provider predicate is not certified. |
| BND-07 | mvp `BND-07 accepted preflight: stopped`: reports stopped and uses only inspection. | Run refusal on a stopped bound sandbox requires #3 and coven-agents#298. |
| BND-08 | mvp `BND-08 accepted preflight: unresolved-attempt`: reports reconciliation-required. | Unrelated active-workload admission and containment need #3/#4 and coven-agents#262. |
| BND-09 | mvp `BND-09 accepted preflight: unavailable-provider`; synthetic thrown error, deadline and hostile malformed response: mvp `BND-09 RED-02 RED-03 preflight errors, timeouts and hostile metadata stay bounded and redacted`. | No live response or generalized provider-size defense is shown; coven-agents#296 owns inspection. |
| ADM-01 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found). Owner: #3 and canonical maintainers. |
| ADM-02 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-03 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found). Owner: #3 and canonical maintainers. |
| ADM-04 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-05 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream OpenCoven/coven-agents#296 (read-only inspection seam, open); upstream OpenCoven/coven-agents#298 (bind dispatch to the supplied sandbox, open), which owns a returned-ID mismatch at dispatch before credential effects. Owner: #3 and canonical maintainers. |
| ADM-06 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #3 and canonical maintainers. |
| ADM-07 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-08 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-09 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-10 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); open question for #3: how input bytes enter the payload digest. Owner: #3 and canonical maintainers. |
| ADM-11 | mvp `ADM-11 readiness: fixture and null client never authorize a live run`: fixture cannot become live-ready; null client refuses; CLI synthetic ready exits 3. | A real admitted attributable report requires #3; synthetic output never satisfies it. |
| BST-01 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-02 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-03 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-04 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| OUT-01 | mvp `OUT-01 OUT-02 fixture audit enforces full path matches, UTF-8 and every inclusive input bound`: file count, per-file/total/task bytes, full path/depth and inclusive edges. | Admission/staging rejection before transmission still needs the #3 data-staging contract. |
| OUT-02 | mvp `OUT-01 OUT-02 fixture audit enforces full path matches, UTF-8 and every inclusive input bound`; the catalogue's six refused paths: mvp `OUT-02 OUT-03 the catalogue's own examples: its refused paths are refused, its shell-character content is audited as bytes (review N9)`. | Real staging and filesystem policy enforcement still need #3. |
| OUT-03 | The catalogue's shell-character file passes the fixture audit as bytes and runs nothing: mvp `OUT-02 OUT-03 the catalogue's own examples: its refused paths are refused, its shell-character content is audited as bytes (review N9)`. | No staging/launch implementation exists; byte-preserving data transport is #3 work. The audit is not a staging test. |
| OUT-04 | mvp `report recipe GEN-SIZE-16385` fails RP-02 and RP-15; lower edges mvp `report recipe GEN-SIZE-16384`, mvp `report recipe GEN-SIZE-8000`, mvp `report recipe GEN-SIZE-7999`. | Producer truncation/refusal and export bounds remain #3/#4 contracts; hardMaxBytes is still a proposal. |
| OUT-05 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| OUT-06 | RP-10 recipes check the final-line half of the synthetic report, for example mvp `report recipe GEN-INJ-BARE`, mvp `report recipe GEN-INJ-FENCED`, mvp `report recipe GEN-INJ-RULE-AFTER`. | Marker-file prevention is RE-01 and requires #3 runtime/file evidence. |
| OUT-07 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| OUT-08 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| OUT-09 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| OUT-10 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream OpenCoven/coven-agents#299 (server-side read-only execution permission, open). Owner: #3 and canonical maintainers. |
| OUT-11 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| OUT-12 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| OUT-13 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| REC-01 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); #3 run/attempt/admission interface (does not exist). Owner: #4 and canonical maintainers. |
| REC-02 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #4 and canonical maintainers. |
| REC-03 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #4 and canonical maintainers. |
| REC-04 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| REC-05 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| REC-06 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| REC-07 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); explicit stop/start authorization for an exclusively assigned sandbox. Owner: #4 and canonical maintainers. |
| REC-08 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #4 and canonical maintainers. |
| CAN-01 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #4 and canonical maintainers. |
| CAN-02 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| CAN-03 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| CAN-04 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #4 and canonical maintainers. |
| CAN-05 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| CAN-06 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| RED-01 | RP-11 to RP-14 recipes exercise the secondary text-pattern net, for example mvp `report recipe GEN-KEY-PEM`, mvp `report recipe GEN-AUTH-BASIC`, mvp `report recipe GEN-TOK-JWT`, mvp `report recipe GEN-SEC-JSON`. | Primary RE-06 seeded run/artifact/export canaries require #3/#4; known pattern misses remain pinned. |
| RED-02 | mvp `BND-09 RED-02 RED-03 preflight errors, timeouts and hostile metadata stay bounded and redacted`: ordinary synthetic IDs and thrown error canaries are omitted. | Accepted #2 R1 numeric-ID disclosure remains open; export/run surfaces require #3/#4. |
| RED-03 | mvp `BND-09 RED-02 RED-03 preflight errors, timeouts and hostile metadata stay bounded and redacted`: a malformed oversized response stays bounded with no raw text disclosed. | A generalized hostile-provider nesting/size proof is not claimed; the real seam remains coven-agents#296. |
| RED-04 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| RED-05 | Blocked: no executable check in this suite. `gitleaks git --redact --no-banner .` on the exact head is a static check recorded in the handoff. | No live qualification packet exists; human inspection and independent R4 review are still required. |
| RED-06 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| REU-01 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-02 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-03 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-04 | mvp `CFG-06 smoke never accepts fixture or mock flags`: reset/ignore-cleanup flags refuse; mvp `CFG-08 complete-looking inputs and forged authorization still refuse`: forged environment cannot open execution. | Canonical cleanup-fence bypass resistance still requires #4 and coven-agents#262. |
| REU-05 | preflight `every provider mutation names its existing upstream owner, and none is Castles`; mvp `B2 scan: every file under scripts/ imports, reads and prints nothing beyond the refusal`. | Full runtime/recovery surface inspection requires accepted #3/#4; no upstream mutation implementation is copied. |
| REU-06 | Smoke never reports success: mvp `B2 the largest valid budget with complete inputs still refuses: there is no success branch`; G4 and G5 stay blocked: mvp `N7 D1 D2 the matrix keeps the 38 promises at their standing, none verified, and the count line agrees`. | An actual cleanup_required terminal receipt needs #4 and coven-agents#262. |
| REU-07 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open); explicit provider authorization. Owner: #4 and canonical maintainers. |
| REU-08 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); explicit stop/start authorization for an exclusively assigned sandbox. Owner: #4 and canonical maintainers. |
| REU-09 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |

## Measurement plan

Scope item 5 of #5. Every value is **unmeasured**. No number may be entered without the exact sandbox profile, revision, command and sample count beside it, and none may be entered from a fixture run.

| Metric | How it will be taken | Baseline | Post-change |
| --- | --- | --- | --- |
| Actual vCPU, RAM, disk | Read-only preflight of the supplied sandbox | unmeasured | unmeasured |
| Architecture | Read-only preflight; upstream does not currently report it | unmeasured | unmeasured |
| Image and SDK identity | Preflight plus pinned source | unmeasured | unmeasured |
| Runtime artifact and install footprint | Size of the dedicated runtime directory after bootstrap | unmeasured | unmeasured |
| Cold readiness | Time from explicit start to ready, sandbox previously stopped. Needs stop/start authorization | unmeasured | unmeasured |
| Warm readiness | Time from check to ready, sandbox already running | unmeasured | unmeasured |
| Peak process memory | Not decided. An in-guest sampler needs #3's agreement and must not itself become polling; the alternative is a figure the canonical owner already records, if one exists | unmeasured | unmeasured |
| Disk growth per run | Workspace and runtime directory size before and after one run | unmeasured | unmeasured |
| Provider-call count | Two counts, kept separate. Client seam: calls Castles makes for check, run, observe, cancel, export. Server side: calls the canonical owner makes for the same operations, which is where most provider calls happen (per the #3 investigation) and which Castles cannot count; it needs a figure from the canonical owner | unmeasured | unmeasured |
| Execution duration | Canonical run timestamps for the fixture task | unmeasured | unmeasured |
| Idle behaviour | Provider calls and processes over a fixed idle window with no client attached | unmeasured | unmeasured |
| Package and process inventory | List of installed packages and running processes in the snapshot, read-only, to find ones the fixture task does not need | unmeasured | unmeasured |
| Log volume | Size of logs written during one run, and whether each log has a bound | unmeasured | unmeasured |
| Repeated downloads | Count and size of network fetches during a second verification or run that repeat the first | unmeasured | unmeasured |
| Keepalive polling | Count of periodic calls from the client or guest while idle | unmeasured | unmeasured |

"Baseline" is the supplied sandbox and the accepted #2 to #4 revisions before any removal. "Post-change" is the same sandbox after one named, reviewed change that removes an unnecessary package or process, an unbounded log, a repeated download or idle polling, as scope item 5 asks. No such change is proposed yet: the last four rows find the candidates. Under the decision recorded for OpenCoven/coven-agents#300 Castles installs nothing, so removals from the snapshot are upstream changes with their own owner. If no change is made, the post-change column stays empty and says so.

Rules for filling this in:

- The 2 vCPU / 4 GiB / 10 GiB figure in #1 is a starting target from a documented pilot, not a measurement of the supplied sandbox.
- State the sample count with every timing. One sample is one sample: no p95, no percentile and no variance claim from it.
- A local timer is an estimate of duration, not an invoice. No cost cap or spend figure is claimed from it.
- No statement about scalability, other resource classes or other sandboxes.
- Inspection calls can affect provider activity tracking, so the number of measurement calls is itself recorded and no polling is left running.

## Open gates and next action

| Gate | Opens when | Decision owner |
| --- | --- | --- |
| Harness wiring (`tests/mvp.test.ts`, `scripts/smoke.ts`) | A maintainer accepts #2's package/test command and binding-result contract at an exact SHA. The maintainer accepted `13ab3bc` on 2026-11-12 (comment linked above), on the basis of a second read, and this harness is built on that revision. This document does not record the standing of the gate: `docs/contracts.md` still calls it closed, and the proposed gate rule (`docs/contracts.md#standing`) is undecided. | Epic maintainer; the #2 steward for `docs/contracts.md` |
| Real read-only inspection | A versioned, authenticated exact-ID seam lands and is accepted at an exact SHA | coven-agents#296 lifecycle owner |
| Run and admission cases | #3 publishes reviewed run/attempt/receipt/cancellation interfaces, including owner audience, exact sandbox binding, read-only permission, familiar-revision admission and bounded input staging | #3 owner; canonical producer maintainers for OpenCoven/coven-agents#297, #298 and #299 |
| Recovery and reuse cases | #4 publishes reviewed observe/export/cancel behaviour, and workspace-preserving containment is qualified | #4 owner; OpenCoven/coven-agents#262 for containment |
| Live qualification | Accepted #2 to #4 revisions, real admission, safe containment, the exact sandbox assignment, and separate explicit provider and spending authorization for a named operator and window | Epic maintainer |
| Stop/start checks | Separate explicit authorization on an exclusively assigned sandbox | Epic maintainer; the canonical lifecycle owner executes |
| Independent R4 review | A genuinely independent reviewer names the exact candidate SHA and its retained evidence | Epic maintainer |

Next executable action: a second read of the exact candidate by a different session, then independent R4 review. The owning upstream maintainers deliver the missing canonical contracts. #5 and the epic stay open; nothing here is merged or accepted without the maintainer's separate decision. 