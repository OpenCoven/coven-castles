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

Two tests back the "read-only" claim, and neither is a proof. A static scan
reads every file under `src/` for imports, re-exports and uses of `process`
outside a short allowlist; it is a tripwire, and the test file lists evasions
it is known to miss. A second test runs the CLI under Node's permission model
with file writes, child processes, workers, addons, WASI and code generation
from strings denied. That one needs a Node with `--permission` and built-in
type stripping: it runs on Node 22.23.5, 24.22.0 and 26.12.0 and is skipped
on Node 22.0.0. Network is denied at run time only on a Node that has
`--allow-net` (26 here; not 22 or 24). `pnpm check` itself runs without the
permission model.

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
`status` alone. The evidence class is derived from the client, not supplied
by the caller; no live client exists yet, so the library cannot currently
return `live-provider`.

Without `--fixture` the binding is read from `CASTLES_PROFILE`,
`CASTLES_SANDBOX_ID`, `CASTLES_OWNER_AGENT_ID` and
`CASTLES_SANDBOX_GENERATION` (see [`.env.example`](.env.example)). Exported
variables win over an optional `.env.local`, which is read from the directory
the command is run in. Node loads every key of that file into the process
environment; only those four are consumed, and nothing else is looked up,
copied or printed. Because the
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
  multi-label name with no wildcard anywhere; each network entry must be an
  IPv4 range from `/8` to `/32`. A `*` in any position (including
  `*.example.test`), an any-address range such as `0.0.0.0/0` or `::/0`, a
  wider range, a bare address and every IPv6 entry fail the check. Domains
  are ASCII only, and an IP literal is not a domain. The domain rule is
  stricter than the owning service, which accepts a leading `*.` label: a
  sandbox configured that way is reported `incompatible`.
- A network allow list with more than 10 entries fails the check, because a
  list split into many ranges (256 ranges of `/8` are every address) is not
  a restriction. The network-list rules (`/8` to `/32`, at most 10 entries)
  and the acceptance of `networkBlockAll` are **Castles decisions with no
  upstream pin**: the owning service configures a domain allow list only.
  The figure 10 comes from the public Daytona network-limits documentation
  and has not been verified against the provider.
- `autoDestroyAt`, `volumes`, `warmPoolId` and `linkedSandboxId` are optional
  in the provider model: an absent key means "not set", which matches the
  owning service's drift inventory. An explicit `null` is also read as "not
  set" here, where the owner's inventory would report drift. Any other
  present value fails.
- Provider-supplied text is never printed. Observed fields carry a value
  from a fixed set, a three-part SDK version, `unrecognised`, or null.
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
each sandbox mutation found at the pin (including the owner's separate
diagnostic sandbox), and the two operations that are outside that table.

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
