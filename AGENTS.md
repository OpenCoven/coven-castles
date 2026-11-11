# Agent guide

Castles is a thin, CLI-first preflight package. It is not an authority, a
backend, or a provider adapter. The outcome issues are the spec:
[#1](https://github.com/OpenCoven/coven-castles/issues/1) (epic and rules) and
its children #2–#5.

## Hard rules

- **Read-only.** Never create, start, stop, resize, archive, reset or delete a
  sandbox, and never change provider configuration. Do not call the live
  provider at all without explicit authorization for a named window.
- **No second adapter.** Provider I/O goes only through
  `SandboxInspectionClient` in `src/preflight.ts`, backed by the existing
  Coven Agents lifecycle owner. If upstream lacks a capability, open a linked
  issue there; do not guess an endpoint or copy provider logic here.
- **The sandbox ID is a target, not authorization.** No lookup by name, label,
  or first match. A failed or ambiguous lookup never falls back.
- **No secrets, real sandbox IDs or raw provider errors** in commits, issues,
  PRs, logs or fixtures. Output uses redacted aliases.
- **Fixtures are synthetic** and say so. A fixture pass is never live evidence.
- No server, database, Docker service, provider abstraction or assignment bot.

## Commands

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test        # offline; no credentials, no network
corepack pnpm typecheck
corepack pnpm check --fixture fixtures/preflight/cases/ready.json
```

Add a failing boundary test before a fix. Report exact commands and results.

## Paths and ownership

| Paths | Owner |
| --- | --- |
| `src/profile.ts`, `src/preflight.ts`, `tests/preflight.test.ts`, `fixtures/preflight/` | #2 |
| `src/cli.ts`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.gitignore`, `.env.example`, `AGENTS.md`, `README.md` | #2 as shared-file steward |
| `src/run.ts`, `runtime/`, `tests/run.test.ts` | #3 |
| `src/observe.ts`, `src/export.ts`, `tests/recovery.test.ts` | #4 |
| `fixtures/report-task/`, `tests/mvp.test.ts`, `scripts/smoke.ts`, acceptance notes | #5 |

Changing a path you do not own needs a linked request and an explicit handoff
from its steward. The epic maintainer resolves overlap.

## Claims and handoffs

Before editing, re-read the issue, its assignee, latest comments and linked
PRs. One primary contributor per issue. Agents sharing a GitHub identity use
distinct worker IDs and branches (`castles/<issue>-<slug>-<worker>`), each in
its own worktree. Never share a writable checkout or force-push. If claims
collide, stop and let the existing owner or the epic maintainer resolve it.
A claim or label is coordination only: it grants no permission to spend,
deploy, reset, publish, merge or change credentials.

Post this block on the issue at start, at material checkpoints, at review and
when relinquishing:

```text
Worker / GitHub owner:
Claimed issue and bounded scope:
Branch / draft PR / base SHA / head SHA:
Owned paths; shared-file agreement:
Consumes: prerequisite issue + contract/revision/evidence link
Produces: contract/artifact + exact revision
Checks: exact command -> pass/fail/skip; fixture/real-daemon/live-provider
Blocker: exact condition + dependency/decision owner + evidence needed
Next executable action:
Next checkpoint (UTC):
Handoff: retaining claim / relinquishing to named recipient
```

Exactly one `status:*` label per open issue: `ready`, `ready-offline`,
`in-progress`, `in-review`, or `blocked` (with a concrete unblock condition).

## PR checklist

- [ ] `Refs #N` (no closing keyword while acceptance is unverified)
- [ ] Consumed and produced contracts, with exact revisions
- [ ] Changed paths, all owned or handed off
- [ ] Exact-head checks: command, result, evidence class (fixture / live)
- [ ] Remaining live gates stated; nothing fixture-only called verified
- [ ] No secrets, real IDs or raw provider errors
- [ ] Not self-reviewed, not self-merged
