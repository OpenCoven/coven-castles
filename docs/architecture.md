# Architecture

## What Castles is

A thin, CLI-first package for **one** job: letting an authenticated owner use
one explicitly supplied, existing Daytona sandbox to run one bounded familiar
task, reconnect to it, retrieve the result, and safely run a second task.

Castles is a client and a conformance check. It supplies a sandbox profile, a
read-only preflight, and, as the later lanes land, a run entrypoint and
recovery commands that call the existing canonical service.

## What Castles is not

- Not an authority. It decides nothing about identity, ownership, admission or
  permission.
- Not a backend. No server, database, queue, scheduler or object store.
- Not a provider adapter. It does not depend on the Daytona SDK and holds no
  provider credential.
- Not a fleet manager. One sandbox, one familiar, one active attempt.
- Not a second copy of anything upstream. Where the canonical owner lacks a
  capability, the answer is a linked upstream issue.

## What exists today

Only the read-only preflight from #2, and only against synthetic fixtures.

```text
src/profile.ts     pinned source policy, source pins, binding parser
src/preflight.ts   client seam, evaluation, result shape, rendering
src/cli.ts         `castles check`
tests/             offline tests
fixtures/preflight synthetic inspection cases
```

There is no live path. A fully configured `castles check` reports
`unavailable` with `upstream_seam_missing` and makes zero provider calls,
because the read-only seam it needs does not exist upstream yet. Everything
described below as #3 or #4 is planned, not built.

## The trust boundary

```text
 operator machine                canonical service                 provider
 (untrusted client)              (Coven Agents, trusted)           (Daytona)
+--------------------+          +---------------------------+     +-----------+
| castles CLI        |          | authentication            |     |           |
|  - binding (IDs,   |  HTTPS   | admission and idempotency |     |  one      |
|    not authority)  +--------->| credential custody        +---->|  existing |
|  - preflight       |  owner   | durable run records       | SDK |  sandbox  |
|  - (run, observe,  |  creds   | sandbox lifecycle         |     |           |
|     export: later) |          | cleanup fences            |     +-----+-----+
+--------------------+          +---------------------------+           |
                                                                         v
                                                              +-------------------+
                                                              | task guest        |
                                                              | (untrusted)       |
                                                              | bounded input,    |
                                                              | one attempt-scoped|
                                                              | harness credential|
                                                              +-------------------+
```

What crosses each line:

| From → to | Crosses | Never crosses |
| --- | --- | --- |
| Castles → canonical service | The owner's own credential, the binding, an operation ID, task text | A provider key, a database credential, a dispatch authority |
| Canonical service → provider | Provider API calls made by the existing adapter | Anything initiated directly by Castles |
| Canonical service → task guest | Bounded task context and one attempt-scoped harness credential | Provider or admin keys, signing material, control-plane database credentials |
| Anything → public issues and logs | Redacted aliases, fixed reason codes, revisions, hashes | Secrets, real sandbox or owner IDs, raw provider errors, private source |

Three consequences that shape the code:

1. **The sandbox ID is a target, not authorization.** The CLI can name a
   sandbox; only the canonical service, from its authenticated caller, decides
   whether that caller owns it. Account login, familiar name and subscription
   state are not execution authority either.
2. **The provider response is untrusted input** even though it arrives through
   a trusted service. Preflight reduces it to bounded tokens and numbers and
   fails closed on anything it does not recognise.
3. **A failed check has nothing to fall back to.** The client seam has one
   method. There is no create, start, list or lookup-by-name to reach for when
   the exact sandbox is missing.

## What stays upstream

| Concern | Canonical owner |
| --- | --- |
| Identity semantics | Familiar Contract |
| Protected decisions | Threads |
| Orchestration semantics | Psyche |
| Authoritative runtime transitions | Coven |
| Admission, credential custody, durable run records, Daytona lifecycle | Coven Agents |

Every provider mutation has an existing owner in Coven Agents, recorded with a
source pin in `MUTATION_OWNERS` in `src/profile.ts`:

| Mutation | Existing owner | Castles |
| --- | --- | --- |
| create | `lib/runner/daytona/sandbox.ts` | never |
| start | `lib/runner/daytona/sandbox.ts` | never |
| stop, archive | provider policy set at create | never |
| resize | `lib/runner/daytona/resource-repair.ts` | never |
| delete, reset | `lib/runner/daytona/sandbox.ts`, `resource-recovery.ts` | never |
| adopt policy | `lib/runner/daytona/sandbox.ts` | never |

