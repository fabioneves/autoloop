---
name: lean-code
description: Enforce lean, self-documenting code with near-zero inline comments. Use when writing or editing any source file. Rationale, history and "what changed" belong in commit messages and PR descriptions — never in code comments. The autoloop's implement (implementer) and simplify steps apply this by default.
---

# Lean code

Code is read far more than written; every line is a liability. Write the minimum that is correct
and clear, and let names — not comments — carry the meaning.

## The comment rule (the one people get wrong)

**Default to zero inline comments.** AI tends to narrate code and embed history in comments.
That narration belongs in the **commit message** and the **PR description**, not the source.

Delete on sight:
- Comments that restate the code — `// loop over users`, `// return the result`, `// constructor`.
- History / changelog comments — `// changed from X`, `// previously did Y`, `// was Z before`, `// updated 2026-..`, `// TODO(old)`.
- Section banners and dividers — `// ===== Helpers =====`, `// --- types ---`.
- **Commented-out code.** Delete it. Git remembers. Never ship a commented-out block.
- Redundant doc-comments that repeat the signature — `@param userId The user id`.

The only comments that survive:
- A genuine **why** the code cannot express — a non-obvious workaround, an external constraint,
  a sharp edge — ideally one line, with a link to the issue/ADR/source.
- Legally required headers, when required.
- Doc-comments on a **public/exported contract** when they add non-obvious information (units,
  invariants, failure modes) — not when they just echo the types.
- A **deliberate simplification that cuts a real corner** — a global lock, an O(n²) scan, a naive
  heuristic — named with its ceiling and the upgrade path, so the next reader knows it's a known
  trade-off, not an accident. Marking the ceiling is the *why*; the corner-cut itself must still be
  correct for the inputs it will actually see.

If you feel the urge to explain *what* the code does, rename instead (a variable, a function,
a type) until the code says it itself.

## Where the narrative goes instead

| You want to record… | Put it in… |
|---|---|
| Why this approach, what was rejected | the commit body / PR description |
| What changed and the before/after | the diff + commit message |
| A decision with lasting consequences | an ADR / design doc under `docs/` |
| Domain term meaning | the project's glossary or domain docs |

## Lean beyond comments

- **Small, single-purpose functions.** If you need a comment to mark a "section" inside a
  function, that section is a function.
- **No speculative abstraction.** Don't add an interface, factory, or option for a caller that
  doesn't exist yet. Delete dead abstractions when you find them.
- **No dead code, no unused exports, no `just-in-case` parameters.**
- **One obvious way.** Don't leave two patterns doing the same thing; converge on one.
- **Delete, don't disable.** Removing code is a feature.
- **Fix the root cause, not the symptom.** A bug report names a symptom; grep every caller of the
  function you touch and fix the shared function once. One guard at the source is a smaller, more
  correct diff than one guard per caller — and patching only the path the ticket names leaves a
  sibling caller still broken.

## Self-check before finishing an edit

1. Could a reader understand this with the comments removed? If yes, remove them.
2. Does any comment describe *what* rather than *why*? Rename until it's gone.
3. Is there commented-out or dead code? Delete it.
4. Did I add an abstraction nothing uses yet? Remove it.
5. Is the "why" that matters captured in the commit/PR, not the file?

Where the repo's gate has lint rules for comment slop, they enforce the floor; this skill is the
rationale and the edge cases a linter can't judge.

