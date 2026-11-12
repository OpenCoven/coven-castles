# Acceptance notes: one-sandbox MVP

Owned by [#5](https://github.com/OpenCoven/coven-castles/issues/5). Draft.

**State of this document:** offline preparation only. No #5 test exists yet.
The #5 lane has made no live provider call, and no code in this repository can
make one. Nothing below is live-verified. Real-provider runs recorded upstream
(for example in OpenCoven/coven-agents#262) are upstream evidence about
upstream code; they are not evidence for any row here.
This is not a quickstart; the quickstart is drafted only after there is tested
behaviour to describe.

## How to read a status

Each promise has exactly one status.

| Status | Meaning |
| --- | --- |
| **verified** | Shown against the real daemon or the real provider at an exact revision, with a retained receipt, and independently reviewed. Nothing has this status today. |
| **fixture-only** | An offline test with synthetic input passes at an exact revision. Says nothing about the real provider or real admission. |
| **unverified** | No executable evidence. Includes everything designed but not run. |
| **blocked** | Cannot be shown until a named capability or decision exists. The blocker and its owner are stated. |

The Promise column abbreviates each item. The wording in the issue is the
obligation: [#1](https://github.com/OpenCoven/coven-castles/issues/1) for G1 to
G6, and the acceptance list of
[#2](https://github.com/OpenCoven/coven-castles/issues/2),
[#3](https://github.com/OpenCoven/coven-castles/issues/3),
[#4](https://github.com/OpenCoven/coven-castles/issues/4) and
[#5](https://github.com/OpenCoven/coven-castles/issues/5) for the rest.

Evidence classes, kept separate in every receipt: **fixture** (offline,
synthetic), **real-daemon** (the canonical service with a real database, no
provider), **live-provider** (authorized calls against the one supplied
sandbox). A higher class is never inferred from a lower one.

## Revisions this draft was written against

| Component | Revision | Standing |
| --- | --- | --- |
| Castles `main` | `96e19cea81624572b65149116b339ee39dbec61d` | README and secret scanning only |
| #2 preflight | draft PR #6, head `13ab3bc2c823fe12b482a6701ab4df2c28e6733c` | Proposed. Reviewed at this head by `rv6c-3db7f9d0` with no blocking findings and seven non-blocking ones; that review calls itself a second read, not the independent R4 review #1 requires. Not accepted by the maintainer. Referenced, not consumed. |
| #3 runtime | none | Investigation comment only; no interface |
| #4 recovery | none | Investigation comment only; no interface |
| Canonical source | `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180` | As pinned by #1; private |

PR #6 can move after this is written. Check its current head and reviews
before relying on this table. Every #2 line in this document was refreshed
against `13ab3bc` on 2026-11-12; the earlier run at `7ead0d8` (58 of 58) is
superseded and is no longer cited.

The only check this lane ran on another lane's code: a fresh clone of PR #6 at
`13ab3bc`, environment reduced to `HOME` and `PATH`, Node 24.22.0, macOS arm64:

| Command | Result | Class |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | exit 0 (warm local store) | n/a |
| `corepack pnpm test` | exit 0: 93 tests, 92 pass, 0 fail, 1 skipped; IP networking denied | fixture |
| `corepack pnpm typecheck` | exit 0; IP networking denied | static |
| `corepack pnpm check --fixture fixtures/preflight/cases/ready.json` | `status: ready`, `evidence: FIXTURE`, exit 3; IP networking denied | fixture |

IP networking was denied for `test`, `typecheck` and `check` with a macOS
`sandbox-exec` profile that refuses outbound and inbound IP traffic; a `curl`
to a public registry under the same profile could not connect. The install
step used a warm local package store. The working tree of the clone was
unchanged after the runs. The one skipped test is #2's own control that a
planted network connection fails: Node 24.22.0 has no network permission, so
on this version "without network" rests on the profile above, not on #2's
suite. Exit 3 is #2's code for a fixture result, which is never readiness.
This is a reproduction, not the independent review or the maintainer
acceptance #2 still needs.

## Qualification matrix

IDs: `G1` to `G6` are the hard release gates in #1. `#N-Ak` is the k-th
acceptance checkbox of issue #N. `#5-Rk` is the k-th acceptance-receipt
checkbox of #5.

Where a row names cases, it names every catalogue case mapped to that item.
Where it names none, the mapping is in the `tests`, `releaseGates` and `scope`
fields of `fixtures/report-task/negative-cases.json`. Eleven cases carry
`scope`, which names a scope rule that has no checkbox; for four of them
(CFG-09, OUT-01 to OUT-03) it is the only mapping.

### #1 release gates

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| G1 | Exact owner/sandbox and familiar revision binding before task or credential effects | blocked | Sandbox half: #2 fixtures at `13ab3bc`, reviewed with no blocking findings, not accepted; binding a run to the supplied sandbox is OpenCoven/coven-agents#298 (open). Familiar-revision half: admission does not carry a familiar root/revision upstream (per the #3 investigation; no upstream issue found). Owner: canonical producer maintainers. |
| G2 | Duplicate submit/reconnect resolves one run; changed-payload reuse conflicts | unverified | No #3 interface. Cases ADM-08 to ADM-10, OUT-12, REC-01, REC-04, REC-06. |
| G3 | Results and receipts retrievable after disconnect or sandbox stop | unverified | No #4 interface. Cases REC-01, REC-05, REC-07, CAN-06. |
| G4 | Cancellation not complete without qualified containment; uncertainty visible and fenced | blocked | No qualified containment upstream; OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. |
| G5 | Second task requires live, non-destructive containment/reuse evidence; `cleanup_required` retained | blocked | No workspace-preserving reuse path upstream; OpenCoven/coven-agents#262 (open). Reported as blocked, not waived. Owner: canonical producer maintainers. |
| G6 | Two authorized client sessions inspect the same outcome. Unsupported mobile mutation remains unavailable | blocked | No non-browser owner credential for the run routes upstream: OpenCoven/coven-agents#297 (open, undecided). Owner: canonical producer maintainers. Cases REC-02, REC-03, REC-08, CAN-04. |

### #2 Bind and preflight

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #2-A1 | Fresh checkout runs offline fixture tests without credentials or network | fixture-only | Reproduced at `13ab3bc`: offline install, then 92 pass, 0 fail, 1 skipped of 93 with `HOME` and `PATH` only and IP networking denied (table above). The skipped test is the network control, so the network half rests on this lane's profile. |
| #2-A2 | Missing ID, wrong owner, wrong generation, unknown profile, unsafe lifecycle, public exposure, unavailable provider, mismatched returned ID each fail closed | fixture-only | At `13ab3bc` the eight tests `fail-closed fixture: missing-id`, `wrong-owner`, `wrong-generation`, `unknown-profile`, `unsafe-lifecycle`, `public-exposure`, `unavailable-provider` and `mismatched-returned-id` pass, one per named condition, with seven more fail-closed fixtures. Not shown live. |
| #2-A3 | Missing sandbox causes zero create/start/update/delete; ambiguous lookup triggers no replacement or adoption | fixture-only | At `13ab3bc` the tests "a missing sandbox causes zero create/start/update/delete calls", "an ambiguous lookup triggers no replacement, adoption, or second lookup" and "a substituted sandbox is never adopted and its metadata is not disclosed" pass. Not shown live. |
| #2-A4 | Read-only checks leave files, processes and provider configuration unchanged; no harness credentials acquired | fixture-only | At `13ab3bc` the tests "CLI check is read-only, credential-blind, and emits human and JSON output", "a stopped sandbox is reported as stopped and is never woken", the capability scan over `src/` and the run with writes, child processes and workers denied pass. #2's tests call the scan a tripwire, not a proof, and review `rv6c-3db7f9d0` (R2) shows it does not stop a read of another environment variable; that review confirms by reading `src/` that the code does none. Provider-side state can only be shown live. |
| #2-A5 | JSON output bounded, redacted, separates source policy from observed metadata | fixture-only | At `13ab3bc` the tests "JSON output separates source policy from observed metadata", "output uses redacted aliases, never the configured private IDs", "JSON output stays bounded and clean under hostile provider metadata", "no echoed field can carry the configured IDs or free text into output" and "every string in observed output is drawn from a fixed vocabulary" pass. Open non-blocking finding R1 of `rv6c-3db7f9d0`: integer fields are echoed unbounded, so an all-digit configured ID returned in a numeric field would reach output. |
| #2-A6 | Contract pins and the owner of every mutation recorded; unknown upstream capability is an explicit blocker | fixture-only | The item asks for the record, and at `13ab3bc` the tests "source pins are exact repo@sha:path references", "every provider mutation names its existing upstream owner, and none is Castles" and "the missing upstream binding seam is an explicit blocker with a link" pass (OpenCoven/coven-agents#296, open). The capability being absent is what blocks live rows, not this one. |
| #2-A7 | #3 and #5 receive a reviewed contract/test-command handoff at an exact SHA; fixture paths do not overlap and shared-file ownership is recorded | blocked | PR #6 at `13ab3bc` has a second-read review with no blocking findings; it is not the independent R4 review and the contract is not accepted. Fixture paths do not overlap (`fixtures/preflight/`, `fixtures/report-task/`). Owner: epic maintainer. |

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
| #5-R1 | Offline verification passes from a clean checkout without network, secrets or provider mutation | unverified | No #5 test entrypoint exists. Today only the input hashes can be checked (see below). |
| #5-R2 | No live call without explicit opt-in and exact sandbox/budget configuration | unverified | Smoke harness not written. Cases CFG-03 to CFG-05, CFG-08, OUT-13. |
| #5-R3 | Fixture report returned through real admission; two sessions recover the same receipt without duplicate work | blocked | Depends on #3-A1 and #4-A2 and their owners. Cases ADM-11, REC-02. |
| #5-R4 | Safe repeat execution proven; retained `cleanup_required` reported as blocked | blocked | OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. Cases REU-01, REU-06, REU-07. |
| #5-R5 | Redacted exact-head evidence with Castles and canonical component SHAs, package hashes, SDK/image identities, environment, commands, pass/fail/skip, measurements and unresolved limitations; actual sandbox identifiers and private artifacts stay out of public issues and logs | unverified | Nothing to attest yet. Cases RED-01, RED-02, RED-05. |
| #5-R6 | Failure/unknown states visible; no test bypasses identity, credential, authorization, budget or cleanup enforcement | unverified | Cases CFG-04, CFG-06, REU-04. |
| #5-R7 | Existing user data unchanged; any start/stop specifically authorized; no provision, resize, delete, reset, payment, release or deployment | unverified | No live work performed or authorized. Trivially true so far; not evidence. Cases CFG-10, BST-04, REC-07, REU-05, REU-08. |
| #5-R8 | README uses only verified claims; a fixture pass does not mean live acceptance, and a one-shot live result does not mean the repeatable MVP is ready | unverified | README is #2's file; no #5 quickstart text exists. Case ADM-11 covers labelling only. |
| #5-R9 | Handoff maps each promise to a revision and evidence class, names owners and next action; unimplemented or skipped live checks remain unverified, never silently green | unverified | This matrix is the draft of that mapping; it has no verified rows to map. Case REU-06. |

**Count:** 38 promises. verified 0, fixture-only 6, unverified 20, blocked 12.
All six fixture-only rows are #2 rows, re-run at `13ab3bc`.

## Negative-case catalogue

`fixtures/report-task/negative-cases.json` holds 76 cases. Each names the
release gates, acceptance items and scope rules it bears on and the reviewed
contract it waits on. None has been executed by #5. One passing case never
establishes a checkbox by itself.

Thirteen cases carry a `basis` field: part of their expectation goes beyond
what #1 to #5 say and is #5's proposal to the lane that owns the contract
(ADM-03, ADM-06, ADM-07, ADM-10, OUT-04, OUT-08, OUT-10 to OUT-13, REC-03,
REC-05, RED-02). That lane's reviewed contract decides them.

Nineteen cases name "#2 binding/preflight contract (proposed, not accepted:
draft PR #6)" in `dependsOn`. That wording is still true at `13ab3bc`: the
contract has been reviewed with no blocking findings and has not been
accepted. The catalogue file is unchanged. CFG-07 and BND-06 were re-read
against the rules of `13ab3bc` and their expectations are unchanged, because
they still agree with it: CFG-07 expects a secret in the client environment
not to be read or echoed, and BND-06 expects `incompatible`, which is what
`13ab3bc` reports for public exposure, an unsafe lifecycle, unrestricted
egress, an unsafe allow list and missing metadata (which includes an
architecture outside the known set). Neither case has been executed by #5. The
catalogue does not restate #2's finer rules (the ten-entry cap on a network
allow list, the fixed vocabulary for echoed fields, client-derived evidence);
#2's own tests carry those.

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

Six items have no case because they are positive or process obligations
rather than refusals: #2-A1 and #5-R1 (offline pass from a clean checkout),
and the three handoff items #2-A7, #3-A8 and #4-A8. #2-A6 (pins recorded) has
none either; #2's own tests cover it.

Items with only one case, which is not enough to carry them:

- #3-A1 has only ADM-11, a labelling case. The item is a positive one: a real
  admitted run. No catalogue case can stand in for it.
- #5-R8 has only ADM-11, and #5-R9 has only REU-06. Both are about what the
  final documents say and are checked by reading them at the exact head.

Rules in #1 and #5 with no case, recorded as a decision rather than left
silent:

- "No local model, desktop/VNC, browser automation or swarm" (#1): nothing in
  the client can start one, and there is no surface to search until #3
  publishes its runtime manifest. To be added against that manifest.
- "Run tests against production user data" (#5 scope 2): CFG-10 covers the
  path side. Whether data is production data cannot be decided by a test; it
  is an operator authorization recorded in the live handoff.

## What can be checked today

Only that the fixture input and task text are the committed bytes, with
nothing added:

```sh
[ ! -L fixtures/report-task/input ] && (cd fixtures/report-task/input \
  && [ "$(find . ! -type d | sed 's|^\./||' | LC_ALL=C sort)" = "$(sed 's/^[0-9a-f]\{64\}  //' ../input.SHA256SUMS)" ] \
  && [ -z "$(find . -type l)" ] \
  && shasum -a 256 -c ../input.SHA256SUMS)
(cd fixtures/report-task && shasum -a 256 -c task.SHA256SUMS)
```

Result at this revision: the first command prints five `OK` lines and exits
`0`; the task text verifies. In a scratch copy the first command exits `1` for
an added file (including names with a space, a newline or a leading dash), an
added symlink (dangling, to a directory or to a file), a removed file, a
changed file, a file replaced by a symlink or a directory, and a symlinked
input root. It does not detect an added empty directory or a changed file
mode; `fixtures/report-task/README.md` says why. This is an integrity check on
test input, not acceptance evidence.

The expected-report properties were exercised with a throwaway script that is
not committed. It follows the `parsing` rules (revision 2) in
`expected/report-properties.json`. Result at this revision: 18 text
properties; the 3 passing files, the 6 failing files and the 136 generated
recipes each gave exactly their declared result (145 of 145). That check
becomes part of `tests/mvp.test.ts` when the wiring gate opens; until then
treat it as a contributor's note, not a receipt.

The properties are heuristics, and the fixture says where they are wrong: 27
of the recipes carry `knownLimit` and pin a result that is not the right one,
19 reports that should be rejected and pass, 8 correct reports that fail. The
classes are listed under Limits in `fixtures/report-task/README.md`. No text
property can decide whether a diagnosis is right or whether text is visible to
a reader, and the secret patterns are a secondary net behind the seeded-value
check RE-06, which is unverified. A report is read by a person before it is
counted.

## Measurement plan

Scope item 5 of #5. Every value is **unmeasured**. No number may be entered
without the exact sandbox profile, revision, command and sample count beside
it, and none may be entered from a fixture run.

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

"Baseline" is the supplied sandbox and the accepted #2 to #4 revisions before
any removal. "Post-change" is the same sandbox after one named, reviewed change
that removes an unnecessary package or process, an unbounded log, a repeated
download or idle polling, as scope item 5 asks. No such change is proposed yet:
the last four rows find the candidates. Under the decision recorded for
OpenCoven/coven-agents#300 Castles installs nothing, so removals from the
snapshot are upstream changes with their own owner. If no change is made, the
post-change column stays empty and says so.

Rules for filling this in:

- The 2 vCPU / 4 GiB / 10 GiB figure in #1 is a starting target from a
  documented pilot, not a measurement of the supplied sandbox.
- State the sample count with every timing. One sample is one sample: no p95,
  no percentile and no variance claim from it.
- A local timer is an estimate of duration, not an invoice. No cost cap or
  spend figure is claimed from it.
- No statement about scalability, other resource classes or other sandboxes.
- Inspection calls can affect provider activity tracking, so the number of
  measurement calls is itself recorded and no polling is left running.

## Open gates

| Gate | Opens when | Decision owner |
| --- | --- | --- |
| Harness wiring (`tests/mvp.test.ts`, `scripts/smoke.ts`) | A maintainer accepts #2's package/test command and binding-result contract at an exact SHA | #2 assignee, epic maintainer |
| Run and admission cases | #3 publishes reviewed run/attempt/receipt/cancellation interfaces | #3 owner; canonical producer maintainers for OpenCoven/coven-agents#297, #298 and #299 |
| Recovery and reuse cases | #4 publishes reviewed observe/export/cancel behaviour | #4 owner; OpenCoven/coven-agents#262 for containment |
| Live qualification | Accepted #2 to #4 revisions, real admission, safe containment, the exact sandbox assignment, and separate explicit provider and spending authorization for a named operator and window | Epic maintainer |
| Stop/start checks | Separate explicit authorization on an exclusively assigned sandbox | Epic maintainer |
