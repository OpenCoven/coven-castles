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

Still undecided on 2026-11-12. That day the maintainer accepted the #2
contract at an exact SHA (see [Produced by #2](#produced-by-2)), and the pull
request that carries this proposal,
[#9](https://github.com/OpenCoven/coven-castles/pull/9), was merged as
`a4ced7b463edccbe2ddd89ad12645b60f0aacefb`. The
[comment recording the acceptance and the instruction to merge](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865),
posted by the coordinating session before the merges, says the decisions
listed in that pull request's body, the gate rule among them, "remain open;
merging them is not a decision on those items".

Any change to a contract after review or acceptance is a new revision and
starts again as **proposed**.

## Produced by #2

Snapshot of PR [#6](https://github.com/OpenCoven/coven-castles/pull/6)
taken 2026-11-12T05:40Z. The PR was merged into `main` later that day as
`978a2465df8d3af5b8e693fa9d228a9055aa1db8`, and the Standing, Acceptance
limits and Gates rows were refreshed 2026-11-12T21:48Z. Everything below
describes the source at the revision in the first row.

| | |
| --- | --- |
| Revision | `13ab3bc2c823fe12b482a6701ab4df2c28e6733c` |
| Standing | **Accepted** by the maintainer on 2026-11-12, in [this comment on #2](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865), which names this SHA. Accepted artifact, in the comment's words: "the profile/binding result shape, client seam, source pins and offline test command as they stand at" this revision. Basis: the review at this revision in the next row; the comment says the maintainer was told it is a second read, not independent review, "and accepted on that basis". The comment was posted by the coordinating agent session on the shared account and records a decision the maintainer gave in that session. |
| Reviews | [At this revision](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5869660940), reviewer `rv6c-3db7f9d0`: no blocking findings, seven non-blocking. The reviewer was started by the coordinating session that also started the author, and says the review is a second read, not independent review, and that it opens no gate. #2 is labelled `risk:r3`. Earlier heads, both changes needed: [`799488f`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5856050364), [`7ead0d8`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5868851188). |
| Acceptance limits | The evidence behind the acceptance is fixture and static only. It authorizes no live provider call, spending, deployment or sandbox mutation, and changes no label or assignee. Three known follow-ups are not fixed at this revision: integer fields can echo an all-digit configured ID (R1); the capability scan does not stop a read of another environment variable (R2); five provider fields are not examined (R3). It is not a decision on the gate rule or on any other proposed addition; see [Standing](#standing). |
| Gates | What follows from the acceptance, under #1's rule and under the proposed rule. This page does not choose between them, and it does not say that #3's start gate or #5's harness-wiring gate is met. **Accepted artifact:** #1's gate for #3 ("Consume the accepted #2 artifact") and #3's Consumes row ask for the accepted #2 artifact, and the proposed rule asks for maintainer acceptance. Acceptance at this revision is recorded, so that condition is met under both rules. **Reviewed contract:** #1 also says #3's implementation "starts against #2's reviewed contract", #3's Start gate row asks for "a reviewed profile/binding/client contract and exact source pins", and #5's Harness wiring gate row asks for "#2's reviewed package/test command and binding-result contract" (#1's own words for #5 are "Wire executable tests after #2"). A linked review with no blocking findings, and the acceptance given on it, both exist at this revision. Whether that supplies "reviewed" for #2, which this page reads as the maintainer review #2's Review row names, is one of the open decisions, and the acceptance comment does not address it. It is the same open reading for #3 and for #5. **#3 is not unblocked either way:** it is still labelled `status:blocked`. Besides the #2 contract, the [latest blocker line on #3](https://github.com/OpenCoven/coven-castles/issues/3#issuecomment-6791203058) names OpenCoven/coven-agents #297 and #298, a familiar-revision gap that had no upstream issue when it was written, #299 or a waiver, and #300. #300 has since been decided for Castles; #297, #298 and #299 are open on 2026-11-12. #262, also open, is not in that line: it gates the second run in #4 and #5. See [`architecture.md`](architecture.md#open-upstream-dependencies). **Live:** no live gate is open. Live preflight still needs the upstream seam ([coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296), open) and explicit authorization. |
| Evidence | **fixture** only. No live provider call has been made through this code. |

PR #6 is merged, so its head no longer moves. At
`b5d7fc14add09fa94a7103031d7d625f710e519c`, `src/cli.ts`, `src/preflight.ts`,
`src/profile.ts`, `tests/preflight.test.ts`, `fixtures/preflight/`,
`package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `.env.example` on `main`
are identical to the revision in the first row. If the #2 contract described
below changes, this section is stale until it is refreshed, and the changed
contract is a new revision (see [Standing](#standing)).

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
| `evidence` | `fixture`, `live-provider` or `none`. Derived from the client, never supplied by the caller: no client gives `none`, any client gives `fixture`, including when the binding is invalid. The library cannot return `live-provider` at this revision |
| `target` | `sandboxAlias`, `ownerAlias` (redacted, stable aliases), `expectedGeneration`, `profile` |
| `sourcePolicy` | Policy from `SUPPORTED_PROFILE`, with the `repo@sha:path` pins. Never derived from the sandbox. Most values are read from pinned source; `network.networkAllowList` (`{ basis: "castles-decision", maxEntries: 10, minIpv4Prefix: 8 }`) is a Castles decision with no upstream pin |
| `observed` | What the seam reported, or `null`. Provider text is never copied: see below |
| `providerCalls` | `{ inspect }`: 0 or 1 |
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

On `main` since 2026-11-12: the report-task fixture, expected-report
properties and the negative-case catalogue, in `fixtures/report-task/`. They
arrived with PR [#7](https://github.com/OpenCoven/coven-castles/pull/7),
merged at head `302bb4533aaccde8165d8efe596502da286891b0` as
`b5d7fc14add09fa94a7103031d7d625f710e519c`.

The
[latest review](https://github.com/OpenCoven/coven-castles/pull/7#pullrequestreview-5870277806),
at that head, found no blocking findings and two non-blocking; earlier
reviews at earlier heads asked for changes. The reviewer says it is a second
read, not the independent review #1 asks for on a `risk:r4` lane, so the
formats are not **reviewed** in this page's sense. They are **not accepted**:
the [comment recording the maintainer's decision](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865)
names only the #2 artifact as accepted, records the instruction to merge PR #7
at that head, and says the decisions in that pull request's body (the pinned
fixture limits) remain open and that merging is not a decision on them. These
are fixture file formats, not interface contracts.

## Updating this page

The lane that produces a contract updates its section in the same change that
changes the contract, through the #2 steward (this file is shared). Record the
new SHA and reset the standing to **proposed**.
