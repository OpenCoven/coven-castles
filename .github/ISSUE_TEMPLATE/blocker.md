---
name: Blocker report
about: Record an exact blocking condition, who decides it, and the evidence that would clear it.
title: "Blocker: <short condition>"
labels: ""
assignees: ""
---

<!--
A blocker is a specific condition, not "waiting". If the capability belongs to
another repository, open or link the issue there and link it here; do not
build a local substitute.
Set status:blocked on the affected issue and say what unblocks it.
This template sets no label. Give the new issue exactly one status: label by
hand, or ask the maintainer to.
-->

## Blocked work

Issue and acceptance item(s) blocked: #
Worker reporting: `<worker-id>`

## Exact condition

<!-- What is missing or undecided, stated so that someone can tell when it is no longer true. -->

## Evidence

<!-- How you established it: exact revisions as repo@sha:path, commands and results, evidence class. Describe private source; do not quote it. -->

## Decision owner

<!-- Who can clear this: an issue assignee, the epic maintainer, or an upstream repository. Link the upstream issue. -->

## What would clear it

<!-- The evidence needed: a merged change at an exact SHA, a maintainer decision, an authorization. -->

## Safe work that can continue meanwhile

<!-- What does not depend on this, and the next executable action. -->

## Must not happen while blocked

<!-- For example: no local substitute for the missing capability; no fence removed; no live call. -->
