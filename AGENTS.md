# Agent guide

Castles is a thin, CLI-first preflight package. It is not an authority, a
backend, or a provider adapter. The outcome issues are the spec:
[#1](https://github.com/OpenCoven/coven-castles/issues/1) (epic and rules) and
its children #2–#5.

## Hard rules

- **Read-only.** Castles itself never creates, starts, stops, resizes,
  archives, resets or deletes a sandbox, and never changes provider
  configuration. A stop/start that #4 or #5 calls for is authorized separately
  and goes through the canonical owner. Do not call the live provider at all
  without explicit authorization for a named window.
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
corepack pnpm check --fixture fixtures/preflight/cases/ready.json   # exits 3: fixture, never readiness
```

Add a failing boundary test before a fix (committing it separately is a
proposed addition to #1). Report exact commands and results. Enable the secret-scanning hook once per clone:
`git config core.hooksPath .githooks` (needs gitleaks).

## Paths and ownership

Edit only the paths your issue owns. The full table, including the steward of
every shared file, is [`docs/ownership.md`](docs/ownership.md).

| Paths | Owner |
| --- | --- |
| `src/profile.ts`, `src/preflight.ts`, `tests/preflight.test.ts`, `fixtures/preflight/` | #2 |
| `src/run.ts`, `runtime/`, `tests/run.test.ts` | #3 |
| `src/observe.ts`, `src/export.ts`, `tests/recovery.test.ts` | #4 |
| `fixtures/report-task/`, `tests/mvp.test.ts`, `scripts/smoke.ts`, `docs/acceptance.md` | #5 |
| CLI entrypoint, package and toolchain files, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, shared `docs/`, `.github/` templates | #2 as shared-file steward (proposed for the last three) |

Changing a path you do not own needs a linked request and an explicit handoff
from its steward. The epic maintainer resolves overlap.

## Claims and handoffs

Full rules, a worked example and what to do when claims collide:
[`docs/coordination.md`](docs/coordination.md). The essentials:

- Before editing, re-read the issue, its assignee, latest comments and linked
  PRs. One primary contributor per issue.
- Use a unique worker ID, one branch (`castles/<issue>-<slug>-<worker>`) and
  one worktree of your own. Never share a writable checkout. Never force-push
  another contributor's branch.
- A new session is a new worker: take over by explicit handoff.
- If claims collide, stop and let the existing owner or the epic maintainer
  resolve it. A missed checkpoint is a reason to ask, not to take over.
- A claim, label or assignment is coordination only: it grants no permission
  to spend, deploy, reset, publish, merge or change credentials.
- A gate opens on a linked, reviewed capability at an exact revision, not on
  a merge, a label or a closed checkbox. A maintainer confirms acceptance
  before closure. Proposed, not yet decided: acceptance for every gate
  ([`docs/contracts.md`](docs/contracts.md#standing)).

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

## Review

`risk:r4` changes need independent review; name the reviewer and the reviewed
SHA in the handoff. Proposed additions to #1 (no self-review or self-merge,
fresh clone at an exact SHA, no re-review of your own fixes, comment-only
reviews on a shared account) are in
[`docs/coordination.md`](docs/coordination.md#review).

## PR checklist

The pull request template carries the full checklist
([`.github/pull_request_template.md`](.github/pull_request_template.md)). The
points that are most often missed:

- [ ] `Refs #N` (no closing keyword while acceptance is unverified)
- [ ] Consumed and produced contracts, with exact revisions
- [ ] Changed paths, all owned or handed off
- [ ] Exact-head checks: command, result, evidence class (fixture / real-daemon / live-provider; `static` if no behaviour ran)
- [ ] Remaining live gates stated; nothing fixture-only called verified
- [ ] No secrets, real IDs or raw provider errors
- [ ] Not self-reviewed, not self-merged

## More

[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and commands;
[`docs/README.md`](docs/README.md) for the index of all documentation.
