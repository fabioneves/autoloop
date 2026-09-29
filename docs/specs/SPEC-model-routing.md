# Spec: Per-role model routing

## Objective

Let the operator set the model for each step instead of one reviewer model, and pin this repository's
standing assignment:

| Step | Role | Engine / model | Route |
|---|---|---|---|
| 02 plan (+ revisions) | `plan` | claude / `gpt-6-astra` | proxy |
| 03 plan-review | `plan-review` | claude / `claude-fable-5-1` | native |
| 05 implement | `implement` | claude / `claude-opus-5-5` | native |
| 06 simplify | `simplify` (new) | claude / `claude-fable-5-1` | native |
| 07 diff review | `diff-review` (new) | claude / `gpt-6-astra` | proxy |
| 08 code-review, doubt-review | `code-review`, `doubt-review` | claude / `gpt-6-astra` | proxy |
| 08 fixes | `fix` (new) | claude / `claude-opus-5-5` | native |

**Deliberate policy reversal.** Until now, writer and planner roles never read the recording and were never
proxied (`dispatch.mjs:473-499`; memory "Claude writes, codex reviews", rejected inversion 2026-07-27).
This spec retires that rule. What stays is the invariant beneath it: **no artifact is judged by
the model that wrote it**:
- plan: astra → reviewed by Fable
- implement/fix: Opus → reviewed by astra (07, 08)
- simplify: Fable → reviewed by astra (07, 08)

Known weakness, accepted by the operator: when Fable is at its limit, simplify falls back to astra
(see Fallbacks). The 07/08 reviewers then read astra's own simplify edits, so the simplify slice gets
same-model review on those runs. The result stamp and collection-line note record it.

The incident behind `regression-index.mjs:884` stays valid: a role never inherits another role's
route by accident. Every role resolves only its own entry.

## Assumptions (correct now or they stand)

1. Model pins are explicit IDs (`claude-opus-5-5`, `claude-fable-5-1`), not the `opus`/`fable`
   aliases, so an alias move cannot silently change a step. Ribbon slots read `[CLAUDE-OPUS-5-5]`.
2. The proxy at the recorded URL serves `gpt-6-astra` on the Anthropic Messages API, the same way it serves
   `gpt-5.6-sol` today. The proxy never serves Claude models; native routes get no `ANTHROPIC_BASE_URL`.
3. `with codex` mode keeps its current behaviour (verdict roles → codex, step 07 is the slim handoff
   check). Routing applies to the claude engine.
4. The step 07 dispatch returns a verdict (`diff-review`, reviewer posture, read-only). The orchestrator
   disposes its findings; fixes go to an `implement` dispatch on Opus. The orchestrator stops
   editing the checkout during step 07 itself.
5. The step 08 oracle sweep stays in-session (it needs Bash; reviewers hold none).
6. Release is a minor bump: v0.50.0.

## Design

**Recording.** A new per-repo file `.git/autoloop/routes`, written once after prime, one line per role:

```
plan         claude gpt-6-astra      @http://127.0.0.1:18765 !xhigh >claude-opus-5-5
plan-review  claude claude-fable-5-1 !xhigh >claude-opus-5-5
implement    claude claude-opus-5-5
fix          claude claude-opus-5-5  >gpt-6-astra@http://127.0.0.1:18765
simplify     claude claude-fable-5-1 >gpt-6-astra@http://127.0.0.1:18765
diff-review  claude gpt-6-astra      @http://127.0.0.1:18765 !xhigh
code-review  claude gpt-6-astra      @http://127.0.0.1:18765 !xhigh
doubt-review claude gpt-6-astra      @http://127.0.0.1:18765 !xhigh
```

- Token grammar per line is today's `review-engine` grammar prefixed by a role name: `@url`, `!effort`,
  at most one model.
- Any malformed line, unknown role, or duplicate role fails the whole file closed. The dispatch refuses with a
  typed error; it does not fall back silently.
- One optional fallback token per line, `>model[@url]`: the route to use on a usage-limit retry. The dispatch
  selects it only when given `--fallback`, and the result stamps the fallback model. This keeps the retry's
  URL in the recording rather than on the command line.
- A role absent from `routes` gets host defaults: claude engine, no model, no URL.
- Resolution order per dispatch, per field: explicit CLI flag → `routes` entry for that role → legacy
  `review-engine` (verdict roles only, only when `routes` is absent) → host default.
- `--model` given without a matching route never picks up that route's URL for a different model.
  The URL follows the route only when the model is the route's model.

**Roles.** `simplify` and `fix` = writer posture, text result (same tools as `implement`); separate roles so each carries its own route and fallback. `diff-review` = reviewer
posture, `review-verdict` result, same envelope rules as `code-review`.

**Fallbacks** (`SKILL.md` model-limit section rewritten):
- astra at limit or erroring on 02 plan → retry once with `--fallback` on `claude-opus-5-5`. Fable
  still reviews at 03, so the plan stays cross-model. A proxy that doesn't answer the preflight probe is
  not a usage limit: `needs-human` (existing probe rule).
