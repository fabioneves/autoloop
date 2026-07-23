# Code Review Checklist

The **single source of truth** for code-review criteria in this repo. The autoloop's reviewers
(the fresh-thread code review and the orchestrator's diff review) grade every unit against these sections,
and a human can apply them directly. Reference it — don't copy it into output — so the review
surfaces can't drift.

## Systematic Review Checklist

### 1. Functional Requirements

- [ ] Implementation logic matches requirements correctly
- [ ] Interface/API matches documented specifications
- [ ] Error scenarios handled with proper feedback
- [ ] Edge cases and boundary conditions validated

### 2. Code Quality

- [ ] Proper typing (no unjustified dynamic types)
- [ ] DRY principle - no code duplication
- [ ] KISS principle - not unnecessarily complex
- [ ] Consistent, descriptive naming conventions
- [ ] Complex logic is made self-explanatory; comments remain only for a why the code cannot express
- [ ] Files/modules not excessively large
- [ ] Imports/includes organized, unused ones removed

### 3. Architectural Compliance

- [ ] Code follows applicable repository guidance (`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`) and surrounding patterns
- [ ] Proper separation of concerns
- [ ] Appropriate abstractions used
- [ ] Consistent with existing codebase style

### 4. Project Invariants (EDIT ME — transcribe STATE → Mission invariants)

<!-- Replace these examples with YOUR project's load-bearing invariants, one checkbox each.
     These are the rules whose violation is a defect by definition — data-safety boundaries,
     idempotency contracts, never-throws contracts, external API payload rules, … -->
- [ ] (example) External writes are idempotent under retry
- [ ] (example) Read-only datasources stay read-only
- [ ] (example) No database writes without explicit human permission

### 5. Error Handling & Resilience

- [ ] Errors are properly caught and handled
- [ ] Error messages are clear and actionable; no credential leakage in errors/logs
- [ ] Failure modes are graceful — subsystems degrade without taking the process down
- [ ] Logging via the project's logger (never bare console/print in production paths)

### 6. Security (if applicable)

- [ ] Input validation implemented
- [ ] No sensitive data exposed; secrets not committed
- [ ] Authentication/authorization respected
- [ ] No obvious vulnerabilities

### 7. Performance

- [ ] No obvious performance issues; operations bounded (batch sizes, concurrency, pacing)
- [ ] Resource cleanup implemented (handles, connections — no leaks)
- [ ] Appropriate data structures used
- [ ] No unnecessary round-trips in hot paths

---

## Issue Severity Classification

**Critical (Block Deployment)**:

- Security vulnerabilities
- Data corruption risks
- Breaking API/interface changes
- Authentication bypasses

**Major (Require Immediate Fix)**:

- Incorrect business logic
- Significant performance degradation
- Missing error handling
- Compilation/build errors

**Minor (Should Fix)**:

- Code style inconsistencies
- Missing documentation
- Code duplication
- Missing edge case handling

**Suggestions (Nice to Have)**:

- Performance optimizations
- Readability improvements
- Additional test coverage

---

## Review Completion Criteria (Approval Gate)

Minimum for approval:

- [ ] All functional requirements implemented
- [ ] No critical or major issues remaining
- [ ] The objective gate is green: `{{GATE_COMMAND}}`
- [ ] New logic has test coverage (or a recorded, justified coverage-debt entry)

## Finding output format (reviewer → orchestrator contract)

The reviewer emits findings as a flat list so the orchestrator can mechanically match each one to a
disposition on re-review. One block per finding:

- **id** — stable slug, e.g. `sec-authz-orders-01`. Reuse the same id across re-reviews for the
  same defect so dispositions can be matched by key, not by prose.
- **severity** — `Critical` | `Major` | `Minor` | `Suggestion`. Only Critical/Major gate.
- **category** — exactly one checklist section.
- **location** — `path:line` (or `path` for file-level).
- **claim** — one line: what is wrong.
- **evidence** — why it's a real defect (concrete failure/exploit path), not a style preference.
- **boundary** — `in-unit` (fixable under the current unit) | `out-of-boundary` (surface for the
  human; never built into the unit).

The orchestrator answers every Critical/Major with exactly one disposition, keyed by `id`:

- **fix** — addressed in the diff (reference the commit/hunk).
- **rebut** — one-line rationale (false positive, or out-of-boundary). Recorded as a PR comment.

Re-review rule: a `rebut` is a **proposal, not closure** — the next fresh reviewer must explicitly
accept or reject each one, and may reject on the finding's **original evidence**. An **accepted**
rebut closes the finding; a **rejected** rebut stays blocking: fix it, or `loop-blocked` for human
arbitration. New Critical/Major on changed code is always fair game. A unit is converged when every
Critical/Major has a `fix` or an **accepted** `rebut`. A finding never authorizes weakening an
invariant or the escalate-list.
