# Path ownership

Every path has one owning issue. The assignee of that issue, or the worker holding its current claim, is the only one who edits it. Shared files have a **steward**: they are still one issue's responsibility, and other lanes request changes rather than making them.

The source is the ownership paragraph in [issue #1](https://github.com/OpenCoven/coven-castles/issues/1) and the "Owned paths" row of each child issue. If this table and the issues disagree, the issues win.

"Exists" says whether the path is present on the branch this document ships on. Paths marked "not yet" are reserved for their owner; do not create them from another lane.

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
| `fixtures/report-task/` | #5 | yes | On `main` since PR #7 was merged (`b5d7fc14add09fa94a7103031d7d625f710e519c`) |
| `tests/mvp.test.ts` | #5 | yes | Offline qualification harness merged in PR #13 (`ecd360702e0d5d11f3acfc5899847ab4eb2df702`) |
| `scripts/smoke.ts` | #5 | yes | Refusal-only entrypoint; no live success path |
| `docs/acceptance.md` | #5 | yes | On `main` since PR #7 was merged (same commit) |

## Shared files, stewarded by #2

Another lane changes these only through a linked request and an explicit handoff from the steward. See [`coordination.md`](coordination.md#shared-files).

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

Stewardship of the documentation and template paths above is proposed by the pull request that adds them and is not settled until the maintainer accepts it. #1 lists the original shared-file set; these are additions to it. That pull request, [#9](https://github.com/OpenCoven/coven-castles/pull/9), was merged on 2026-11-12 as `a4ced7b463edccbe2ddd89ad12645b60f0aacefb`. The [comment recording the maintainer's decision](https://github.com/OpenCoven/coven-castles/issues/2#issuecomment-6816836865), posted before the merge with the instruction to merge, says merging is not a decision on the items in that pull request's body, of which this is one, so the stewardship is still a proposal.

## Maintainer-owned

**Addition to #1**, proposed: #1 does not list these paths. They are recorded as the maintainer's because the maintainer added them on `main`.

| Path | Notes |
| --- | --- |
| `.githooks/pre-commit`, `.gitleaks.toml`, `.github/workflows/secret-scan.yml` | Secret scanning, added by the maintainer on `main`. Request changes from the maintainer. |
| `.github/workflows/test.yml` | Offline test gates in CI, added under the maintainer's 2026-11-22 decision (#1). Request changes from the maintainer. |
| `LICENSE` and repository settings, labels, branch protection | Not present or not file-based; maintainer only |

## Rules that follow from the table

- **This table is the `src/` file registry.** `tests/preflight.test.ts` reads it: every file under `src/` needs exactly one `src/` row, an Implementation row marked `yes` must be present, one marked `not yet` must be absent, and a Shared row must be present. The reserved `src/` names are fixed in that test, so a new name needs the steward. A row counts only as a body row of one of the tables above, and every row of a table must have as many cells as its header. This file may hold no code fence, no `<` directly before a letter, `!`, `?` or `/` (so no HTML, autolinks or such text in code spans), and no link reference definition. Every table line must be printable ASCII with no backslash and no `&`. A row elsewhere, under any other heading or repeated fails, and so does a reserved name written as `src/` text outside a counted row. The check reads lines, not rendered Markdown, so it is a tripwire: a reviewer still reads the raw diff of this file. Adding a lane's reserved `src/` file means flipping its row's Exists cell to `yes`. Whether the lane may make that one-cell edit itself is a standing handoff **proposed** with PR #20 under the maintainer's 2026-11-22 registry decision. Until the maintainer confirms it, ask the steward ([`coordination.md`](coordination.md#shared-files)). Any other change to this file still goes through the steward.
- A new file belongs to the issue whose scope it serves. If it serves more than one lane, it is a shared file: ask the steward, and add it to this table in the same change.
- Tests live with the lane that owns the behaviour. Do not add another lane's cases to your test file to "help".
- Fixture directories do not overlap. `fixtures/preflight/` and `fixtures/report-task/` have different owners.
- Reviewers own nothing. A review is done in a scratch clone and never pushes.
- Ownership moves only by an explicit handoff in a handoff block or by a maintainer decision, and this table is updated in the same change.