- Opus at limit (08 fixes) → retry once with `--fallback` on `gpt-6-astra` through the proxy. **Accepted risk,
  operator's call:** astra is the 08 reviewer, so on those rounds astra judges its own fixes; the note on the
  collection line and the result stamp record it.
- Opus at limit (05 implement) → park (unchanged, operator's decision).
- Fable at limit (06 simplify) → retry once with `--fallback` (the route's `>gpt-6-astra@…`), noted on the
  collection line (`simplify returned · GPT-6-ASTRA, CLAUDE-FABLE-5-1 at limit`). Never onto Opus,
  which is the writer's model. If astra is unavailable too, skip step 06 (existing rule).
- Fable at limit (03 plan-review) → retry once with `--fallback` on `claude-opus-5-5`, **not** astra:
  astra wrote the plan, so an astra fallback would make it review its own plan. If Opus is at its limit
  too → park.
- Proxy down or astra erroring on 07/08 → `needs-human` naming the URL (existing probe rule); the
  unit parks. Reviewers never fall back onto the writer's model.

## Commands

```bash
node templates/tools/verify.mjs --plugin-root .          # full self-test (CI-identical)
node templates/tools/dispatch.mjs --self-test            # dispatch cases only
node templates/tools/regression-index.mjs --self-test
node templates/tools/verify.mjs --emit-self-test-manifest > templates/tools/self-test-manifest.json
git diff --check
```

## Project structure (touched)

- `templates/tools/dispatch.mjs` — ROLES, `routes` parser, per-role resolvers, base-URL gating, self-tests
- `templates/tools/session-preflight.sh` — report `routes`; keep the session-wide `ANTHROPIC_BASE_URL` warning
- `templates/tools/regression-index.mjs` — re-anchor the plan-on-review-model and writer-proxy incidents
  to the new tests; add an incident entry for the policy reversal
- `templates/tools/step-subject.mjs`, `label-swap-reminder.mjs` — fixture/prose model names
- `skills/dev/SKILL.md` — standing defaults, proxy section, step 06/07/08 dispatch commands, fallbacks,
  ribbon examples (`GPT-5.6-SOL` → `GPT-6-ASTRA`, `OPUS`/`FABLE` → explicit IDs)
- `templates/tools/self-test-manifest.json`, `VERSION`, `.claude-plugin/plugin.json`, `CHANGELOG.md`

## Code style

Match `dispatch.mjs`: frozen tables, small pure resolvers, one comment block per decision stating
the incident or reason. Example target shape:

```js
export function resolveRoute(role, cwd) {
  return recordedRoutes(cwd)?.[role] ?? legacyReviewRoute(role, cwd) ?? HOST_ROUTE;
}
```

## Testing strategy

Self-tests embedded in `dispatch.mjs` (the repo's only test mechanism), written failing first:
- Each role resolves only its own line. `plan` never picks up `code-review`'s model or URL, which pins the
  2026-08 incident.
- A native route injects no `ANTHROPIC_BASE_URL`; a proxied route injects exactly its URL, seen in
  the spawned env for both the planner (`plan`) and a reviewer role (`code-review`).
- Malformed, duplicate, or unknown-role lines fail closed with a typed code.
- `fix` resolves its own route, independent of `implement`.
- `--fallback` on `simplify` spawns with the fallback model and its URL; `--fallback` on a route without one fails typed.
- Legacy `review-engine` still routes verdict roles when `routes` is absent; it is ignored when `routes` exists.
- `simplify` has writer tools; `diff-review` cannot name a write tool; `diff-review` enforces the verdict schema.

Full `verify.mjs --plugin-root .` must pass, with the manifest regenerated. Live validation: one loop
unit end to end in a live project repo with `routes` written, with every stamped model in the dispatch log
matching the table.

## Boundaries

- Always: fail closed on a bad `routes` file; stamp the resolved model/engine/URL-less route on every result.
- Ask first: changing `with codex` semantics; touching auto-merge or the gate; editing the live
  target repos' `.git/autoloop` files.
- Never: let a role inherit another role's route; send native Claude roles through the proxy; start,
  restart, or background the proxy; delete regression incidents (re-anchor or supersede them).

## Success criteria

1. `node templates/tools/verify.mjs --plugin-root .` passes with the new cases; `git diff --check` clean.
2. With the example `routes` file, `resolveRoute` returns the table above for all eight roles.
3. `rg -i 'gpt-5\.6-sol'` finds no hits outside `CHANGELOG.md`. The `fable`/`opus` step pins in
   `SKILL.md` are explicit IDs.
4. v0.50.0 released per the repo's release process; one live unit shows the table in its dispatch log.

## Open questions

None. Step 05 implement parks when Opus is at its limit (operator's decision).
