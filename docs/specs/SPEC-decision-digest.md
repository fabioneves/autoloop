# Spec: decision-digest (module of SPEC-self-healing.md)

## Objective

Human decisions arrive as one batch in one place, instead of trickling in unit by unit. Fewer
units need a decision at all, because a contradiction between an issue and the spec it cites is
caught before the issue is queued.

## Behaviour

1. **`unit.mjs --digest [--post]`** reads two sets:
   - open issues labelled `loop-blocked`;
   - open PRs labelled `human:authorize`.

   Each row is `#N [<gate labels>] <title> — <question>`. The gate labels are every `human:*` or
   `needs-*` label. The question is the first prose line of the newest comment that is not a
   waiting marker, trimmed to 160 characters. Pure core: `digestRows(issues, prs)`, `digestBody(rows, at)`.
   - `--post` keeps one open issue labelled `loop-digest` and rewrites its body with the digest.
     It never adds comments, so the issue always shows the current state.
   - If no such issue exists, `--post` creates it (creating the label too if missing) and pins it,
     ignoring a pin failure. The issue never gets `loop-ready`.
   - An empty digest still rewrites the body to "nothing waiting", so a stale list never survives.
2. **`prime.mjs --close-run` and `--park`** post the digest themselves and add `digest: {rows,
   issue}` to their output. A digest failure is reported and never fails the close or the park.
3. **SKILL:** the closing and park messages carry the digest rows. The close message's "lists every
   open handoff" now points at them.
4. **Shape:** the Acceptance axis also checks each criterion against the spec section and any
   corpus or fixture it cites. A criterion that asserts an outcome they rule out is a defect: rewrite
   it or leave it as an open question, never file it. Evidence: 22 contradiction blocks, all from
   one shape batch.

## Boundaries

- Never comment on, relabel, or close a digested issue; the digest only reads them.
- Never put `loop-ready` on the tracking issue, and never edit any issue body except the tracking
  issue's.

## Tests (failing first)

- `unit.mjs`: rows carry gate labels and the newest non-marker comment line; waiting markers and
  empty comments are skipped. The body lists the rows, or "nothing waiting". `--post` edits an
  existing tracking issue, and creates and pins one when absent (fake runner).
- `prime.mjs`: the close and park outputs include the digest, and a digest failure still returns
  `ok: true`.
