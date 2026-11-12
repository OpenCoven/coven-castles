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

Snapshot of draft PR
[#6](https://github.com/OpenCoven/coven-castles/pull/6) taken
2026-11-12T05:40Z. Everything below describes the source at this revision.

| | |
| --- | --- |
| Revision | `13ab3bc2c823fe12b482a6701ab4df2c28e6733c` |
| Standing | A second-read review found no blocking findings at this revision. It is not yet **reviewed** in this page's sense, because #2's Review row names maintainer review. **Not accepted**; acceptance is the maintainer's. |
| Reviews | [At this revision](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5869660940), reviewer `rv6c-3db7f9d0`: no blocking findings, seven non-blocking. The reviewer was started by the coordinating session that also started the author, and says the review is a second read, not independent review, and that it opens no gate. #2 is labelled `risk:r3`. Earlier heads, both changes needed: [`799488f`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5856050364), [`7ead0d8`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5868851188). |
| Gates | #3's gate is closed: it needs the accepted #2 artifact under #1 and under the proposed rule. #5's harness-wiring gate needs #2's reviewed package and test command; the review #2 names is the maintainer's and has not happened, so that gate is closed too. |
| Evidence | **fixture** only. No live provider call has been made through this code. |

If PR #6's head is no longer this revision, this section is stale until it is
refreshed.

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
inside that range cannot be told from a reading.

Two rules behind existing reason codes, both Castles decisions:

- An architecture other than `x86_64`, `amd64`, `aarch64` or `arm64` is
  `incompatible` with `metadata_missing`. No architecture is pinned upstream.
- A network allow list with more than 10 entries is `incompatible` with
  `egress_allow_list_unsafe`, as is any entry wider than `/8`. The figure 10
  comes from public Daytona documentation and is unverified against the
  provider. Domains must be ASCII, and an IP literal is not a domain.

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

`timeoutMs` is used when it is a number from 1 to 2,147,483,647; any other
value, like no value, means the 30,000 ms default. An `environment` that is
not an object is reported as `sandbox_id_missing`, and `options` that are not
an object are ignored; neither throws.

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