Persistent sandbox files are working state. Identity, selected context, durable
task and attempt records and the committed outcome live in their canonical
owners outside the task guest, so a result remains retrievable when the sandbox
is stopped or gone. Reconnect does not replay a task, and stop/start does not
promise that a process or its memory survived.

## The one supported profile

`castles.daytona-private-linux.v1`: a private, persistent Linux sandbox; one
familiar; one active attempt; at most 900 seconds per attempt or the tighter
existing bound. Starting target 2 vCPU / 4 GiB RAM / 10 GiB disk, taken from a
documented upstream pilot and **not measured** on any supplied sandbox.

Preflight checks, read-only: owner binding and generation, the recorded and
returned sandbox IDs, lifecycle state, the credential-boundary marker,
attempt fence, privacy, egress allow lists entry by entry, auto-stop,
auto-archive, auto-delete, auto-pause and TTL, image snapshot, target,
resources, GPU, volumes, warm-pool and linked-sandbox membership, platform and
SDK generation. Missing metadata or an unsafe policy fails; nothing is
repaired. A stopped sandbox is reported as stopped and is not woken.

Policy values and the upstream file each one came from are in
`SUPPORTED_PROFILE` and `SOURCE_PINS` in `src/profile.ts`.

## Pinned upstream sources

All at `OpenCoven/coven-agents@3a4f3ff4130860d0abda1d2207b43b2f9d372180`. The
repository is private; these links need access.

- [Ownership and execution overview](https://github.com/OpenCoven/coven-agents/blob/3a4f3ff4130860d0abda1d2207b43b2f9d372180/README.md)
- [ADR-002: Daytona execution boundary](https://github.com/OpenCoven/coven-agents/blob/3a4f3ff4130860d0abda1d2207b43b2f9d372180/docs/architecture/adr-002-daytona-execution-boundary.md)
- [Cloud pilot integration: authority and repeat-run gaps](https://github.com/OpenCoven/coven-agents/blob/3a4f3ff4130860d0abda1d2207b43b2f9d372180/docs/product/cloud-pilot-integration.md)

Provider documentation: [persistence](https://www.daytona.io/docs/en/persistence/)
and [sandbox lifecycle](https://www.daytona.io/docs/en/sandboxes/). Validate
against the pinned SDK generation (`@daytona/sdk` 0.220.0), not another API
generation.

A pin records what was read. It is refreshed deliberately, in a change that
re-checks every value derived from it.

## Open upstream dependencies

Each of these blocks part of the MVP and is owned outside this repository.
States are as of 2026-11-11; check the issue before relying on this list.

| Upstream issue | Needed for | State |
| --- | --- | --- |
| [coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296) Read-only seam: inspect one pre-bound sandbox by exact ID | Any live preflight (#2) | open |
| [coven-agents#297](https://github.com/OpenCoven/coven-agents/issues/297) Non-browser owner audience for the run API | Running, observing or cancelling from a CLI (#3, #4) | open |
| [coven-agents#298](https://github.com/OpenCoven/coven-agents/issues/298) Bind dispatch to one supplied sandbox and refuse instead of creating | Running on the supplied sandbox (#3) | open |
| [coven-agents#299](https://github.com/OpenCoven/coven-agents/issues/299) Server-side read-only execution permission for one owner run | Enforcing "no remote writes" outside the prompt (#3) | open |
| [coven-agents#300](https://github.com/OpenCoven/coven-agents/issues/300) Bootstrap decision: snapshot verification or an admitted install | Bootstrap (#3) | open |
| [coven-agents#262](https://github.com/OpenCoven/coven-agents/issues/262) Resource bounds, process containment and safe sandbox reuse | A second task on the same sandbox (#4, #5) | open |

The investigation comments on #3 and #4 list further gaps (familiar revision
in admission, receipt and attempt references on the outcome) that are not yet
tracked by an upstream issue.

## Deliberately out of scope

Billing and pricing, custom databases or new data services, multi-tenancy,
generalized provider interfaces, always-on claims, automatic failover, local
models, desktop or browser automation, nested containers, swarms and
marketplaces. See the "Explicitly deferred" section of
[#1](https://github.com/OpenCoven/coven-castles/issues/1).
