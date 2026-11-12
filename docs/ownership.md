# Path ownership

Every path has one owning issue. The assignee of that issue, or the worker
holding its current claim, is the only one who edits it. Shared files have a
**steward**: they are still one issue's responsibility, and other lanes request
changes rather than making them.

The source is the ownership paragraph in
[issue #1](https://github.com/OpenCoven/coven-castles/issues/1) and the "Owned
paths" row of each child issue. If this table and the issues disagree, the
issues win.

"Exists" says whether the path is present on the branch this document ships
on. Paths marked "not yet" are reserved for their owner; do not create them
from another lane.

## Implementation paths

| Path | Owner | Exists | Notes |
| --- | --- | --- | --- |
| `src/profile.ts` | #2 | yes | Source policy, pins, binding parser |
| `src/preflight.ts` | #2 | yes | Client seam, result shape, evaluation |
| `tests/preflight.test.ts` | #2 | yes | |
| `fixtures/preflight/` | #2 | yes | #2 owns this directory only, not all of `fixtures/` |
| `src/run.ts` | #3 | not yet | |
| `runtime/` | #3 | not yet | Manifest and launch recipe |
| `tests/run.test.ts` | #3 | not yet | |
| `src/observe.ts` | #4 | not yet | |
| `src/export.ts` | #4 | not yet | |
| `tests/recovery.test.ts` | #4 | not yet | |
| `fixtures/report-task/` | #5 | not on this branch | Proposed in draft PR #7 |
| `tests/mvp.test.ts` | #5 | not yet | |
| `scripts/smoke.ts` | #5 | not yet | Opt-in live harness |
| `docs/acceptance.md` | #5 | not on this branch | Proposed in draft PR #7 |

## Shared files, stewarded by #2

Another lane changes these only through a linked request and an explicit
handoff from the steward. See
[`coordination.md`](coordination.md#shared-files).

| Path | Why it is shared |
| --- | --- |
| `src/cli.ts` | Every lane adds a command to one entrypoint |
| `package.json`, `pnpm-lock.yaml` | Scripts and dependencies for all lanes |
| `tsconfig.json` | Typecheck coverage for all lanes |
| `.gitignore`, `.env.example` | Repository-wide |
| `README.md` | The tested operator path; #5 drafts quickstart text for the steward to integrate |
| `AGENTS.md` | Rules every agent session reads first |
| `CONTRIBUTING.md` | Contributor setup and rules |
| `docs/README.md`, `docs/coordination.md`, `docs/ownership.md`, `docs/contracts.md`, `docs/architecture.md` | Coordination and reference documentation. `docs/` is not owned as a whole: `docs/acceptance.md` is #5's |
| `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/` | Templates for the handoff rules |

Stewardship of the documentation and template paths above is proposed by the
pull request that adds them and is not settled until the maintainer accepts
it. #1 lists the original shared-file set; these are additions to it.

## Maintainer-owned

**Addition to #1**, proposed: #1 does not list these paths. They are recorded
as the maintainer's because the maintainer added them on `main`.

| Path | Notes |
| --- | --- |
| `.githooks/pre-commit`, `.gitleaks.toml`, `.github/workflows/secret-scan.yml` | Secret scanning, added by the maintainer on `main`. Request changes from the maintainer. |
| `LICENSE` and repository settings, labels, branch protection | Not present or not file-based; maintainer only |

## Rules that follow from the table

- A new file belongs to the issue whose scope it serves. If it serves more
  than one lane, it is a shared file: ask the steward, and add it to this
  table in the same change.
- Tests live with the lane that owns the behaviour. Do not add another lane's
  cases to your test file to "help".
- Fixture directories do not overlap. `fixtures/preflight/` and
  `fixtures/report-task/` have different owners.
- Reviewers own nothing. A review is done in a scratch clone and never pushes.
- Ownership moves only by an explicit handoff in a handoff block or by a
  maintainer decision, and this table is updated in the same change.
