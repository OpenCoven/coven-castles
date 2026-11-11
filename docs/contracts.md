# Contracts between lanes

A lane hands work to the next lane as a **contract at an exact revision**, not
as "what is on main". This page lists each contract a lane produces, its
standing, and who consumes it.

These are client contracts. None of them is authority: holding a binding, a
result or a sandbox ID authorizes nothing.

## Standing

| Standing | Meaning |
| --- | --- |
| **proposed** | Published by its author at an exact SHA. May be read and built against in a stacked draft, at the consumer's risk. |
| **reviewed** | A reviewer other than the author has reviewed that SHA and recommends acceptance. |
| **accepted** | The maintainer has accepted the review at that SHA in a comment. Only this opens a consumer's gate. |

Any change to a contract after acceptance is a new revision and goes through
the same three steps.

## Produced by #2

All at `7ead0d88fae8ff049a2ed0dedbb0a8221eaeb9fa` on draft PR
[#6](https://github.com/OpenCoven/coven-castles/pull/6).

**Standing: proposed.** A review of the earlier head `799488f` asked for
changes; `7ead0d8` answers it and has not been re-reviewed. Nothing here is
reviewed or accepted, and the #3 and #5 gates are closed.

Evidence for everything below is **fixture** only. No live provider call has
been made through this code.

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
| `evidence` | `fixture`, `live-provider` or `none` |
| `target` | `sandboxAlias`, `ownerAlias` (redacted, stable aliases), `expectedGeneration`, `profile` |
| `sourcePolicy` | Policy read from pinned source, including the `repo@sha:path` pins. Never derived from the sandbox |
| `observed` | What the seam reported, reduced to bounded safe tokens and numbers, or `null` |
| `providerCalls` | `{ inspect }`: 0 or 1 |
| `upstream` | The upstream seam's issue link and status |

Status precedence when several findings apply: `unauthorized` >
`reconciliation-required` > `incompatible` > `unavailable` > `stopped` >
`ready`.

`observed` is `null` whenever the seam refused, or the echoed agent record,
recorded sandbox ID or returned sandbox ID differs from the binding. A stale
generation alone does not withhold it.

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
```

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

Proposed in draft PR
[#7](https://github.com/OpenCoven/coven-castles/pull/7) and not on this
branch: the report-task fixture, expected-report properties and the
negative-case catalogue. A review has asked for changes. These are fixture file
formats, not interface contracts.

## Updating this page

The lane that produces a contract updates its section in the same change that
changes the contract, through the #2 steward (this file is shared). Record the
new SHA and reset the standing to **proposed**.
