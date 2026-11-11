# Acceptance notes: one-sandbox MVP

Owned by [#5](https://github.com/OpenCoven/coven-castles/issues/5). Draft.

**State of this document:** offline preparation only. No #5 test exists yet, no
live provider call has been made by anyone, and nothing below is live-verified.
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

Evidence classes, kept separate in every receipt: **fixture** (offline,
synthetic), **real-daemon** (the canonical service with a real database, no
provider), **live-provider** (authorized calls against the one supplied
sandbox). A higher class is never inferred from a lower one.

## Revisions this draft was written against

| Component | Revision | Standing |
| --- | --- | --- |
| Castles `main` | `ce2c4c0a5d9027cfd8191979b7ee9e20c1ae1682` | README only |
| #2 preflight | draft PR #6, head `799488fb7c11400e8d9b71725d14b419191dc978` | Not reviewed, not accepted. Referenced, not consumed. |
| #3 runtime | none | Investigation comment only; no interface |
| #4 recovery | none | Investigation comment only; no interface |
| Canonical source | `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180` | As pinned by #1; private |

The only check this worker ran on another lane's code: a fresh clone of the #2
branch at `799488f`, environment reduced to `HOME` and `PATH`:

| Command | Result | Class |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | pass (warm local store) | n/a |
| `corepack pnpm test` | pass, 42 of 42 | fixture |
| `corepack pnpm typecheck` | pass | static |

Network access was not denied for this reproduction, so it confirms the tests
pass without credentials but does not independently confirm they make no
network call. It is a reproduction, not the maintainer review #2 still needs.

## Qualification matrix

IDs: `G1` to `G6` are the hard release gates in #1. `#N-Ak` is the k-th
acceptance checkbox of issue #N. `#5-Rk` is the k-th acceptance-receipt
checkbox of #5.

### #1 release gates

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| G1 | Exact owner/sandbox and familiar revision binding before task or credential effects | blocked | Sandbox half: #2 fixtures at `799488f`, unreviewed. Familiar-revision half: admission does not carry a familiar root/revision upstream (per #3 investigation). Owner: canonical producer maintainers. |
| G2 | Duplicate submit/reconnect resolves one run; changed-payload reuse conflicts | unverified | No #3 interface. Cases ADM-08 to ADM-10, REC-01, REC-04, REC-06. |
| G3 | Results and receipts retrievable after disconnect or sandbox stop | unverified | No #4 interface. Cases REC-01, REC-05, REC-07, OUT-09. |
| G4 | Cancellation not complete without qualified containment; uncertainty visible and fenced | blocked | No qualified containment upstream; OpenCoven/coven-agents#262 (open). |
| G5 | Second task requires live, non-destructive containment/reuse evidence; `cleanup_required` retained | blocked | No workspace-preserving reuse path upstream; OpenCoven/coven-agents#262. Reported as blocked, not waived. |
| G6 | Two authorized client sessions inspect the same outcome | blocked | No non-browser owner credential for the run routes upstream (per #3 and #4 investigations); not tracked by an upstream issue yet. |

### #2 Bind and preflight

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #2-A1 | Fresh checkout runs offline fixture tests without credentials or network | fixture-only | Reproduced at `799488f` (table above); network denial reported by the #2 worker only. |
| #2-A2 | Missing ID, wrong owner, wrong generation, unknown profile, unsafe lifecycle, public exposure, unavailable provider, mismatched returned ID each fail closed | fixture-only | #2 tests at `799488f`. Not shown live. |
| #2-A3 | Missing sandbox causes zero create/start/update/delete; ambiguous lookup triggers no replacement or adoption | fixture-only | #2 tests at `799488f`. Not shown live. |
| #2-A4 | Read-only checks leave files, processes and provider configuration unchanged; no harness credentials acquired | fixture-only | #2 tests at `799488f`. Provider-side state can only be shown live. |
| #2-A5 | JSON output bounded, redacted, separates source policy from observed metadata | fixture-only | #2 tests at `799488f`. |
| #2-A6 | Contract pins and the owner of every mutation recorded; unknown upstream capability is an explicit blocker | blocked | Recording is fixture-tested; the capability itself is missing: OpenCoven/coven-agents#296 (open). |
| #2-A7 | #3 and #5 receive a reviewed contract/test-command handoff at an exact SHA | blocked | Handoff posted at `799488f`; no maintainer review. Owner: epic maintainer. |

### #3 Bootstrap and run one authorized task

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #3-A1 | Fixture completes through real admission and produces an attributable report with run/attempt references | blocked | No implementation. Upstream gaps listed in the #3 investigation (non-browser audience, familiar revision in admission, binding to a supplied sandbox). |
| #3-A2 | Wrong revision, revoked owner, expired grant, unsupported capability, mismatched sandbox, missing authority refuse before effects | unverified | Cases ADM-01 to ADM-06. |
| #3-A3 | Concurrent submission denied; duplicate returns existing run; changed payload conflicts | unverified | Cases ADM-07 to ADM-10. |
| #3-A4 | Repeated bootstrap does not reinstall, reset or duplicate supervisors | unverified | Cases BST-01 to BST-04. |
| #3-A5 | Execution and output limits enforced outside model instructions | unverified | Cases OUT-01 to OUT-06; run-evidence properties RE-01 to RE-05. |
| #3-A6 | No provider/admin secret in guest configuration, output, artifacts or logs | unverified | Cases RED-01, RED-06, CFG-07. |
| #3-A7 | Source tests and fixtures labelled; a mock does not establish a deployment | unverified | Cases CFG-06, ADM-11. |
| #3-A8 | Reviewed contract references handed to #4/#5 | blocked | Waits on #2-A7, then on #3 implementation and independent R4 review. |

### #4 Recovery, cancellation and reuse

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #4-A1 | Disconnect and lost acknowledgement recover the same run; no duplicate execution | unverified | Cases REC-01, REC-04, REC-06, CAN-06. |
| #4-A2 | Second authorized session sees the same revision, status, receipt and report; others cannot read or cancel | blocked | Receipt and familiar-revision fields absent from the canonical outcome; no non-browser credential (per #4 investigation). |
| #4-A3 | Stop/restart preserves a workspace marker; outcome retrievable with the sandbox unavailable | unverified | Cases REC-05, REC-07. Marker half is live-only and needs separate stop/start authorization. |
| #4-A4 | Cancel races, stale results, expired authorization and ambiguous responses never release an attempt or replay an effect | unverified | Cases CAN-01 to CAN-06. |
| #4-A5 | Second task only after the real containment gate; injected descendant or cleanup failure blocks it | blocked | OpenCoven/coven-agents#262. Refusal side is designable (REU-01 to REU-06); the success side (REU-07) has no passing path upstream. |
| #4-A6 | Bounded, hash-checked export; traversing paths rejected | unverified | Cases OUT-04, OUT-07 to OUT-09, RED-04. |
| #4-A7 | No delete, recreate, destructive reset or authority restoration | unverified | Cases REU-05, REC-06. |
| #4-A8 | #5 receives reviewed revisions, receipts, evidence class and remaining blocker | blocked | Waits on #3-A8, then #4 implementation and independent R4 review. |

### #5 Qualification

| ID | Promise | Status | Evidence or blocker |
| --- | --- | --- | --- |
| #5-R1 | Offline verification passes from a clean checkout without network, secrets or provider mutation | unverified | No #5 test entrypoint exists. Today only the input hashes can be checked (see below). |
| #5-R2 | No live call without explicit opt-in and exact sandbox/budget configuration | unverified | Smoke harness not written. Cases CFG-03 to CFG-05, CFG-08. |
| #5-R3 | Fixture report returned through real admission; two sessions recover the same receipt | blocked | Depends on #3-A1 and #4-A2. |
| #5-R4 | Safe repeat execution proven; retained `cleanup_required` reported as blocked | blocked | OpenCoven/coven-agents#262. |
| #5-R5 | Redacted exact-head evidence with component SHAs, hashes, identities, commands, results, measurements | unverified | Nothing to attest yet. Cases RED-01, RED-02, RED-05. |
| #5-R6 | Failure/unknown states visible; no test bypasses identity, credential, authorization, budget or cleanup enforcement | unverified | Cases CFG-04, CFG-06, REU-04. |
| #5-R7 | Existing user data unchanged; any start/stop specifically authorized; no provision, resize, delete, reset, payment, release or deployment | unverified | No live work performed or authorized. Trivially true so far; not evidence. |
| #5-R8 | README uses only verified claims | unverified | README is #2's file; no #5 quickstart text exists. |
| #5-R9 | Handoff maps each promise to a revision and evidence class, names owners and next action | unverified | This matrix is the draft of that mapping; it has no verified rows to map. |

**Count:** 38 promises. verified 0, fixture-only 5, unverified 20, blocked 13.

## Negative-case catalogue

`fixtures/report-task/negative-cases.json` holds 66 cases. Each names the
release gates and acceptance items it tests and the reviewed contract it waits
on. None has been executed by #5.

| Area | Cases | Release gates | Acceptance items covered |
| --- | --- | --- | --- |
| configuration | 8 (CFG-01 to CFG-08) | G1 | #2-A2, #2-A3, #2-A4, #2-A5, #3-A2, #3-A6, #3-A7, #5-R2, #5-R6, #5-R8 |
| binding | 8 (BND-01 to BND-08) | G1, G5 | #2-A2, #2-A3, #2-A4, #3-A2, #4-A5 |
| admission | 11 (ADM-01 to ADM-11) | G1, G2 | #3-A1, #3-A2, #3-A3, #3-A7, #4-A1, #5-R3, #5-R8 |
| bootstrap | 4 (BST-01 to BST-04) | none directly | #2-A4, #3-A4, #5-R7 |
| bounded outputs | 9 (OUT-01 to OUT-09) | G3, G4 | #3-A5, #4-A6 |
| reconnect | 7 (REC-01 to REC-07) | G2, G3, G6 | #4-A1, #4-A2, #4-A3, #4-A7, #5-R3, #5-R7 |
| cancellation | 6 (CAN-01 to CAN-06) | G3, G4, G6 | #4-A1, #4-A2, #4-A4 |
| redaction | 6 (RED-01 to RED-06) | none directly | #2-A5, #3-A6, #4-A6, #5-R5 |
| reuse refusal | 7 (REU-01 to REU-07) | G4, G5 | #4-A5, #4-A7, #5-R4, #5-R6, #5-R7, #5-R9 |

Six items have no negative case because they are positive or process
obligations rather than refusals: #2-A1 and #5-R1 (offline pass from a clean
checkout), #2-A6 (pins recorded), and the three handoff items #2-A7, #3-A8 and
#4-A8.

## What can be checked today

Only that the fixture input and task text are the committed bytes:

```sh
(cd fixtures/report-task/input && shasum -a 256 -c ../input.SHA256SUMS)
(cd fixtures/report-task && shasum -a 256 -c task.SHA256SUMS)
```

Result at this revision: 5 of 5 input files and the task text verify. This is
an integrity check on test input, not acceptance evidence.

The expected-report properties were exercised once with a throwaway script that
is not committed: the passing sample satisfied all 14 text properties and each
failing sample failed exactly the properties it declares. That check becomes
part of `tests/mvp.test.ts` when the wiring gate opens; until then treat it as
a contributor's note, not a receipt.

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
| Peak process memory | Sampled inside the attempt for the fixture task | unmeasured | unmeasured |
| Disk growth per run | Workspace and runtime directory size before and after one run | unmeasured | unmeasured |
| Provider-call count | Counted at the client seam for check, run, observe, cancel, export | unmeasured | unmeasured |
| Execution duration | Canonical run timestamps for the fixture task | unmeasured | unmeasured |
| Idle behaviour | Provider calls and processes over a fixed idle window with no client attached | unmeasured | unmeasured |

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
| Run and admission cases | #3 publishes reviewed run/attempt/receipt/cancellation interfaces | #3 owner; canonical producer maintainers for the upstream gaps |
| Recovery and reuse cases | #4 publishes reviewed observe/export/cancel behaviour | #4 owner; OpenCoven/coven-agents#262 for containment |
| Live qualification | Accepted #2 to #4 revisions, real admission, safe containment, the exact sandbox assignment, and separate explicit provider and spending authorization for a named operator and window | Epic maintainer |
| Stop/start checks | Separate explicit authorization on an exclusively assigned sandbox | Epic maintainer |
