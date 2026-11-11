# Contributing

Read this before your first change. It is written for people and for agent
sessions alike, and assumes you have read nothing else.

This repository is worked on by several contributors at once, often under one
GitHub account. The rules that keep that safe are in
[`docs/coordination.md`](docs/coordination.md); this page is the practical
part: setup, commands and what a change must contain.

The outcome issues are the spec:
[#1](https://github.com/OpenCoven/coven-castles/issues/1) and its children #2
to #5. Where any document here disagrees with them, the issues win.

## Before you start

1. Read [#1](https://github.com/OpenCoven/coven-castles/issues/1) and the
   issue you intend to work on, including every comment.
2. Read [`docs/coordination.md`](docs/coordination.md) and find your paths in
   [`docs/ownership.md`](docs/ownership.md).
3. If the issue is already claimed, stop and comment instead of starting.
4. Post a claim with the handoff block before you edit anything.

## Setup

Requires Node 22 or later and Corepack. pnpm 10.32.1 is pinned in
`package.json`; Corepack selects it.

```sh
git clone https://github.com/OpenCoven/coven-castles.git
cd coven-castles
corepack pnpm install --frozen-lockfile
```

Enable the secret-scanning pre-commit hook once per clone. It needs
[gitleaks](https://github.com/gitleaks/gitleaks#installing) on your `PATH`.

```sh
brew install gitleaks   # or see the gitleaks install docs
git config core.hooksPath .githooks
```

The hook blocks a commit whose staged changes look like they contain a secret.
CI runs the same scan on every push and pull request, so skipping the hook does
not skip the check.

No credentials are needed for anything in this repository. If a step seems to
need a provider key, a database URL or a harness token, you are off the
supported path: stop and ask.

## Work in your own worktree

One branch and one worktree per worker. Pick a worker ID first
(`<prefix>-$(openssl rand -hex 4)`).

```sh
git fetch origin
git worktree add -b castles/<issue>-<slug>-<worker-id> \
  ../coven-castles.worktrees/<issue>-<slug>-<worker-id> origin/main
```

Never work in someone else's worktree, never share a writable checkout, and
never force-push. When `main` moves, merge it into your branch and re-run the
checks.

## Commands

```sh
corepack pnpm test         # offline tests; no credentials, no IP networking
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm check --fixture fixtures/preflight/cases/ready.json
```

The last command replays one synthetic case. It prints `status: ready` and
exits `3`, so pnpm reports it as failed. That is intended: a fixture replay is
never readiness and never exits `0`. Exit codes are listed in the
[README](README.md#the-check-command).

Run `test` and `typecheck` before every push.

## Test first

Add a failing test at the real boundary before the fix, and commit it
separately so the history shows red, then green.

- Tests for a lane live in that lane's test file. See
  [`docs/ownership.md`](docs/ownership.md).
- A test that cannot fail is not evidence. If you offer a test as proof of a
  safety property, break the behaviour locally and confirm the test goes red.
- Prefer allowlists to blocklists when asserting that something cannot happen.
- Negative cases assert the refusal **and** that nothing else happened: zero
  provider calls, zero credential transfers, nothing disclosed.

## Evidence classes

Say which class every result belongs to. A higher class is never inferred from
a lower one.

| Class | Meaning |
| --- | --- |
| **fixture** | Offline test with synthetic input |
| **real-daemon** | The canonical service with a real database, no provider |
| **live-provider** | Authorized calls against the one supplied sandbox |

Fixtures are synthetic and carry a label saying so. Do not capture a real
provider response into a fixture, and do not add a mock that could be selected
as a fallback when a real path fails. Something you did not run is "not run",
with the reason.

## The live provider

By default nothing here calls the live provider, and you must not either. Live
work needs a maintainer's explicit authorization for a named operator and
window. Never create, start, stop, resize, archive, reset or delete a sandbox.
Details in
[`docs/coordination.md`](docs/coordination.md#the-live-sandbox).

## What never to commit

- Secrets, tokens, keys or cookies, including in tests. Build secret-shaped
  test strings at run time so they never appear in a file.
- Real sandbox IDs, owner IDs or tenant identifiers. Use `fixture-…` values.
- Raw provider errors, transcripts, private upstream source or private
  artifacts. Describe upstream code and pin it as `repo@sha:path`; do not
  paste it.
- `.env.local` or any `.env.*` other than `.env.example`.

The same applies to issue comments, PR descriptions and logs.

## Changing a shared file

Files such as `src/cli.ts`, `package.json`, the lockfile, `tsconfig.json`,
`README.md`, `AGENTS.md` and the shared documentation have one steward. If you
are not the steward:

1. Open a **Shared-file change request** issue (or comment on the steward's
   issue) naming the file, the change and the reason.
2. Wait for the steward to make it, or to hand the file over explicitly.

Do not edit shared files concurrently. The steward for each is in
[`docs/ownership.md`](docs/ownership.md).

## Opening a pull request

- Open it as a **draft**. The template asks for everything a reviewer needs.
- Use `Refs #N`. Do not use an auto-closing keyword while acceptance is
  unverified; a maintainer closes issues.
- List consumed and produced contracts with exact SHAs. Update
  [`docs/contracts.md`](docs/contracts.md) through its steward if you change a
  contract.
- Report exact-head checks: the command, the result and the evidence class,
  run from a fresh clone.
- State the remaining live gates. Do not call anything fixture-only verified.
- Post the handoff block on the issue and move it to `status:in-review`.

## Review

You do not review or merge your own change. A reviewer works from a fresh
clone at an exact SHA and reports findings; the maintainer accepts. `risk:r4`
changes need independent review. The full rules, including how to review on a
shared GitHub account, are in
[`docs/coordination.md`](docs/coordination.md#review).

## Scope

Keep changes inside the issue. This project is deliberately small: no server,
database, Docker service, provider abstraction, dashboard, assignment bot or
second tracker. If the smallest honest answer is "blocked on an upstream
capability", say that and link the upstream issue. See
[`docs/architecture.md`](docs/architecture.md).

## Where to find things

[`docs/README.md`](docs/README.md) indexes every document.
