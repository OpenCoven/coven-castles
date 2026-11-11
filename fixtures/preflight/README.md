# Preflight fixtures

**Synthetic. Not provider evidence.** Every value here is invented
(`fixture-sandbox-0001`, `fixture-agent-0001`, `fixture.invalid`, `fixture-arch`).
No file in this directory was captured from Daytona or from a Coven Agents
deployment, and a passing fixture proves nothing about a live sandbox.

Each `cases/*.json` file carries:

- `fixture` — the fixed synthetic label; the loader refuses a file without it
- `env` — the binding the case configures (`CASTLES_*` only)
- `inspection` — what the client seam returns for that case
- `expect` — status, reason codes and the number of inspection calls

The `inspection` shape is `castles.fixture.sandbox-inspection.v0`: the result
Castles needs from the read-only seam requested in
[OpenCoven/coven-agents#296](https://github.com/OpenCoven/coven-agents/issues/296).
It is a proposal until that seam lands and is pinned; it is not an upstream
contract.

This directory is owned by issue #2. `fixtures/report-task/` belongs to #5.
