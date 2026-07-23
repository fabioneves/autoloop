---
name: Loop unit
about: A PR-sized unit of work for the autoloop (one module, testable acceptance, explicit deps)
title: "feat: "
labels: []
---

<!-- Title: "<type>: <summary>" — feat/fix/chore/ci/docs, or "decision:" when it needs a human
     call. Same shape as the loop's PR titles; the type is an intake guess, never enforced. -->

## Context

<!-- Why this change exists; link the spec/ADR it comes from. 2–5 sentences. -->

## Acceptance criteria

<!-- Each criterion an observable, testable assertion — "X returns Y", "the gate stays green
     with Z removed" — never "works well" / "is cleaner". The loop builds exactly to these. -->

- [ ] …

## Boundary

<!-- The ONE module/directory this touches (e.g. `src/billing/`). One module per issue —
     cross-module work is split into multiple issues chained via Blocked by. -->

## Evidence / premises

<!-- Symbols, routes, tables this issue assumes exist — with file:line where known.
     For premises about persisted data, state the read-only query that verifies the actual
     shape (the loop will run it and capture results into its plan). -->

## Blocked by

<!-- Issue numbers that must merge first, one per line — or "none". The loop skips this
     issue while any listed blocker is open. -->

none

## Out of scope

<!-- Explicit non-goals. The strongest guard against scope creep in the built PR. -->
