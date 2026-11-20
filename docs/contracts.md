# Contracts between lanes

A lane hands work to the next lane as a **contract at an exact revision**, not as "what is on main". This page lists each contract a lane produces, its standing, and who consumes it.

These are client contracts. None of them is authority: holding a binding, a result or a sandbox ID authorizes nothing.

## Standing

#1's rule is that "a gate opens on a linked, reviewed capability at an exact revision", and that a maintainer confirms acceptance before closure. #1 uses "reviewed" and "accepted" without defining them. The three standings below are this page's shorthand, an **addition to #1**.

| Standing | Meaning |
| --- | --- |
| **proposed** | Published by its author at an exact SHA, and either not reviewed or reviewed with a blocking finding open. Opens no gate. A consumer may use it for read-only investigation and failure-case design only; it writes no tests or fixtures against it. (#5's fixture preparation under #1 does not consume the contract.) |
| **reviewed** | That exact SHA has had the review its producing issue's Review row names (maintainer review for #2; independent review for #3 and #4, and for any `risk:r4` change), by someone other than the author; the review is linked and no blocking finding is open. Under #1 this opens the consumer's gate. |
| **accepted** | The maintainer has confirmed acceptance of that SHA in a comment. #1 requires this before closure, for the #2 artifact that #3 consumes, and for the #2 to #4 revisions behind #5's live qualification. |

**Proposed addition, awaiting a maintainer decision:** only **accepted** opens a consumer's gate, for every lane. The reason is that every worker posts from one GitHub account and the reviewers so far were started by authoring sessions, so a review here has been a second read rather than an independent one. Until the maintainer decides, #1's wording applies as quoted above. [`coordination.md`](coordination.md#lanes-and-gates) and `AGENTS.md` say the same.

Still undecided on 2026-11-12. That day the maintainer accepted the #2 contract at an exact SHA (see [Produced by #2](#produced-by-2)), and the pull request that carries this proposal, [#9](https://github.com/OpenCoven/coven-castles/pull/9), was merged as `a4ced7b463edccbe2ddd89ad12645b60f0aacefb`. The [comment recording the acceptance and the instruction to merge](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865), posted by the coordinating session before the merges, says the decisions listed in that pull request's body, the gate rule among them, "remain open; merging them is not a decision on those items".

Any change to a contract after review or acceptance is a new revision and starts again as **proposed**.

## Produced by #2

### Proposed revision: conformance to upstream inspection v1

Proposed on [#2](https://github.com/OpenCoven/coven-castles/issues/2) by worker `cs20-e463adde`, 2026-11-20. The upstream seam requested in coven-agents#296 has landed: a strict sandbox-inspection v1 schema and an owner-scoped HTTP route, pinned at `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502`. This revision translates that v1 answer into Castles' existing result. **Proposed**, evidence **fixture / static** only, and no live client exists. The exact head, review and each pending decision are in the draft pull request and the #2 handoff. Where this section and the snapshot below differ, this section describes the proposal and the snapshot describes what was there before.

- **Seam input.** `inspectBoundSandbox` still takes `{agentId, sandboxId, expectedGeneration}` and still returns `unknown`. What it returns is now read as `{status, body}`: the route's HTTP status and its JSON body. `castles.fixture.sandbox-inspection.v1` is retired.
- **Statuses** (pending decision). `401` is `unauthenticated`. `403` and `404` are `owner_mismatch` (`unauthorized`); upstream answers an unauthorized read as `404`. `429` and `503` are `provider_unavailable`. Any other status is `inspection_contract_violation`.
- **Strict keys.** A body whose `version` is not `1`, or that carries a key v1 does not define at any level Castles reads, is refused whole as `inspection_contract_violation`.
- **Identity** (pending decision). The echoed `record.agentId` and `record.sandboxId` must equal the binding; a `null` recorded ID is a mismatch. Upstream's ownership-label check must be `true`, and its configuration must be `current` or `prior`. Each failure withholds `observed`. A generation-label check that is not `true`, a fence other than `none`, a credential-boundary check that is not `true` and a policy `credentialBoundaryVersion` other than the profile's each need reconciliation and keep `observed`. A returned-ID mismatch is upstream's `ambiguous` outcome with reason `returned_id_mismatch`.
- **Egress** (pending decision). v1 withholds the raw lists, so the per-entry domain and IPv4 rules cannot run and are removed. A domain list must equal the owner's policy (`domainAllowListMatchesPolicy`), and the owner's policy sets no network list and no outbound proxy, so either one is `egress_allow_list_unsafe`. Upstream's equality is exact text. It is looser than the removed rules on a `*.` entry the owner's policy itself contains.
- **TTL and attachments** (pending coven-agents#322). These are booleans and a volume count. `false` and `0` are the stated "not set". An absent or `null` value is `metadata_missing`, so an explicit `null` no longer means "not set". Upstream folds "not reported" into `false` or `0`; Castles accepts that for now.
- **Platform** (maintainer decision, 2026-11-20; upstream request coven-agents#323). v1 reports no platform. The operating system is source policy implied by the qualified snapshot, and the snapshot check is what makes that inference hold. `observed.platform` is always `{architecture: null, os: null}`, `platform_unsupported` is removed from the reason codes, and a platform block in a response is a key v1 does not define.
- **SDK.** The version compared is upstream's server-selected `policy.sdkVersion`, against `0.231.1`. A failing comparison has field `policy.sdkVersion`.
- **Observed result.** `exposure` is six booleans (`public`, `networkBlockAll`, `domainAllowListConfigured`, `domainAllowListMatchesPolicy`, `networkAllowListConfigured`, `outboundProxyConfigured`), each `null` when unstated; `egressAllowListEntries` is removed. A new `identity` block echoes upstream's four checks. The state set is v1's seven states. The fence `none` is echoed as `clear`. Reason fields name v1's keys (`memoryGib`, `record.fence`, `autoDestroyAtConfigured`, and so on).
- **Source pins.** 22 pins at `0696af12`: the 18 earlier paths, all still present, plus the v1 schema, the route, the runner error codes and the resource-inspection derivation. The mutation-owner table is unchanged in content. `UPSTREAM_SEAM` stays `missing` with the #296 link, because #5 cites that test title. Whether to rename it is a pending decision.

### Snapshot before the v1 revision

Snapshot of the proposed contract carried by PR [#12](https://github.com/OpenCoven/coven-castles/pull/12), refreshed 2026-11-16 by worker `cc2g-bcb81a3a`. The source includes the original candidate at `0b87d7c2871b68139071090bf466b91a498c6454`, current-main harness integration at `ecd360702e0d5d11f3acfc5899847ab4eb2df702`, and PR #10's historical documentation corrections at `cede492f41fc4eba20576f1e11a32c24cce3990a`, with the changes below. A commit cannot name its own SHA: use the exact-head handoff on [#2](https://github.com/OpenCoven/coven-castles/issues/2) for the final revision and any subsequent review or maintainer acceptance. The standing recorded here is the standing when this snapshot was prepared; a merge alone supplies no acceptance.

| | |
| --- | --- |
| Revision | The final PR #12 head pinned in its issue handoff. PR #11 at `fa95bbc44c03a015f2b7c16b722cfe25c319885e` and PR #14's tests at `c6d5ca4910183d256d671b330ce82ed904631ae8` are incorporated, with subsequent changes stated below and in the PR. |
| Standing at preparation | **Proposed.** Final-head independent review and maintainer contract acceptance have not been claimed by the author. Earlier reviews apply only to their named revisions. |
| Historical accepted revision | `13ab3bc2c823fe12b482a6701ab4df2c28e6733c`, accepted by the maintainer on 2026-11-12 in [the comment recording the decision](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865): “the profile/binding result shape, client seam, source pins and offline test command as they stand at” that revision. The coordinating agent session posted the comment before the merges with the instruction to merge. Basis: [review 5869660940](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5869660940) by `rv6c-3db7f9d0`, disclosed as a second read rather than independent review and accepted on that basis. PR #6 subsequently merged as `978a2465df8d3af5b8e693fa9d228a9055aa1db8`. |
| Historical acceptance limits | Fixture and static evidence only; no live provider call, spending, deployment, sandbox mutation, label or assignee change was authorized. R1 (integer-ID echoes), R2 (capability scan) and R3 (five unexamined provider fields) remained follow-ups at that SHA. This candidate bounds R1 echoes and strengthens R2's diagnostic scan with their stated limits; R3 remains open. The acceptance did not decide the proposed gate rule or the decisions in PR #9/#7. |
| Reviews | Original PR #12 at `0b87d7c2871b68139071090bf466b91a498c6454`: [review 5902651007](https://github.com/OpenCoven/coven-castles/pull/12#pullrequestreview-5902651007), `rv12-8b71a903`, no blocking findings and six non-blocking, an author-started second read. PR #11 at [`7e5cf12`](https://github.com/OpenCoven/coven-castles/pull/11#pullrequestreview-5883103571) required changes; at [`fa95bbc`](https://github.com/OpenCoven/coven-castles/pull/11#pullrequestreview-5883649824) it had no blocking findings. PR #10 at `cede492f41fc4eba20576f1e11a32c24cce3990a`: [review 5882717263](https://github.com/OpenCoven/coven-castles/pull/10#pullrequestreview-5882717263), no blocking findings, also a second read. None is independent review of this final candidate. |
| Gates | The historical acceptance proves the accepted-artifact condition for `13ab3bc` only. #1 also requires #3 to start against a reviewed contract; #3's Start gate asks for “a reviewed profile/binding/client contract and exact source pins”; #5's Harness wiring gate asks for “#2's reviewed package/test command and binding-result contract”. Whether the historical second read plus acceptance supplies that review is an unresolved maintainer reading, common to #3 and #5. The candidate does not decide it. Final-head review and acceptance must be linked separately. #3/#4/#5 remain blocked on their recorded upstream capability and live-authorization gates; consult the current issue handoffs rather than treating this snapshot as an execution grant. |
| Evidence | **fixture / static** only. No real-daemon or live-provider qualification is claimed. |

### Changes against the accepted revision

Status precedence, reason-code list, schema name, function parameter signatures, exports, source pins and dependencies are unchanged. Observed-result fields explicitly gain nullable unknown states as listed below; this is a proposed contract change requiring acceptance. Every refusal uses an existing reason code.

| # | What | At `13ab3bc` | At this revision | From |
| --- | --- | --- | --- | --- |
| 1 | Absent `autoDestroyAt`, `warmPoolId` or `linkedSandboxId` | Read as not set, no reason | `incompatible`, `metadata_missing` with the key as field; explicit `null` still means not set | #3 second read, fail-open item 2 |
| 2 | Absent domain/network allow list | Not examined; block-all could yield `ready` | `incompatible`, `metadata_missing`, even with block-all; unknown egress is not called unrestricted | #3 second read, fail-open item 2 |
| 3 | Volume array with a length that is not a non-negative integer | Could read as empty; bigint/symbol could reject | `volumes_present`, echoed count `null` | #11 question 11 / N9 |
| 4 | Nine observed integer fields | Any safe integer echoed | Only -1 to 99,999 echoed, otherwise `null`; policy uses the original value, and generation matching is unchanged | #11 R1 |
| 5 | Volume-count echo | Capped length, including a negative/fractional value; absent field echoed 0 | Integer 0 to 999 for an array with a valid count, otherwise `null` | #11 N4 and PR #12 N1 |
| 6 | Client with no callable inspection method | `provider_unavailable`, fixture, one inspection counted | `upstream_seam_missing`, evidence none, zero inspections | #11 R6 |
| 7 | Reading and counting the seam method | Read at call time for a valid binding | Read once before binding validation; exactly one invocation counted when called, under the intact-built-ins assumption below | #11 R6 |
| 8 | `null`, `undefined` or function environment; `null`, array or function options | Could reject or read supplied properties | Unconfigured binding (`sandbox_id_missing`); no options | #11 R6; PR #12 N3 |
| 9 | Numeric timeout above 2,147,483,647, including Infinity | Node's 1 ms fallback | Default 30,000 ms; other timeout inputs retain their documented behavior | #11 R6 |
| 10 | Absent `volumes` | `ready` when all other checks pass; count 0 | `incompatible`, `metadata_missing (volumes)`; count `null`; explicit `null` or `[]` still states no attachment | PR #12 N1 |
| 11 | Unstated TTL, linked/warm-pool metadata and unreadable allow-list metadata in observed output | `absent`, false or 0 | Unknown is JSON `null`; the affected observed type fields allow `null`. Human TTL/egress counts print `?`. Explicit `null` TTL/attachments remain known absence, and two stated null allow lists have count 0 | PR #12 N2 |

Fixture inputs: twelve of the thirteen observed cases now explicitly state previously omitted keys from rows 1 and 2 as `null`; keys already carrying values keep those values. `metadata-missing.json` omits four of these five keys (`autoDestroyAt`, `warmPoolId`, `linkedSandboxId`, `networkAllowList`) and retains a stated domain list. It expects seven missing-metadata reasons rather than three. Its status remains incompatible; unknown observed fields now use `null` as described above. All fixtures are synthetic, never live readiness.

PR #11's body preserves the full inherited input-by-input rationale for rows 4 to 9. Outstanding policy choices are not silently settled by retaining those behaviors: R3, public-suffix domain policy, the ten-range limit, alias hashing and non-positive/non-numeric timeout policy remain stated limitations or maintainer decisions.

### Binding

Where: `src/profile.ts` (`Binding`, `parseBinding`). Consumers: #3, #5.

| Environment key | Meaning | Rule |
| --- | --- | --- |
| `CASTLES_PROFILE` | The profile to check against | Must equal `castles.daytona-private-linux.v1` |
| `CASTLES_SANDBOX_ID` | Exact ID of the one existing sandbox | 1 to 128 of `A-Z a-z 0-9 _ -`, starting alphanumeric. Never a name or label |
| `CASTLES_OWNER_AGENT_ID` | The owning service's agent record | Same character rule |
| `CASTLES_SANDBOX_GENERATION` | Generation recorded on that record | Canonical non-negative integer, at most 9 digits |

Values are exact: no defaults, no trimming, no lookup. The sandbox ID is a target, not authorization; ownership is decided by the owning service from its authenticated caller.

### Client seam

Where: `src/preflight.ts` (`SandboxInspectionClient`). Consumers: #3.

```ts
type SandboxInspectionClient = {
  inspectBoundSandbox(
    request: { agentId: string; expectedGeneration: number; sandboxId: string },
    options?: { signal: AbortSignal }
  ): Promise<unknown>;
};
```

This single method is the whole provider-facing surface. There is no create, start, stop, resize, delete, list or lookup-by-name. The response is treated as untrusted input.

**No live implementation exists.** The upstream read-only seam it needs is requested in [OpenCoven/coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296). The response shape Castles expects, `castles.fixture.sandbox-inspection.v1`, is carried by fixtures only and is a proposal to that issue, not an upstream contract. v1 requires the response to echo the agent record it read (`binding.agentId`).

### Result

Where: `src/preflight.ts` (`PreflightResult`, `runPreflight`, `renderJson`). Consumers: #3, #5.

Schema `castles.preflight.v1`:

| Field | Content |
| --- | --- |
| `schema` | `"castles.preflight.v1"` |
| `status` | `ready`, `stopped`, `unavailable`, `incompatible`, `unauthorized` or `reconciliation-required` |
| `reasons` | Up to 16 of `{ code, field? }`. `code` is a fixed literal; `field` is a literal from this module, never provider text |
| `evidence` | `fixture`, `live-provider` or `none`. Derived from the client, never supplied by the caller: no client gives `none`, any client gives `fixture`, including when the binding is invalid. A client is a value whose `inspectBoundSandbox` is callable; `null`, `undefined` and any other value are no client. The library cannot return `live-provider` at this revision |
| `target` | `sandboxAlias`, `ownerAlias` (redacted, stable aliases), `expectedGeneration`, `profile` |
| `sourcePolicy` | Policy from `SUPPORTED_PROFILE`, with the `repo@sha:path` pins. Never derived from the sandbox. Most values are read from pinned source; `network.networkAllowList` (`{ basis: "castles-decision", maxEntries: 10, minIpv4Prefix: 8 }`) is a Castles decision with no upstream pin |
| `observed` | What the seam reported, or `null`. Provider text is never copied: see below |
| `providerCalls` | `{ inspect }`: 1 if `inspectBoundSandbox` was invoked, otherwise 0 |
| `upstream` | `{ issue, seam }`: the upstream issue link, and `seam: "missing"` |

Status precedence when several findings apply: `unauthorized` > `reconciliation-required` > `incompatible` > `unavailable` > `stopped` > `ready`.

`observed` is `null` when the binding is invalid, when no client seam is supplied, when the seam refused, or when the echoed agent record, recorded sandbox ID or returned sandbox ID differs from the binding. A stale generation alone does not withhold it.

Inside `observed`, `state`, `target`, `image.snapshot`, `platform.os`, `platform.architecture`, `binding.lifecycle` and `binding.attemptFence` each carry a value from a fixed set or `"unrecognised"`; `sdk.version` carries a `major.minor.patch` version or `"unrecognised"`. The two `binding` fields are never `null`: a response in which either is absent or not a string is refused whole (`inspection_contract_violation`, `observed: null`), and any other string outside the set reads `"unrecognised"`. The other six are `null` when the value is absent or not a string. Other fields are numbers, booleans, fixed literals or `null`.

Observed integers (`resources.cpu`, `memoryGiB`, `diskGiB` and `gpu`, the four `lifecycle` intervals and `binding.generation`) are echoed only from -1 to 99,999. Outside that range, as when the value is not an integer, the field is `null`, so `binding.generation` can be `null`. Status and reason codes are decided on the value itself, independently of its echo: a matching recorded generation of 100,000 or more can have `binding.generation: null`. An identifier that is itself an integer inside the echoed range cannot be distinguished from a reading. The two counts, `attachments.volumes` and `exposure.egressAllowListEntries`, are integers from 0 to 999 or `null`. Volumes have count 0 only for an empty array; omission, explicit null, a non-array or a non-count array length has echo `null`. Missing volumes refuse with `metadata_missing`; explicit null still means no attachment; any other value that is not an empty array refuses with `volumes_present`. The egress count is unknown (`null`) if either list is absent or is neither a string nor null; two stated null lists have count 0.

Observed `attachments.linkedSandbox` and `attachments.warmPool` are `null` for missing metadata, false for an explicit null, and true for any other stated value (which the compatibility check refuses). `lifecycle.autoDestroyAt` is `null` for missing metadata, `absent` for an explicit null, and `present` otherwise. These unknown states cannot be used as evidence of safe absence. Human output uses `?` for unknown TTL and allow-list counts. Consumers must still evaluate status, reasons and evidence together.

Three rules behind existing reason codes, all Castles decisions:

- An architecture other than `x86_64`, `amd64`, `aarch64` or `arm64` is `incompatible` with `metadata_missing`. No architecture is pinned upstream.
- A network allow list with more than 10 entries is `incompatible` with `egress_allow_list_unsafe`, as is any entry wider than `/8`. The figure 10 comes from public Daytona documentation and is unverified against the provider. Domains must be ASCII, and an IP literal is not a domain.
- `autoDestroyAt`, `warmPoolId`, `linkedSandboxId`, `volumes`, `domainAllowList` and `networkAllowList` must be stated in an `observed` response. An absent key is `incompatible` with `metadata_missing` and the key as its field; explicit `null` means not set. An unstated allow list is not also reported as `egress_unrestricted`, and block-all does not excuse it. At `13ab3bc` an absent key read as not set for all six.

JSON output is at most 16,384 bytes.

Reason codes at this revision:

- Binding: `sandbox_id_missing`, `sandbox_id_invalid`, `profile_missing`, `unknown_profile`, `owner_binding_missing`, `owner_binding_invalid`, `generation_missing`, `generation_invalid`.
- Identity and reconciliation: `owner_mismatch`, `unauthenticated`, `binding_mismatch`, `returned_id_mismatch`, `ambiguous_lookup`, `generation_mismatch`, `binding_lifecycle_pending`, `attempt_fence_held`, `credential_boundary_unverified`.
- Compatibility: `metadata_missing`, `sdk_generation_mismatch`, `public_exposure`, `egress_unrestricted`, `egress_allow_list_unsafe`, `lifecycle_auto_stop`, `lifecycle_auto_archive`, `lifecycle_auto_delete`, `lifecycle_auto_pause`, `lifecycle_ttl`, `image_unqualified`, `target_unsupported`, `resources_out_of_policy`, `gpu_present`, `volumes_present`, `warm_pool_member`, `linked_sandbox_present`, `platform_unsupported`.
- Availability: `upstream_seam_missing`, `provider_unavailable`, `inspection_contract_violation`, `sandbox_not_found`, `sandbox_destroyed`, `lifecycle_not_settled`, `sandbox_stopped`.

### Readiness predicate

Where: `src/preflight.ts` (`isLiveReady`). Consumers: #3, #5.

```ts
isLiveReady(result) === (result.status === "ready" && result.evidence === "live-provider")
runPreflight(environment, client | null, options?: { timeoutMs?: number })
```

`runPreflight` takes no `evidence` option. Because no live client exists, `isLiveReady` is false for every result the library produces at this revision.

A `timeoutMs` that is a number above 2,147,483,647, `Infinity` included, means the 30,000 ms default, as no value does: a timer would turn it into 1 ms. Every other value is handed to the timer as given. Node then waits 1 ms for a number below 1 or `NaN` and converts a value that is not a number; one it cannot convert ends the check as `provider_unavailable`. What a non-positive or non-numeric timeout should mean is not decided.

An `environment` that is `null`, `undefined`, a primitive or a function is reported as `sandbox_id_missing`. `options` that are `null`, a primitive, a function or an array are ignored. Any other object is read, whatever built it, so an array can be an `environment`. The client's `inspectBoundSandbox` property is read once, before the binding is validated, and nothing else is read from the client or from the method.

These hold for plain values. A property whose read throws, on the `environment`, the `options` or a response held in memory, still makes `runPreflight` reject with the caller's own error; only a throwing read of the client's property is caught. They also assume the realm's built-ins were intact when `src/preflight.ts` was loaded: the module takes `Function.prototype.call` and `bind` once, at load, to invoke the seam method, so code that replaced them before the import decides how the method is invoked. Code that runs first in the same realm could already decide the outcome at `13ab3bc` (by replacing `Promise.race`, for example).

**Consumers must gate on this, never on `status` alone.** A fixture replay can report `status: "ready"`; it is not readiness.

### CLI and exit codes

Where: `src/cli.ts`. Consumers: operators, #5.

```text
castles check [--json] [--fixture <case.json>]
```

| Exit | Meaning |
| --- | --- |
| `0` | `ready` from a live provider read. Unreachable until the upstream seam exists |
| `1` | Any status other than `ready` |
| `2` | Usage error or unreadable fixture file |
| `3` | A fixture replay reported `ready`. Never readiness |

### Offline test command

Consumers: #3, #4, #5.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
```

`test` runs `tsx --test tests/*.test.ts`, so a new `tests/<name>.test.ts` is picked up without a manifest change. Three tests depend on the Node version: two run the CLI under Node's permission model, and one network control also needs `--allow-net`. On Node 24.22.0 the first two run and only the network control is skipped; the README lists the versions. Requests to change the script, add a script or widen `tsconfig.json` go to the #2 steward.

### Source pins and mutation owners

Where: `src/profile.ts` (`SOURCE_PINS`, `MUTATION_OWNERS`). Consumers: #3, #4, #5.

Where: `src/profile.ts` also exports `OUTSIDE_LISTED_MUTATIONS`.

Twenty-two `repo@sha:path` references into `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502` in the proposed v1 revision (eighteen at `3a4f3ff4130860d0abda1d2207b43b2f9d372180` before it). `MUTATION_OWNERS` has ten rows naming the existing upstream owner of each sandbox mutation found at the pin: eight for the persistent agent sandbox and two for the owner's separate, short-lived diagnostic sandbox. `OUTSIDE_LISTED_MUTATIONS` names two operations that are not lifecycle mutations (command execution inside a sandbox, snapshot creation). Castles performs none of these. The table is a reading of the pinned files, not a proof that no other call site exists upstream.

## Produced by #3

Nothing yet. #3 has published an investigation comment, not an interface. When it does, this section lists the run, attempt and operation references, the result and receipt shape, the cancellation interface and the runtime manifest hashes, with their standing and SHA.

## Produced by #4

Nothing yet. Expected: observe, export and cancel client behaviour, recovery fixtures, and upstream containment and reuse evidence for #5.

## Produced by #5

On `main` since 2026-11-12: the report-task fixture, expected-report properties and the negative-case catalogue, in `fixtures/report-task/`. They arrived with PR [#7](https://github.com/OpenCoven/coven-castles/pull/7), merged at head `302bb4533aaccde8165d8efe596502da286891b0` as `b5d7fc14add09fa94a7103031d7d625f710e519c`.

The [PR #7 review](https://github.com/OpenCoven/coven-castles/pull/7#pullrequestreview-5870277806) at that head found no blocking findings and two non-blocking. It was an author-started second read, not independent review. The [comment recording the maintainer's decision](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865) accepted only the #2 artifact, instructed that PR #7 be merged, and left the pinned-fixture-limit decisions open. That historical merge did not accept those limits. These are synthetic fixture formats, not canonical interface contracts.

PR [#13](https://github.com/OpenCoven/coven-castles/pull/13) subsequently added the offline harness and refusal-only smoke script, independently reviewed by `rv13-1b8a60bf` at `53c821b03bf56cd2fd5b96b6a820843ae21145c9` in [review 5913853029](https://github.com/OpenCoven/coven-castles/pull/13#pullrequestreview-5913853029), and merged as `ecd360702e0d5d11f3acfc5899847ab4eb2df702`. Its [handoff on #5](https://github.com/OpenCoven/coven-castles/issues/5#issuecomment-6904261609) records the exact offline checks and remaining capability/authorization gates. The independent offline review and merge supply no live qualification or closure of #5; its runtime, admission and containment gates remain separate.

## Updating this page

The lane that produces a contract updates its section in the same change that changes the contract, through the #2 steward (this file is shared). Record the new SHA and reset the standing to **proposed**.
