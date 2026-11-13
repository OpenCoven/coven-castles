# Acceptance notes: one-sandbox MVP

Owned by [#5](https://github.com/OpenCoven/coven-castles/issues/5). This revision wires executable offline qualification. No real daemon, model, harness task or provider was run. No live readiness, admission, cancellation, containment or safe reuse is established.

## Consumed revisions and standing

- Castles base: `b5d7fc14add09fa94a7103031d7d625f710e519c`.
- #2 profile/binding/client contract and offline test command: **accepted** at `13ab3bc2c823fe12b482a6701ab4df2c28e6733c`, recorded in the [maintainer acceptance](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865). PR #6 is merged. This explicit decision supersedes the older closed-gate descriptions in `docs/contracts.md` and the unchanged fixture catalogue.
- #7 fixture corpus: `302bb4533aaccde8165d8efe596502da286891b0`, merged by PR #7. All fixture bytes, expectations, regexes and proposed limits are unchanged. Merge does not decide the outstanding fixture-limit or review-independence proposals.
- Canonical source pins remain `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180`; no new canonical client or authority interface is introduced.

The implementation and documentation candidate's exact SHA, fresh-checkout commands, terminal results, reviewer provenance and retained evidence belong in the linked #5 handoff and PR. Verification receipts apply only to that SHA. This document does not claim a later head was tested.

## Evidence and current commands

`corepack pnpm test` discovers `tests/mvp.test.ts` through the existing runner. It checks the exact task/input inventory and SHA-256 sums, inclusive manifest bounds, UTF-8 and path refusals; applies parsing revision 3 and all 18 text properties; checks all nine report files and 201 generated recipes against their exact expected failure sets; exercises the accepted preflight API; and runs the refusal-only smoke subprocesses with a five-second deadline. A separate bounded verification runner must impose a hard deadline on the entire suite, because a Node test timeout cannot interrupt a synchronous regex.

The report checker is test-local synthetic conformance code. It is not an operator report validator, a canonical result contract, a semantic diagnosis oracle, or a proof of runtime enforcement. All six `onRunEvidence` properties (RE-01 to RE-06) remain blocked on #3/#4. Runtime canaries in the smoke/preflight tests check only those client surfaces; they do not implement RE-06's guest, report, artifact and export checks.

The 64 recipes tagged `knownLimit` are reported by name: 40 false accepts and 24 false rejections. A green corpus check means those declared limitations were reproduced, not fixed. A human still reads a report before it is counted. The existing README describes the limitations and outstanding maintainer decisions.

| Command | Expected terminal result | Class and limit |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | Exit 0 from a warm package store | Setup; not offline execution evidence and not a cold-store claim |
| `corepack pnpm test` | Exit 0; all new tests pass | fixture; retain every existing skip in the receipt |
| `corepack pnpm typecheck` | Exit 0 | static; the test's import includes `scripts/smoke.ts` without changing tsconfig |
| `corepack pnpm check --fixture fixtures/preflight/cases/ready.json` | Exit 3, synthetic ready | fixture; never readiness |
| `node --import tsx scripts/smoke.ts` | Exit 1, `explicit_opt_in_required` | refusal-only; evidence none, zero provider calls |
| `gitleaks git --redact --no-banner .` | Exit 0, no findings | static secret scan; not a proof that arbitrary future output is safe |

Fresh-checkout verification removes inherited credentials and denies outbound and inbound IP networking at the OS level, with an allowed/denied local TCP control. Record the exact OS profile and commands in the retained receipt. Dependency installation is a separate step. Node 24.22.0 lacks the Node network-permission option, so #2's existing network-control test remains skipped on that version; the OS control supplies separate evidence rather than relabeling the skip.

## Smoke refusal contract

`scripts/smoke.ts` supports only `--live --sandbox-id <exact-id> --max-spend-usd <positive-decimal> --max-seconds <1..900>`. These are local validation inputs, never authorization. Spend accepts a positive decimal with at most six integer digits and two fractional digits. Seconds are canonical positive integers, at most 900. Missing opt-in, budgets, binding or target, invalid budgets, duplicate options, a different target, and unsupported arguments all refuse. Negative option values can be passed unambiguously using `--max-spend-usd=-1` or `--max-seconds=-1` and also refuse.

Even fully populated inputs return `canonical_capabilities_unavailable`. Every CLI outcome exits 1 and emits bounded JSON with schema `castles.smoke-refusal.v1`, status `blocked`, evidence `none`, a fixed reason, and `providerCalls: 0`. There is no success branch, endpoint, provider client, credential lookup, local env-file loading, fixture fallback, workspace write, or lifecycle operation. Only the four existing binding environment keys are consumed. Fixture/mock/reset/cleanup-bypass/directory options are unsupported; setting an authorization-looking or fixture environment variable cannot open execution. No real owner credential is validated here because its canonical contract is unavailable.

This is an operator-visible refusal boundary, not the requested live qualification harness. #296, #3 and #4 must supply accepted capabilities before any execution implementation, and a named provider window and spend authorization are still required. Do not invent an authentication format to get past the refusal.

## Qualification matrix

Each original promise remains in the matrix. `verified` requires independently reviewed real-daemon or live-provider evidence at an exact SHA; **zero rows are verified**. `fixture-only` records only the stated synthetic or client-refusal scope. `unverified` and `blocked` are not silently green. The issue's complete wording is authoritative.

| ID | Promise | Status | Evidence or remaining gate |
| --- | --- | --- | --- |
| G1 | Exact owner/sandbox and familiar revision binding before task or credential effects | blocked | #2 is accepted; dispatch binding still needs coven-agents#298 and canonical familiar-revision admission. Owner: #3 and canonical maintainers. |
| G2 | Duplicate submit/reconnect resolves one run; changed-payload reuse conflicts | unverified | No #3 interface. Cases ADM-08 to ADM-10, OUT-12, REC-01, REC-04, REC-06. |
| G3 | Results and receipts retrievable after disconnect or sandbox stop | unverified | No #4 interface. Cases REC-01, REC-05, REC-07, CAN-06. |
| G4 | Cancellation not complete without qualified containment; uncertainty visible and fenced | blocked | Qualified containment remains coven-agents#262. Owner: canonical maintainers; no live evidence here. |
| G5 | Second task requires live, non-destructive containment/reuse evidence; `cleanup_required` retained | blocked | Workspace-preserving containment and safe second-run evidence remain coven-agents#262. A cleanup fence stays held. |
| G6 | Two authorized client sessions inspect the same outcome. Unsupported mobile mutation remains unavailable | blocked | No non-browser owner credential for the run routes upstream: OpenCoven/coven-agents#297 (open, undecided). Owner: canonical producer maintainers. Cases REC-02, REC-03, REC-08, CAN-04. |
| #2-A1 | Fresh checkout runs offline fixture tests without credentials or network | fixture-only | Existing preflight suite plus new MVP suite; fresh-checkout receipt names the exact candidate and OS IP-network control. |
| #2-A2 | Missing ID, wrong owner, wrong generation, unknown profile, unsafe lifecycle, public exposure, unavailable provider, mismatched returned ID each fail closed | fixture-only | CFG-01/02 and BND fixture tests call the accepted runPreflight API with a tripwire inspection client. No provider evidence. |
| #2-A3 | Missing sandbox causes zero create/start/update/delete; ambiguous lookup triggers no replacement or adoption | fixture-only | BND-03/04/05 assert exact requests and zero mutation/fallback capability accesses. |
| #2-A4 | Read-only checks leave files, processes and provider configuration unchanged; no harness credentials acquired | fixture-only | Existing #2 confinement tests and new smoke refusal/source inspection. Provider-side unchanged state and guest effects remain unverified. |
| #2-A5 | JSON output bounded, redacted, separates source policy from observed metadata | fixture-only | BND-09 RED-02 RED-03 assert aliases, fixed errors and bounded output. Accepted #2 R1 remains open: numeric fields can echo all-digit IDs. |
| #2-A6 | Contract pins and the owner of every mutation recorded; unknown upstream capability is an explicit blocker | fixture-only | #2 source-pin tests remain unchanged; upstream inspection capability is still blocked on coven-agents#296. |
| #2-A7 | #3 and #5 receive a reviewed contract/test-command handoff at an exact SHA; fixture paths do not overlap and shared-file ownership is recorded | fixture-only | Accepted exact-SHA handoff is linked above and consumed by the harness. Shared files and fixture paths are unchanged; no downstream live gate is opened. |
| #3-A1 | Fixture completes through real admission and produces an attributable report with run/attempt references | blocked | No real admitted workflow. Needs #3 and coven-agents#297/#298/#299, familiar-revision admission and bounded data staging. Owner: canonical maintainers, then #3. |
| #3-A2 | Wrong revision, revoked owner, expired grant, unsupported capability, mismatched sandbox, missing authority refuse before effects | unverified | Cases ADM-01 to ADM-06, CFG-08. |
| #3-A3 | Concurrent submission denied; duplicate returns existing run; changed payload conflicts | unverified | Cases ADM-07 to ADM-10, OUT-12. |
| #3-A4 | Runtime verification against the pinned manifest is repeatable and mutates nothing; a snapshot, harness or contract mismatch reports incompatible (reworded on #3, 2026-11-11, after the decision recorded for OpenCoven/coven-agents#300) | unverified | Cases BST-01 to BST-04, rewritten for verification only. |
| #3-A5 | Execution and output limits enforced outside model instructions | unverified | Cases OUT-04 to OUT-06, OUT-10, OUT-13; run-evidence properties RE-01 to RE-05. OUT-01 to OUT-03 test #3 scope item 5 (input staged as bounded data), which has no checkbox. |
| #3-A6 | No provider/admin secret in guest configuration, output, artifacts or logs | unverified | Cases RED-01, RED-06, CFG-07. Primary check is the seeded-value property RE-06; the text patterns RP-11 to RP-14 are a secondary net. |
| #3-A7 | Source tests and fixtures labelled; a mock does not establish a deployment | unverified | Cases CFG-06, ADM-11. |
| #3-A8 | Reviewed contract references handed to #4/#5 | blocked | #2 acceptance is complete. Still requires #3 run/attempt/receipt/cancellation interfaces and independent R4 review at an exact revision. |
| #4-A1 | Disconnect and lost acknowledgement recover the same run; no duplicate execution | unverified | Cases ADM-08, OUT-12, REC-01, REC-04, REC-06, CAN-06. |
| #4-A2 | Second authorized session sees the same revision, status, receipt and report; others cannot read or cancel | blocked | Receipt and familiar-revision fields absent from the canonical outcome (per the #4 investigation; no upstream issue found); no non-browser credential (OpenCoven/coven-agents#297, open). Owner: canonical producer maintainers. Cases REC-02, REC-03, CAN-04. |
| #4-A3 | Stop/restart preserves a workspace marker; outcome retrievable with the sandbox unavailable | unverified | Cases REC-05, REC-07, REU-08. Marker half is live-only and needs separate stop/start authorization. |
| #4-A4 | Cancel races, stale results, expired authorization and ambiguous responses never release an attempt or replay an effect | unverified | Cases CAN-01 to CAN-06. |
| #4-A5 | Second task only after the real containment gate; injected descendant or cleanup failure blocks it | blocked | OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. Refusal side is designable (BND-08, REU-01 to REU-04); the success side (REU-07) has no passing path upstream. |
| #4-A6 | Bounded, hash-checked export; traversing paths rejected | unverified | Cases OUT-04, OUT-07 to OUT-09, OUT-11, RED-04. |
| #4-A7 | No delete, recreate, destructive reset or authority restoration | unverified | Cases REU-05, REU-09, REC-06. |
| #4-A8 | #5 receives reviewed revisions, receipts, evidence class and remaining blocker | blocked | Waits on #3-A8, then #4 implementation and independent R4 review. Owner: the #3 owner, then the #4 owner. |
| #5-R1 | Offline verification passes from a clean checkout without network, secrets or provider mutation | fixture-only | The executable entrypoint is corepack pnpm test. Fresh-checkout, minimal-environment, OS IP-denied results are retained with the candidate handoff. |
| #5-R2 | No live call without explicit opt-in and exact sandbox/budget configuration | fixture-only | Current smoke always refuses before effects, including fully populated inputs. Real authorization validation and an executable live harness remain unavailable. |
| #5-R3 | Fixture report returned through real admission; two sessions recover the same receipt without duplicate work | blocked | Depends on #3-A1 and #4-A2 and their owners. Cases ADM-11, REC-02. |
| #5-R4 | Safe repeat execution proven; retained `cleanup_required` reported as blocked | blocked | OpenCoven/coven-agents#262 (open). Owner: canonical producer maintainers. Cases REU-01, REU-06, REU-07. |
| #5-R5 | Redacted exact-head evidence with Castles and canonical component SHAs, package hashes, SDK/image identities, environment, commands, pass/fail/skip, measurements and unresolved limitations; actual sandbox identifiers and private artifacts stay out of public issues and logs | unverified | Nothing to attest yet. Cases RED-01, RED-02, RED-05. |
| #5-R6 | Failure/unknown states visible; no test bypasses identity, credential, authorization, budget or cleanup enforcement | unverified | Cases CFG-04, CFG-06, REU-04. |
| #5-R7 | Existing user data unchanged; any start/stop specifically authorized; no provision, resize, delete, reset, payment, release or deployment | unverified | No live work performed or authorized. Trivially true so far; not evidence. Cases CFG-10, BST-04, REC-07, REU-05, REU-08. |
| #5-R8 | README uses only verified claims; a fixture pass does not mean live acceptance, and a one-shot live result does not mean the repeatable MVP is ready | unverified | README is #2's file; no #5 quickstart text exists. Case ADM-11 covers labelling only. |
| #5-R9 | Handoff maps each promise to a revision and evidence class, names owners and next action; unimplemented or skipped live checks remain unverified, never silently green | unverified | This matrix is documentation. Catalogue ID completeness and nonempty coverage/dependency descriptions are checked by the suite; the claims themselves require review. Final exact-SHA handoff and independent acceptance remain separate process evidence. |

## Catalogue coverage

Every one of the 76 catalogue IDs is listed once; the suite asserts this map stays complete. This table is coverage metadata, not executed behavior. Executable partial checks are described by test name or property ID, with the missing remainder alongside them. The unchanged catalogue's older descriptions of #2 as unaccepted are superseded by the linked acceptance; no unreviewed #3/#4 contract is substituted.

| Case | Executable evidence in this slice | Remaining dependency or limitation |
| --- | --- | --- |
| CFG-01 | CFG-01 accepted preflight test: missing ID, zero inspection accesses. | Real provider inspection remains coven-agents#296; fixture result only. |
| CFG-02 | CFG-02 accepted preflight test: unsupported profile, zero inspection accesses. | Real provider inspection remains coven-agents#296; fixture result only. |
| CFG-03 | CFG-03 smoke subprocess: absent explicit opt-in refuses. | No live path exists; enabling one needs accepted #3/#4 and named authorization. |
| CFG-04 | CFG-04 smoke subprocesses: missing/zero/negative/noncanonical budgets refuse. | An invoice-level or admitted runtime budget is not implemented; canonical #3 enforcement is required. |
| CFG-05 | CFG-05 smoke subprocesses: missing/different exact target refuses. | Canonical dispatch binding still requires coven-agents#298 and #3. |
| CFG-06 | CFG-06 flags refuse; CFG-08 fixture environment cannot open a fallback; ADM-11 denies fixture readiness. | No fixture execution mode exists here; real-admission evidence still needs #3. |
| CFG-07 | CFG-07 proxy catches unrelated environment reads; subprocess canaries never appear in output. | Guest credential custody and RE-06 need #3/#4; this proves only the smoke client surface. |
| CFG-08 | CFG-08 missing/forged authorization-looking inputs always refuse. | No real expired/revoked owner credential is tested; canonical audience remains coven-agents#297 and #3. |
| CFG-09 | Existing #2 source tripwire and static review of refusal-only smoke imports. | No #3 runtime surface exists to inspect. Static tripwires are not universal capability proofs. |
| CFG-10 | CFG-10 directory argument refuses and a synthetic existing file is byte-identical. | No dedicated guest test-directory staging exists until #3; no workspace traversal/write is implemented. |
| BND-01 | BND-01 accepted preflight fixture tests assert exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-02 | BND-02 accepted preflight fixture tests assert exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-03 | BND-03 accepted preflight fixture tests assert exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-04 | BND-04 accepted preflight fixture tests assert exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-05 | BND-05 accepted preflight fixture tests assert exact target and inspection-only access. | Live owner/identity/lifecycle inspection requires coven-agents#296; no fixture grants authority. |
| BND-06 | BND-06 preflight fixtures: public, unsafe lifecycle, absent metadata, unrestricted/allow-all egress. | No live inspection; five unexamined provider fields remain accepted #2 follow-up R3. The full ephemeral/provider predicate is not certified. |
| BND-07 | BND-07 preflight fixture reports stopped and uses only inspection. | Run refusal on a stopped bound sandbox requires #3 and coven-agents#298. |
| BND-08 | BND-08 unresolved-attempt fixture reports reconciliation-required. | Unrelated active-workload admission and containment need #3/#4 and coven-agents#262. |
| BND-09 | BND-09 synthetic unavailable, thrown error, deadline and hostile malformed response tests. | No live response or generalized provider-size defense is proved; coven-agents#296 owns inspection. |
| ADM-01 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found). Owner: #3 and canonical maintainers. |
| ADM-02 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-03 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found). Owner: #3 and canonical maintainers. |
| ADM-04 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-05 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream OpenCoven/coven-agents#296 (read-only inspection seam, open). Owner: #3 and canonical maintainers. |
| ADM-06 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); upstream canonical producer: familiar root/revision in admission (missing per the #3 investigation; no upstream issue found); upstream OpenCoven/coven-agents#297 (non-browser owner audience for the run API, open). Owner: #3 and canonical maintainers. |
| ADM-07 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-08 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-09 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| ADM-10 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); open question for #3: how input bytes enter the payload digest. Owner: #3 and canonical maintainers. |
| ADM-11 | ADM-11 fixture cannot become live-ready; null client refuses; CLI synthetic ready exits 3. | A real admitted attributable report requires #3; synthetic output never satisfies it. |
| BST-01 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-02 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-03 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| BST-04 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist); OpenCoven/coven-agents#300: decided as snapshot verification only (recorded on #3, 2026-11-11); the issue is still open. Owner: #3 and canonical maintainers. |
| OUT-01 | OUT-01 fixture audit checks file count, per-file/total/task bytes, full path/depth and inclusive edges. | Admission/staging rejection before transmission still needs the #3 data-staging contract. |
| OUT-02 | OUT-02 fixture audit rejects symlink flags, parent/absolute/invalid paths, malformed UTF-8 and NUL. | Real staging and filesystem policy enforcement still need #3. |
| OUT-03 | Fixture audit checks literal input bytes and hashes without executing input code. | No staging/launch implementation exists; byte-preserving data transport is #3 work. |
| OUT-04 | GEN-SIZE-16385 rejects RP-02 and RP-15; lower byte edges also execute. | Producer truncation/refusal and export bounds remain #3/#4 contracts; hardMaxBytes is still a proposal. |
| OUT-05 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| OUT-06 | RP-10 corpus recipes check the synthetic report final-line half. | Marker-file prevention is RE-01 and requires #3 runtime/file evidence. |
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
| RED-01 | RP-11 to RP-14 corpus recipes exercise the secondary text-pattern net. | Primary RE-06 seeded run/artifact/export canaries require #3/#4; known pattern misses remain pinned. |
| RED-02 | RED-02 client tests omit ordinary synthetic IDs and thrown error canaries. | Accepted #2 R1 numeric-ID disclosure remains open; export/run surfaces require #3/#4. |
| RED-03 | RED-03 malformed oversized response stays bounded with no raw text disclosed. | A generalized hostile-provider nesting/size proof is not claimed; real seam remains coven-agents#296. |
| RED-04 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist). Owner: #4 and canonical maintainers. |
| RED-05 | Static publication preflight and gitleaks inspect the exact evidence payload. | No live qualification packet exists; human inspection and independent R4 review are still required. |
| RED-06 | Blocked: no executable canonical behavior is claimed. | #3 run/attempt/admission interface (does not exist). Owner: #3 and canonical maintainers. |
| REU-01 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-02 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-03 | Blocked: no executable canonical behavior is claimed. | #4 observe/export/cancel interface (does not exist); upstream OpenCoven/coven-agents#262 (containment and reuse, open). Owner: #4 and canonical maintainers. |
| REU-04 | Smoke rejects reset/ignore-cleanup flags and forged environment cannot open execution. | Canonical cleanup-fence bypass resistance still requires #4 and coven-agents#262. |
| REU-05 | Static smoke review and preflight tripwire expose no lifecycle mutation verbs. | Full runtime/recovery surface inspection requires accepted #3/#4; no upstream mutation implementation is copied. |
| REU-06 | Matrix retains blocked G4/G5 and smoke never reports success. | An actual cleanup_required terminal receipt needs #4 and coven-agents#262. |
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

| Gate | Opens when | Owner |
| --- | --- | --- |
| Offline harness wiring | Opened by accepted #2 at the exact revision above; implemented by this slice | #5 |
| Real read-only inspection | Versioned authenticated exact-ID seam lands and is accepted at an exact SHA | coven-agents#296 lifecycle owner |
| Runtime and admission | Reviewed #3 contract, including owner audience, exact sandbox binding, read-only permission, familiar-revision admission and bounded input staging | #3 and coven-agents#297/#298/#299; canonical familiar producer |
| Recovery and reuse | Reviewed #4 contract and qualified workspace-preserving containment | #4 and coven-agents#262 |
| Live qualification | Accepted #2–#4, exact sandbox, named operator/window and separate spend authorization | Epic maintainer |
| Stop/start | Separate explicit action authorization and exclusive sandbox assignment | Epic maintainer; canonical lifecycle owner executes |
| Independent R4 review | A genuinely independent reviewer names the exact candidate SHA and retained evidence | Epic maintainer |

Next executable action: independently review the exact candidate and its offline receipts. Then the owning upstream maintainers deliver the missing canonical contracts. Keep #5 and the epic open; a fixture-only PR may merge only through the maintainer's separate decision.
