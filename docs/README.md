# Documentation index

The outcome issues are the spec:
[#1](https://github.com/OpenCoven/coven-castles/issues/1) (the epic and the
rules) and its children #2 to #5. These documents explain and apply them; they
do not replace them.

## Start here

| Document | Read it when |
| --- | --- |
| [`../README.md`](../README.md) | You want to know what the package does and how to run the check command |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | You are about to make your first change: setup, commands, test-first, what never to commit |
| [`../AGENTS.md`](../AGENTS.md) | You are an agent session: the hard rules on one page |

## Working with others

| Document | What it covers |
| --- | --- |
| [`coordination.md`](coordination.md) | Lanes and gates, worker IDs, worktrees, claims and the handoff block, status labels, review rules, the live-sandbox rule, what to do when things collide |
| [`ownership.md`](ownership.md) | Every path, the issue that owns it and the steward of each shared file |
| [`contracts.md`](contracts.md) | What each lane hands to the next, at which exact revision, and whether it is proposed, reviewed or accepted |

## Reference

| Document | What it covers |
| --- | --- |
| [`architecture.md`](architecture.md) | What Castles is and is not, the trust boundary, what stays upstream, pinned sources and open upstream dependencies |
| [`../fixtures/preflight/README.md`](../fixtures/preflight/README.md) | The synthetic preflight fixtures and their format |
| [`../.env.example`](../.env.example) | The binding configuration keys and where secrets do and do not live |

## Templates

| Template | Use it for |
| --- | --- |
| [Pull request](../.github/pull_request_template.md) | Every PR: contracts, changed paths, exact-head checks, remaining gates |
| [Work claim](../.github/ISSUE_TEMPLATE/claim.md) | Claiming a bounded piece of work that has no issue yet. For an existing issue, post the handoff block as a comment instead |
| [Shared-file change request](../.github/ISSUE_TEMPLATE/shared-file-change.md) | Asking a steward to change a file you do not own |
| [Blocker report](../.github/ISSUE_TEMPLATE/blocker.md) | Recording an exact blocking condition, its decision owner and the evidence that would clear it |

## Not on this branch yet

`docs/acceptance.md` (acceptance notes and the qualification matrix) is owned
by #5 and proposed in draft PR
[#7](https://github.com/OpenCoven/coven-castles/pull/7). It will be linked here
by the steward once it lands.

## Keeping these documents true

- Every statement must be true at the revision it ships in. Describe what
  exists; label anything planned, unverified or blocked as such.
- When behaviour, a contract or ownership changes, update the document in the
  same change, through the document's steward.
- Do not copy the issues wholesale. Link to them, and keep only what a
  contributor needs in order to act.
