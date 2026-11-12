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
| **proposed** | Published by its author at an exact SHA, and either not reviewed or reviewed with a blocking finding open. Opens no gate. A consumer may use it for read-only investigation, failure-case design and offline fixture work only. |
| **reviewed** | A reviewer other than the author has reviewed that exact SHA, the review is linked, and no blocking finding is open. Under #1 this opens the consumer's gate. |
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
2026-11-12T04:30Z. **Its head is about to move.**

| | |
| --- | --- |
| Revision | `7ead0d88fae8ff049a2ed0dedbb0a8221eaeb9fa` |
| Standing | **proposed**: reviewed, with a blocking finding open. Not accepted. The #3 and #5 gates are closed under #1's rule and under the proposed one. |
| Reviews | [At `799488f`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5856050364): changes needed; `7ead0d8` answers it. [At `7ead0d8`](https://github.com/OpenCoven/coven-castles/pull/6#pullrequestreview-5868851188), reviewer `rv6b-0288e674`: changes needed, one blocking finding (a network allow list written as many ranges is reported `ready`) and eleven non-blocking. |
| Next | Worker `cc2c-b25dab53` is fixing PR #6. This section is refreshed against the new head when it is published. |
| Evidence | **fixture** only. No live provider call has been made through this code. |

The subsections below describe the source at `7ead0d8`. Those marked "At
`7ead0d8`, about to change" restate behaviour that the open findings touch:
the result shape, the `evidence` field, which provider fields are echoed, the
egress rule and the exit codes. Do not build on them.

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

> At `7ead0d8`, about to change.

Schema `castles.preflight.v1`:

| Field | Content |
| --- | --- |
| `schema` | `"castles.preflight.v1"` |
| `status` | `ready`, `stopped`, `unavailable`, `incompatible`, `unauthorized` or `reconciliation-required` |
| `reasons` | Up to 16 of `{ code, field? }`. `code` is a fixed literal; `field` is a literal from this module, never provider text |
| `evidence` | `fixture`, `live-provider` or `none` |
| `target` | `sandboxAlias`, `ownerAlias` (redacted, stable aliases), `expectedGeneration`, `profile` |
| `sourcePolicy` | Policy read from pinned source, including the `repo@sha:path` pins. Never derived from the sandbox |
| `observed` | What the seam reported, reduced to bounded safe tokens and numbers, or `null` |
| `providerCalls` | `{ inspect }`: 0 or 1 |
| `upstream` | The upstream seam's issue link and status |

Status precedence when several findings apply: `unauthorized` >
`reconciliation-required` > `incompatible` > `unavailable` > `stopped` >
`ready`.

`observed` is `null` when the binding is invalid, when no client seam is
supplied, when the seam refused, or when the echoed agent record, recorded
sandbox ID or returned sandbox ID differs from the binding. A stale generation
alone does not withhold it.

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

> At `7ead0d8`, about to change.

```ts
isLiveReady(result) === (result.status === "ready" && result.evidence === "live-provider")
```

**Consumers must gate on this, never on `status` alone.** A fixture replay can
report `status: "ready"`; it is not readiness.

### CLI and exit codes

Where: `src/cli.ts`. Consumers: operators, #5.

> At `7ead0d8`, about to change.

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
picked up without a manifest change. Requests to change the script, add a
script or widen `tsconfig.json` go to the #2 steward.

### Source pins and mutation owners

Where: `src/profile.ts` (`SOURCE_PINS`, `MUTATION_OWNERS`). Consumers: #3, #4,
#5.

Sixteen `repo@sha:path` references into
`OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180`, and a table
naming the existing upstream owner of every provider mutation. Castles performs
none of them.

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
negative-case catalogue. As of 2026-11-12T04:30Z its head is
`b4019094e1deacfbcfa42ac61d50354198064ba7`, which answers a review of
`52cd317` that asked for changes and has not itself been reviewed. These are
fixture file formats, not interface contracts.

## Updating this page

The lane that produces a contract updates its section in the same change that
changes the contract, through the #2 steward (this file is shared). Record the
new SHA and reset the standing to **proposed**.
