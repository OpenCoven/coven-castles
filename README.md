# coven-castles

Sandcastles for sandboxed familiars.

A tiny operator package that checks **one explicitly configured, existing
Daytona sandbox** and reports whether it is fit to host a familiar. It is
read-only: it never creates, starts, resizes or deletes anything.

> **Status.** Offline and fixture-verified only. No live sandbox has been
> checked. The live path is blocked on an upstream read-only seam:
> [OpenCoven/coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296).

## Quickstart

Requires Node 22+ and Corepack (pnpm 10.32.1 is pinned in `package.json`).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm check --fixture fixtures/preflight/cases/ready.json            # exits 3
corepack pnpm check --json --fixture fixtures/preflight/cases/public-exposure.json   # exits 1
```

The tests need no credentials and no IP networking. A fixture replay never
exits 0, so pnpm reports both commands above as failed; that is intended.

## The check command

```text
castles check [--json] [--fixture <case.json>]
```

| Status | Meaning |
| --- | --- |
| `ready` | The bound sandbox is running and matches the profile. |
| `stopped` | It matches but is stopped or archived. The check does not wake it. |
| `unavailable` | Not configured, not found, provider unreachable, or not settled. |
| `incompatible` | Unknown profile, unsafe policy, public exposure, or missing metadata. |
| `unauthorized` | The owning service refused, or its record binds a different sandbox. |
| `reconciliation-required` | Stale generation, ambiguous lookup, a returned ID that differs, or an unresolved prior attempt. |

| Exit code | Meaning |
| --- | --- |
| `0` | `ready`, from a live provider read. Unreachable until the upstream seam exists. |
| `1` | Any status other than `ready`. |
| `2` | Usage error, or an unreadable fixture file. |
| `3` | A fixture replay reported `ready`. Synthetic input, never readiness. |

Anything that consumes a result must require `status: "ready"` **and**
`evidence: "live-provider"` (`isLiveReady()` in `src/preflight.ts`), never
`status` alone.

Without `--fixture` the binding is read from `CASTLES_PROFILE`,
`CASTLES_SANDBOX_ID`, `CASTLES_OWNER_AGENT_ID` and
`CASTLES_SANDBOX_GENERATION` (see [`.env.example`](.env.example)). Exported
variables win over an optional `.env.local`, which is read from the directory
the command is run in; only those four keys are read from it. Because the
upstream seam does not exist yet, a fully configured live check currently
reports `unavailable` / `upstream_seam_missing` rather than guessing an
endpoint. With `--fixture`, everything comes from one synthetic case file and
the output is marked `evidence: fixture`.

`--json` emits `castles.preflight.v1`: bounded, with redacted aliases in place
of private IDs, and with `sourcePolicy` (pinned from source) kept separate from
`observed` (what the provider reported through the seam).

## What a check will and will not do

- The sandbox ID is a target, not authorization. Ownership is decided by the
  owning service from its authenticated caller.
- No lookup by name, label or first match. A missing or ambiguous sandbox is
  reported, never replaced or adopted.
- Missing metadata or an unsafe policy (ephemeral or TTL deletion, auto-delete,
  public preview, unrestricted egress, out-of-policy resources) fails the
  check. Nothing is repaired.
- An egress allow list is read entry by entry. Each domain must be a plain
  multi-label name (a single leading `*.` label is allowed, as the owning
  service allows it); each network entry must be an IPv4 range from `/8` to
  `/32`. A bare `*`, an any-address range such as `0.0.0.0/0`, a wider range,
  a bare address and every IPv6 entry fail the check.
- `autoDestroyAt`, `volumes`, `warmPoolId` and `linkedSandboxId` are optional
  in the provider model: an absent key means "not set", any present value
  fails.
- Castles holds no provider, database or harness credential.
- Even a read-only inspection may count as provider activity and so affect
  idle auto-stop timers. Run a check when you need one; do not schedule
  permanent polling.

## The supported profile

`castles.daytona-private-linux.v1`: one private, persistent Linux sandbox; one
familiar; one active attempt. Starting target 2 vCPU / 4 GiB RAM / 10 GiB disk,
subject to what the supplied sandbox actually has. `@daytona/sdk` generation
`0.220.0`. Policy values and their `repo@sha:path` source pins live in
[`src/profile.ts`](src/profile.ts), alongside the existing upstream owner of
every provider mutation.

## Secrets protection

Commits are scanned for secrets with [gitleaks](https://github.com/gitleaks/gitleaks). Enable the pre-commit hook once per clone:

```sh
brew install gitleaks   # or see the gitleaks install docs
git config core.hooksPath .githooks
```

The hook blocks any commit whose staged changes contain a likely secret. CI runs the same scan on every push and pull request, so skipping the hook does not skip the check. Handle false positives with an allowlist in `.gitleaks.toml` or a trailing `gitleaks:allow` comment.

## Contributing

See [`AGENTS.md`](AGENTS.md) for the rules, path ownership, the claim/handoff
block and the PR checklist. Fixtures are described in
[`fixtures/preflight/README.md`](fixtures/preflight/README.md).
