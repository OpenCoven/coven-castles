# Coordination: how several people and agents work here at once

This repository is built by several contributors and agent sessions working
asynchronously, often under one GitHub account. These rules keep their work
from colliding. They restate
[issue #1](https://github.com/OpenCoven/coven-castles/issues/1); if this page
and #1 disagree, **#1 wins** and this page has a bug.

Nothing here is enforced by automation. There is no assignment bot, no second
tracker and no lock service. The rules work because everyone reads the issue
before acting and writes down what they did.

## The five issues

| Issue | Outcome | Lane |
| --- | --- | --- |
| [#1](https://github.com/OpenCoven/coven-castles/issues/1) | The MVP epic and every rule on this page | tracking |
| [#2](https://github.com/OpenCoven/coven-castles/issues/2) | Bind and preflight one existing sandbox; package foundation | sandbox |
| [#3](https://github.com/OpenCoven/coven-castles/issues/3) | Bootstrap the runtime and run one authorized task | runtime |
| [#4](https://github.com/OpenCoven/coven-castles/issues/4) | Results, reconnect, cancellation, safe reuse | recovery |
| [#5](https://github.com/OpenCoven/coven-castles/issues/5) | Independent acceptance and a measured quickstart | verification |

The issues are the source of truth for outcomes. Pull requests, labels and
this documentation describe progress toward them; they never replace them.

## Lanes and gates

Integration order is #2 → #3 → #4 → #5, but lanes do not wait for whole issues
to close. Each lane has work that may start early and a gate that opens later.

| Lane | May proceed now | Gate for the rest |
| --- | --- | --- |
| #2 | Offline preflight fixtures and the package scaffold | Live lookup needs the configured owner and sandbox, and the upstream read-only seam |
| #3 | Read-only upstream investigation and failure-case design | #2's contract reviewed and accepted at an exact SHA |
| #4 | Read-only review of recovery and containment contracts | #3's run/attempt/receipt interfaces reviewed at an exact SHA |
| #5 | Neutral fixtures, acceptance cases and notes | Executable tests after #2; live qualification after accepted #2 to #4 and explicit provider authorization |

**A gate opens on a linked, reviewed capability at an exact revision.** None of
these opens a gate on its own:

- an issue being closed, or a checkbox being ticked;
- a pull request being merged;
- a draft pull request existing;
- a `status:` label changing;
- a reviewer recommending acceptance. Acceptance is the maintainer's.

A stacked draft PR may build on an unmerged base so review can start, but it
stays provisional until its base is accepted and it is revalidated.

## Before you touch anything

1. Re-read the issue you are working on, its assignee, **every** comment and
   its linked PRs. Things change while you are away.
2. Check [`ownership.md`](ownership.md) for the paths you intend to edit.
3. If someone else holds an active claim on the issue, stop. Do not start a
   competing implementation.
4. Pick a worker ID, create your branch and worktree, and post your claim.

## Worker IDs

Agents often share one GitHub identity, so the account name cannot tell two
workers apart. Every worker, human or agent, uses a **worker ID** that is
unique for the session and appears in the claim, the branch name and every
handoff.

- Format: a short role prefix and a random suffix, for example
  `cc2b-1882a2da`. Generate the suffix (`openssl rand -hex 4`); do not reuse
  one you have seen.
- Reviewers use their own ID, distinct from every author ID, for example
  `rv6-cecd8224`.
- A new session is a new worker, even when it continues the same lane. It
  takes over through an explicit handoff, not by assuming the old ID.

## One branch and one worktree per worker

```sh
git fetch origin
git worktree add -b castles/<issue>-<slug>-<worker-id> \
  ../coven-castles.worktrees/<issue>-<slug>-<worker-id> origin/main
```

- Branch names are `castles/<issue>-<slug>-<worker-id>`.
- Never share a writable checkout. Never edit another worker's worktree, even
  to read "what they were doing"; read their branch instead.
- Never force-push, to your own branch or anyone else's. When `main` moves,
  merge it in with a merge commit and re-run the checks.
- Keep one active implementation PR per issue unless a handoff divides the
  scope.

**Taking over a branch.** Git will not check out a branch that another
worktree already has. Create a local branch with a different name on the same
commit and push to the existing remote branch:

```sh
git worktree add -b wt/<issue>-<slug>-<new-worker-id> \
  ../coven-castles.worktrees/<issue>-<slug>-<new-worker-id> \
  origin/castles/<issue>-<slug>-<old-worker-id>
git push origin HEAD:castles/<issue>-<slug>-<old-worker-id>
```

Leave the previous worker's worktree alone.

## Claims and the handoff block

A claim is a comment on the issue. Post the same block at the start, at
material checkpoints, when asking for review, and when relinquishing.

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

A worked example, with invented values:

```text
Worker / GitHub owner: cc9-0a1b2c3d (agent session) / @example-maintainer (shared identity)
Claimed issue and bounded scope: #4 — read-only investigation of the cleanup fence only. No implementation.
Branch / draft PR / base SHA / head SHA: none / none / <40-hex main SHA> / n/a
Owned paths; shared-file agreement: none touched; no shared-file request made
Consumes: #3 interfaces — NOT AVAILABLE (no reviewed handoff). Upstream read at <repo>@<40-hex SHA>.
Produces: one investigation comment on this issue
Checks: none executable; source reading only
Blocker: no reviewed #3 handoff at an exact SHA. Owner: #3 owner / epic maintainer. Evidence needed: handoff comment plus independent review at that SHA.
Next executable action: trace cancellation from route to provider stop and post findings
Next checkpoint (UTC): 2026-01-01T12:00Z
Handoff: retaining investigation claim only; implementation unclaimed
```

Rules for filling it in:

- **Exact revisions.** Full 40-character SHAs for anything consumed or
  produced. "Latest main" is not a revision.
- **Exact commands.** The command as typed and its result. "Tests pass" is not
  a check.
- **Evidence class on every check**: see below.
- **Bounded scope.** Say what you are *not* doing as well as what you are.
- **Blocker with an owner.** A blocker names the condition, who decides it and
  what evidence would clear it.

Claims are not atomic locks. Two workers can post within the same minute.
**If claims collide, both stop overlapping edits**; the earlier owner or the
epic maintainer decides. Do not resolve a collision by pushing first.

**A missed checkpoint triggers contact and review, never automatic takeover.**
Reassignment needs an explicit handoff from the holder or a maintainer
decision, after the branch, head SHA and evidence have been preserved.

Each contributor normally holds one active implementation issue. When you are
blocked, publish the blocker and the next safe action rather than quietly
starting on another lane.

## Assignee and status labels

The GitHub assignee is the accountable owner. Issues stay unassigned until a
real contributor claims them; agents on a shared identity assign that identity
and distinguish themselves by worker ID.

Every open issue carries exactly one `status:` label. Replace the old one when
you transition; never accumulate two.

| Label | Meaning | Set by |
| --- | --- | --- |
| `status:tracking` | The epic (#1) only | maintainer |
| `status:ready` | Claimable implementation slice | maintainer |
| `status:ready-offline` | Fixture or document work is claimable; the live gate is closed | maintainer |
| `status:in-progress` | A claim is confirmed and work is under way | claiming worker |
| `status:in-review` | The exact-head evidence packet is posted and review is requested | author |
| `status:blocked` | Stopped on a concrete, stated unblock condition | whoever hits the block |

Typical path: `ready` or `ready-offline` → `in-progress` → `in-review` →
closed by the maintainer. `blocked` can be entered from any state and must say
what unblocks it. On completion the issue is closed as completed and the
status label removed.

Other labels: one `area:` label per task, `risk:r3` or `risk:r4`, `type:`,
`priority:` and `scope:`. Risk decides how much review a change needs; it does
not decide who may run anything.

**Labels, assignment and claims are coordination only.** None of them grants
permission to spend, deploy, reset, publish, merge, call the live provider or
change credentials.

## Evidence classes

Every result is reported with its class. A higher class is never inferred from
a lower one.

| Class | What it means |
| --- | --- |
| **fixture** | An offline test with synthetic input. Says nothing about a real provider or real admission. |
| **real-daemon** | The canonical service with a real database, no provider. |
| **live-provider** | Authorized calls against the one supplied sandbox. |
| static / source reading | Typecheck, or reading pinned source. Not behaviour. |

`ready` in a fixture run is not readiness. A merged PR is not `verified`.
Anything skipped or not run is reported as unverified, never left silently
green.

## Review

- **No self-review and no self-merge.** The author of a change does not review
  it. That includes an agent session that wrote *either* the change or an
  earlier review of it: a session that reviewed a PR and then fixed the
  findings cannot re-review its own fixes.
- **Review an exact SHA**, from a fresh clone, never from the author's
  worktree. If the head moves during review, restart on the new head.
- **Check claims against the code**, not against the author's table. Where a
  test is offered as evidence, break the behaviour in a scratch copy and
  confirm the test fails.
- **R4 changes need independent review.** `risk:r4` covers authority,
  credentials, persistence, containment and qualification boundaries. The
  reviewer and the reviewed SHA are named in the handoff. A reviewer spawned by
  the author's own session is a useful second read; say so plainly and do not
  call it independent.
- **On a shared GitHub identity**, post reviews as comments
  (`gh pr review --comment`). GitHub will not let an account approve its own
  PR, and an approval would say more than a reviewer on a shared account can
  mean.
- **A reviewer recommends; the maintainer accepts.** A review never opens a
  gate. Acceptance is a maintainer comment naming the SHA.
- **Rebase, merge of `main` or any changed input** means the affected checks
  are run again and the new head is reported.

PRs use `Refs #N`, never an auto-closing keyword, while acceptance is
unverified. A maintainer closes issues.

## Shared files

Some files are edited by every lane eventually: the CLI entrypoint, package
manifests and lockfile, toolchain configuration, the README, this
documentation. Each has one steward, listed in
[`ownership.md`](ownership.md). To change a shared file you do not steward:

1. Open a request with the **Shared-file change request** issue template, or
   comment on the steward's issue, saying which file, what change and why.
2. Wait for the steward to make the change or to hand the file over
   explicitly in a handoff block.
3. Do not edit it concurrently "to save time". Two lanes editing one manifest
   is the collision these rules exist to prevent.

## The live sandbox

The MVP uses one explicitly supplied, existing sandbox. It is not a shared
development resource.

- **Default: no live provider call.** Everything in this repository runs
  offline unless a maintainer has authorized a named operator for a named
  window. No such authorization exists at the time of writing.
- **One operator at a time.** The operator and window are named in a handoff
  block. That comment is coordination; exclusivity itself is enforced by the
  runtime's attempt boundary, not by GitHub.
- **Never** create, start, stop, resize, archive, reset or delete a sandbox,
  adopt one by name or label, or replace a missing one.
- Closing a client, a finished provider session or a status label does **not**
  release a cleanup fence. If reuse is not proven safe, the answer is
  "blocked", and blocked is never permission to destroy the workspace.

## Companion work in other repositories

Castles does not fork upstream capability. If the canonical owner lacks
something, open or link an issue in the owning repository, describe the
narrowest capability needed, and link it from the Castles issue. Claim
companion work there, under that repository's rules. Do not take over another
contributor's upstream branch.

## What never goes in a commit, issue, PR or log

- Secrets, tokens, keys, cookies.
- Real sandbox IDs, owner IDs or tenant identifiers. Output uses redacted
  aliases.
- Raw provider errors, transcripts, private source excerpts or private
  artifacts. Describe upstream code; do not quote it.

Commits are scanned by gitleaks, locally through the pre-commit hook and in
CI. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for setup.

## Quick reference: when things go wrong

| Situation | Do this |
| --- | --- |
| Someone else has claimed the issue | Stop. Offer help in a comment; do not start a parallel implementation. |
| Two claims posted close together | Both stop overlapping edits; the earlier owner or epic maintainer decides. |
| A worker missed their checkpoint | Comment and ask. Do not take over. |
| You need a change in a file you do not own | Shared-file change request; wait for the steward. |
| `main` moved under your PR | Merge `main` in, re-run checks, report the new head. No rebase, no force-push. |
| An upstream capability is missing | Link or open an upstream issue; mark the item blocked with that link. Do not build a local substitute. |
| A check cannot be run | Report it as not run, with the reason. |
| You are unsure whether an action is authorized | It is not. Ask the maintainer. |
