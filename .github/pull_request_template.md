<!--
Open as a draft. Keep every heading; write "none" rather than deleting one.
Rules: docs/coordination.md. Paths: docs/ownership.md. Contracts: docs/contracts.md.
-->

Refs #<!-- issue number; do not use an auto-closing keyword -->

Worker: `<worker-id>`. Evidence class of this PR: <!-- fixture / real-daemon / live-provider; static if no behaviour ran -->

## What this changes

<!-- Two or three sentences. What a reader can now do or rely on. -->

## Consumed contracts

<!-- Each prerequisite as issue + contract + exact 40-character SHA, and its standing (proposed / reviewed / accepted). -->

## Produced contracts

<!-- Each contract or artifact this PR publishes, where it lives, and who consumes it. -->

## Changed paths

<!-- List them. Every path must be owned by this issue or handed over by its steward (link the handoff). -->

## Migration and rollback

<!-- Data, schema or provider state affected, and how to undo this change. -->

## Exact-head checks

Head: `<40-character SHA>`. Run from a fresh clone.

| Command | Result | Class |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | | |
| `corepack pnpm test` | | fixture |
| `corepack pnpm typecheck` | | static |

<!-- Add rows for anything else. Write "not run" with the reason for anything skipped. -->

## Remaining gates

<!-- What is still unverified or blocked, the decision owner for each, and the evidence that would clear it. Link upstream issues. -->

## Checklist

- [ ] `Refs #N`, no closing keyword
- [ ] Consumed and produced contracts listed with exact revisions
- [ ] Changed paths are all owned by this issue or explicitly handed over
- [ ] Failing test committed before the fix, where behaviour changed
- [ ] Exact-head checks listed with command, result and evidence class
- [ ] Remaining live gates stated; nothing fixture-only is called verified
- [ ] No secrets, real IDs, raw provider errors or private source
- [ ] No live provider call was made, or the authorization for it is linked
- [ ] Documentation updated where behaviour, a contract or ownership changed
- [ ] Handoff block posted on the issue; issue moved to `status:in-review`
- [ ] Not self-reviewed, not self-merged; independent reviewer named for `risk:r4`
