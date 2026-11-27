# Preflight fixtures

**Synthetic. Not provider evidence.** Every value here is invented (`fixture-sandbox-0001`, `fixture-agent-0001`, `fixture-adapter-1`). Values that must come from a fixed set to be accepted (`us`, `started`, `coven-agents-copilot-2`, `0.231.1`, `attempt-reset-v1`) are real names used synthetically. No file in this directory was captured from Daytona or from a Coven Agents deployment, and a passing fixture proves nothing about a live sandbox.

Each `cases/*.json` file carries:

- `fixture`: the fixed synthetic label. The loader refuses a file without it.
- `env`: the binding the case configures (`CASTLES_*` only).
- `inspection`: what the client seam returns for that case.
- `expect`: the status, the reason codes and the number of inspection calls.

## The `inspection` shape

`inspection` is `{status, body}`: the HTTP status and JSON body of the owning service's inspection route. The body is shaped like upstream's strict sandbox-inspection v1 schema, pinned at `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502` (`packages/agent-contracts/src/sandbox-inspection.ts`). The fixtures still contain no upstream answer; the shape is copied from the pinned schema, and the values are made up.

- `version` is `1`. An `outcome` of `observed` carries `record`, `observed` and `policy`. A key that v1 does not define makes the whole answer a contract violation.
- `record` is the agent record upstream read: `agentId`, `sandboxId`, `generation`, `lifecycle` and `fence` (`none`, `attempt_outstanding` or `cleanup_required`).
- `observed` states each field the way v1 does. The TTL, the warm pool and the linked sandbox are booleans. Volumes are a count. Each egress list is a comparison with the owner's policy (`domainAllowListConfigured`, `domainAllowListMatchesPolicy`, `networkAllowListConfigured`, `outboundProxyConfigured`). `identity` holds upstream's own ownership-label, generation-label, configuration and credential-boundary checks. v1 does not report the raw lists, the labels or the platform.
- `policy` is upstream's source policy, including the server-selected `sdkVersion` and the `credentialBoundaryVersion`.
- A refusal is either an HTTP status Castles maps (`401`, `403`, `404`, `429`, `503`) or a `200` body whose `outcome` is `not_found`, `ambiguous` (with its `reason`), `unauthorized` or `unavailable`.

In an observed case, `false` is the stated "not set" and `0` is "no volume". An absent or `null` value is missing metadata. Upstream folds "the provider did not report it" into `false` or `0`. Castles accepts that for now, pending the decision in [OpenCoven/coven-agents#322](https://github.com/OpenCoven/coven-agents/issues/322). The deliberately incomplete `metadata-missing.json` sets `networkBlockAll`, `gpu`, `autoPauseInterval` and `snapshot` to `null`.

## Replaying a case

Replaying a case with `castles check --fixture` exits `3` when the case reports `ready` and `1` otherwise. It never exits `0`.

This directory is owned by issue #2. `fixtures/report-task/` belongs to #5.
