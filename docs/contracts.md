# Contracts between lanes

A lane hands work to the next lane as a **contract at an exact revision**, not
as "what is on main". This page lists each contract a lane produces, its
standing, and who consumes it.

These are client contracts. None of them is authority: holding a binding, a
result or a sandbox ID authorizes nothing.

## Standing

#1's rule is that "a gate opens on a linked, reviewed capability at an exact
revision", and that a maintainer confirms acceptance before closure. #1 uses
"reviewed" and "accepted" without defining them. The three standings below are
this page's shorthand, an **addition to #1**.

| Standing | Meaning |
| --- | --- |
| **proposed** | Published by its author at an exact SHA, and either not reviewed or reviewed with a blocking finding open. Opens no gate. A consumer may use it for read-only investigation and failure-case design only; it writes no tests or fixtures against it. (#5's fixture preparation under #1 does not consume the contract.) |
| **reviewed** | That exact SHA has had the review its producing issue's Review row names (maintainer review for #2; independent review for #3 and #4, and for any `risk:r4` change), by someone other than the author; the review is linked and no blocking finding is open. Under #1 this opens the consumer's gate. |
| **accepted** | The maintainer has confirmed acceptance of that SHA in a comment. #1 requires this before closure, for the #2 artifact that #3 consumes, and for the #2 to #4 revisions behind #5's live qualification. |

**Proposed addition, awaiting a maintainer decision:** only **accepted** opens
a consumer's gate, for every lane. The reason is that every worker posts from
one GitHub account and the reviewers so far were started by authoring
sessions, so a review here has been a second read rather than an independent
one. Until the maintainer decides, #1's wording applies as quoted above.
[`coordination.md`](coordination.md#lanes-and-gates) and `AGENTS.md` say the
same.

Any change to a contract after review or acceptance is a new revision and
starts again as **proposed**.

## Produced by #2

Snapshot of draft PR [#12](https://github.com/OpenCoven/coven-castles/pull/12)
(branch `castles/2-revision-cc2f-4dfe81ab`), taken 2026-11-14. Everything
below describes the source at that PR's head, which is a **proposed**
revision. A commit cannot name its own SHA: the exact head is in the PR and
in the handoff on #2. What the maintainer accepted is still
`13ab3bc2c823fe12b482a6701ab4df2c28e6733c`; the differences are listed under
[Changes against the accepted revision](#changes-against-the-accepted-revision).

| | |
| --- | --- |
| Revision | The head of draft PR #12. It carries draft PR [#11](https://github.com/OpenCoven/coven-castles/pull/11) at `fa95bbc44c03a015f2b7c16b722cfe25c319885e` unchanged, on `main` at `b5d7fc14add09fa94a7103031d7d625f710e519c`. |
| Standing | **Proposed.** Not reviewed in this page's sense and not accepted. #11 at `fa95bbc` is proposed as well; this revision supersedes it. |
| Accepted revision | `13ab3bc2c823fe12b482a6701ab4df2c28e6733c`, accepted by the maintainer on 2026-11-12 in [this comment on #2](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865): "the profile/binding result shape, client seam, source pins and offline test command as they stand at" that revision. Basis: the [review at that revision](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5869660940) by `rv6c-3db7f9d0`, a second read and not independent review, on which the maintainer accepted. Evidence fixture and static only; the acceptance authorizes no live call, spending or sandbox mutation, and decides none of the proposed additions. It named three follow-ups not fixed at that revision: R1 (integer fields can echo an all-digit ID) and R2 (the capability scan) are answered by #11, carried here; R3 (five provider fields not examined) is still open. Merged into `main` as `978a2465df8d3af5b8e693fa9d228a9055aa1db8`. |
| Reviews | Of this revision: a second read by a reviewer started from the author's session, linked from the PR. Of #11: two second reads by `rv11-c26f825a`, at [`7e5cf12`](https://github.com/OpenCoven/coven-castles/pull/11#pullrequestreview-5883103571) (changes needed) and [`fa95bbc`](https://github.com/OpenCoven/coven-castles/pull/11#pullrequestreview-5883649824) (no blocking findings). None is independent review. #2 is labelled `risk:r3`. |
| Gates | Unchanged by this revision: it opens and closes no gate. What the acceptance of `13ab3bc` means for #3 and #5, and the open question of whether it supplies "reviewed", are as the maintainer left them; read #3 and #5 for their current blockers. |
| Evidence | **fixture** only. No live provider call has been made through this code. |

### Changes against the accepted revision

Each is pinned by a test. Status precedence, reason-code list, schema name,
function signatures, exports, source pins and dependencies are unchanged.
**No reason code is added**: every change below uses an existing code.

| # | What | At `13ab3bc` | At this revision | From |
| --- | --- | --- | --- | --- |
| 1 | An absent `autoDestroyAt`, `warmPoolId` or `linkedSandboxId` in an `observed` response | Read as "not set": no reason | `incompatible`, `metadata_missing` with the key as `field`. `null` still means "not set" | Second read on #3, fail-open item 2 |
| 2 | An absent `domainAllowList` or `networkAllowList` | Not examined. With block-all set, `ready`; with block-all off and both absent, `egress_unrestricted` | `incompatible`, `metadata_missing` with the list as `field`, block-all or not; egress is then not also called unrestricted. `null` still means "no list" | the same |
| 3 | A volume array whose `length` is not an integer from 0 up (only an array behind a proxy, in memory, can report one) | Read as "no volume" when not greater than 0; a bigint or symbol length made `runPreflight` reject | `volumes_present`; echoed as `null` | #11 question 11, review N9 |
| 4 | The nine observed integers | Any safe integer echoed | Echoed only from -1 to 99,999, otherwise `null`; `binding.generation` can be `null`. Status and reasons unchanged | #11, R1 |
| 5 | `attachments.volumes` echo | The capped length, any sign or fraction | An integer from 0 to 999, or `null` when the value is not a count; 0 when the field is absent | #11 N4; this revision |
| 6 | A client with no callable `inspectBoundSandbox` | `provider_unavailable`, `fixture`, one inspection counted | No client: `upstream_seam_missing`, `evidence: "none"`, no inspection | #11, R6 |
| 7 | When the client's method is read, and what is counted | Read at call time, valid binding only; counted whenever the client was not `null` | Read once, before the binding is checked; counted exactly when invoked | #11, R6 |
| 8 | A `null` or function `environment`; `null`, array or function `options` | `TypeError`, or read as given | Unconfigured binding (`sandbox_id_missing`); no options | #11, R6 |
| 9 | `timeoutMs` above 2,147,483,647, `Infinity` included | Node's 1 ms | The 30,000 ms default | #11, R6 |

Fixture inputs: twelve of the thirteen observed cases now state the keys of
rows 1 and 2 as `null`, and render as before; `metadata-missing.json` still
omits them and now expects seven `metadata_missing` reasons instead of three.

PR #11's body has the full input-by-input list for rows 4 to 9.

### Binding

Where: `src/profile.ts` (`Binding`, `parseBinding`). Consumers: #3, #5.

| Environment key | Meaning | Rule |
| --- | --- | --- |
| `CASTLES_PROFILE` | The profile to check against | Must equal `castles.daytona-private-linux.v1` |
| `CASTLES_SANDBOX_ID` | Exact ID of the one existing sandbox | 1 to 128 of `A-Z a-z 0-9 _ -`, starting alphanumeric. Never a name or label |
| `CASTLES_OWNER_AGENT_ID` | The owning service's agent record | Same character rule |
| `CASTLES_SANDBOX_GENERATION` | Generation recorded on that record | Canonical non-negative integer, at most 9 digits |

Values are exact: no defaults, no trimming, no lookup. The sandbox ID is a
target, not authorization; ownership is decided by the owning service from its
authenticated caller.

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

This single method is the whole provider-facing surface. There is no create,
start, stop, resize, delete, list or lookup-by-name. The response is treated as
untrusted input.

**No live implementation exists.** The upstream read-only seam it needs is
requested in
[OpenCoven/coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296).
The response shape Castles expects, `castles.fixture.sandbox-inspection.v1`,
is carried by fixtures only and is a proposal to that issue, not an upstream
contract. v1 requires the response to echo the agent record it read
(`binding.agentId`).

### Result

Where: `src/preflight.ts` (`PreflightResult`, `runPreflight`, `renderJson`).
Consumers: #3, #5.

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

Status precedence when several findings apply: `unauthorized` >
`reconciliation-required` > `incompatible` > `unavailable` > `stopped` >
`ready`.

`observed` is `null` when the binding is invalid, when no client seam is
supplied, when the seam refused, or when the echoed agent record, recorded
sandbox ID or returned sandbox ID differs from the binding. A stale generation
alone does not withhold it.

Inside `observed`, `state`, `target`, `image.snapshot`, `platform.os`,
`platform.architecture`, `binding.lifecycle` and `binding.attemptFence` each
carry a value from a fixed set or `"unrecognised"`; `sdk.version` carries a
`major.minor.patch` version or `"unrecognised"`. The two `binding` fields are
never `null`: a response in which either is absent or not a string is refused
whole (`inspection_contract_violation`, `observed: null`), and any other
string outside the set reads `"unrecognised"`. The other six are `null` when
the value is absent or not a string. Other fields are numbers, booleans, fixed
literals or `null`.

Observed integers (`resources.cpu`, `memoryGiB`, `diskGiB` and `gpu`, the four
`lifecycle` intervals and `binding.generation`) are echoed only from -1 to
99,999. Outside that range, as when the value is not an integer, the field is
`null`, so `binding.generation` can be `null`. Status and reason codes are
decided on the value itself and are the same whether or not it is echoed: a
recorded generation of 100,000 or more that matches the binding is `ready`
with `binding.generation: null`. An identifier that is itself an integer
inside that range cannot be told from a reading. The two counts,
`attachments.volumes` and `exposure.egressAllowListEntries`, are integers from
0 to 999. `attachments.volumes` is 0 when the field is absent, and `null` when
it holds anything else that is not an array, or an array whose length is not
an integer from 0 up. Only an empty array is "no volume": any other present
value, such an array included, is `incompatible` with `volumes_present`.

Three rules behind existing reason codes, all Castles decisions:

- An architecture other than `x86_64`, `amd64`, `aarch64` or `arm64` is
  `incompatible` with `metadata_missing`. No architecture is pinned upstream.
- A network allow list with more than 10 entries is `incompatible` with
  `egress_allow_list_unsafe`, as is any entry wider than `/8`. The figure 10
  comes from public Daytona documentation and is unverified against the
  provider. Domains must be ASCII, and an IP literal is not a domain.
- `autoDestroyAt`, `warmPoolId`, `linkedSandboxId`, `domainAllowList` and
  `networkAllowList` must be present in an `observed` response. An absent
  key is `incompatible` with `metadata_missing` and the key as its field;
  `null` means "not set". An unstated allow list is not also reported as
  `egress_unrestricted`, and block-all does not excuse it. `volumes` may be
  absent and then reads as none. At `13ab3bc` an absent key read as "not set"
  for all six.

JSON output is at most 16,384 bytes.

Reason codes at this revision:

- Binding: `sandbox_id_missing`, `sandbox_id_invalid`, `profile_missing`,
  `unknown_profile`, `owner_binding_missing`, `owner_binding_invalid`,
  `generation_missing`, `generation_invalid`.
- Identity and reconciliation: `owner_mismatch`, `unauthenticated`,
  `binding_mismatch`, `returned_id_mismatch`, `ambiguous_lookup`,
  `generation_mismatch`, `binding_lifecycle_pending`, `attempt_fence_held`,
  `credential_boundary_unverified`.
- Compatibility: `metadata_missing`, `sdk_generation_mismatch`,
  `public_exposure`, `egress_unrestricted`, `egress_allow_list_unsafe`,
  `lifecycle_auto_stop`, `lifecycle_auto_archive`, `lifecycle_auto_delete`,
  `lifecycle_auto_pause`, `lifecycle_ttl`, `image_unqualified`,
  `target_unsupported`, `resources_out_of_policy`, `gpu_present`,
  `volumes_present`, `warm_pool_member`, `linked_sandbox_present`,
  `platform_unsupported`.
- Availability: `upstream_seam_missing`, `provider_unavailable`,
  `inspection_contract_violation`, `sandbox_not_found`, `sandbox_destroyed`,
  `lifecycle_not_settled`, `sandbox_stopped`.

### Readiness predicate

Where: `src/preflight.ts` (`isLiveReady`). Consumers: #3, #5.

```ts
isLiveReady(result) === (result.status === "ready" && result.evidence === "live-provider")
runPreflight(environment, client | null, options?: { timeoutMs?: number })
```

`runPreflight` takes no `evidence` option. Because no live client exists,
`isLiveReady` is false for every result the library produces at this
revision.

A `timeoutMs` that is a number above 2,147,483,647, `Infinity` included, means
the 30,000 ms default, as no value does: a timer would turn it into 1 ms.
Every other value is handed to the timer as given. Node then waits 1 ms for a
number below 1 or `NaN` and converts a value that is not a number; one it
cannot convert ends the check as `provider_unavailable`. What a non-positive
or non-numeric timeout should mean is not decided.

An `environment` that is `null`, `undefined`, a primitive or a function is
reported as `sandbox_id_missing`. `options` that are `null`, a primitive, a
function or an array are ignored. Any other object is read, whatever built
it, so an array can be an `environment`. The client's `inspectBoundSandbox`
property is read once, before the binding is validated, and nothing else is
read from the client or from the method.

These hold for plain values. A property whose read throws, on the
`environment`, the `options` or a response held in memory, still makes
`runPreflight` reject with the caller's own error; only a throwing read of
the client's property is caught. They also assume the realm's built-ins were
intact when `src/preflight.ts` was loaded: the module takes
`Function.prototype.call` and `bind` once, at load, to invoke the seam
method, so code that replaced them before the import decides how the method
is invoked. Code that runs first in the same realm could already decide the
outcome at `13ab3bc` (by replacing `Promise.race`, for example).

**Consumers must gate on this, never on `status` alone.** A fixture replay can
report `status: "ready"`; it is not readiness.

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

`test` runs `tsx --test tests/*.test.ts`, so a new `tests/<name>.test.ts` is
picked up without a manifest change. Three tests depend on the Node version:
two run the CLI under Node's permission model, and one network control also
needs `--allow-net`. On Node 24.22.0 the first two run and only the network
control is skipped; the README lists the versions. Requests to change the
script, add a script or widen `tsconfig.json` go to the #2 steward.

### Source pins and mutation owners

Where: `src/profile.ts` (`SOURCE_PINS`, `MUTATION_OWNERS`). Consumers: #3, #4,
#5.

Where: `src/profile.ts` also exports `OUTSIDE_LISTED_MUTATIONS`.

Eighteen `repo@sha:path` references into
`OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180`.
`MUTATION_OWNERS` has ten rows naming the existing upstream owner of each
sandbox mutation found at the pin: eight for the persistent agent sandbox and
two for the owner's separate, short-lived diagnostic sandbox.
`OUTSIDE_LISTED_MUTATIONS` names two operations that are not lifecycle
mutations (command execution inside a sandbox, snapshot creation). Castles
performs none of these. The table is a reading of the pinned files, not a
proof that no other call site exists upstream.

## Produced by #3

Nothing yet. #3 has published an investigation comment, not an interface. When
it does, this section lists the run, attempt and operation references, the
result and receipt shape, the cancellation interface and the runtime manifest
hashes, with their standing and SHA.

## Produced by #4

Nothing yet. Expected: observe, export and cancel client behaviour, recovery
fixtures, and upstream containment and reuse evidence for #5.

## Produced by #5

**Proposed** in draft PR
[#7](https://github.com/OpenCoven/coven-castles/pull/7) and not on this
branch: the report-task fixture, expected-report properties and the
negative-case catalogue. As of 2026-11-12T05:25Z every review posted on it
asked for changes, the latest at `b401909` with three blocking findings, and
its author is pushing fixes, so no head is named here: read the PR. Nothing in
it is reviewed clean or accepted. These are fixture file formats, not
interface contracts.

## Updating this page

The lane that produces a contract updates its section in the same change that
changes the contract, through the #2 steward (this file is shared). Record the
new SHA and reset the standing to **proposed**.
