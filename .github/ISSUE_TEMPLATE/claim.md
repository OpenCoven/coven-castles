---
name: Work claim
about: Claim a bounded piece of work that has no issue yet. For an existing issue, post the handoff block as a comment instead.
title: ""
labels: ""
assignees: ""
---

<!--
Use this only when the work is not already covered by an open issue.
If it is, do not open a new issue: post the block below as a comment there.
A claim is coordination only. It grants no permission to spend, deploy, reset,
publish, merge, call the live provider or change credentials.
Rules: docs/coordination.md
This template sets no label. Give the new issue exactly one status: label by
hand, or ask the maintainer to.
-->

## Parent and scope

Parent issue: #
Why this is not covered by an existing issue:

## Claim

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

## Explicitly out of scope

<!-- What this claim does not cover, so another worker can take it. -->

## Before submitting

- [ ] I re-read the parent issue, its assignee, latest comments and linked PRs
- [ ] No one else holds an active claim on this scope
- [ ] Every path I will edit is mine in docs/ownership.md, or I have linked a steward handoff
- [ ] No secrets, real sandbox IDs or private source in this issue
