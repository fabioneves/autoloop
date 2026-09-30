# Spec: step models as configuration

Supersedes the recording mechanics of `SPEC-model-routing.md` (routes file, presets, proxy URLs).
Its invariant stays and becomes code: **no artifact is judged by the model that wrote it.**

## Objective

The operator sets, per step, the model, its reasoning effort and its fallback in JSON config:
one global file with defaults, overridable per project. The loop no longer records routes or
knows about proxies. The session command (`claudeproxy`, `claudeloop`, …) decides which models
are reachable. A model the session cannot serve falls back to the role's fallback.

Operator decisions, 2026-09-30:
- Global file, created with defaults when missing, overridable by the project's config.
- The global file holds models only. Gate, merge, tracker and review stay per project.
- The proxy is the session's concern. Autoloop drops `@url`, presets and `ANTHROPIC_BASE_URL`
  injection. A dispatch inherits the session's environment.
- A config where a reviewer could run on its writer's model is refused, fallbacks included.
- The default table is the strict one below.

## Files

- **Global:** `${CLAUDE_CONFIG_DIR:-~/.claude}/autoloop/config.json`.
  - When the file is missing, the first tool that resolves models (prime, dispatch) writes it
    atomically with the defaults.
  - If it can't be written, the built-in defaults apply and prime says so.
  - Shape: `{"version": "1", "models": {<role>: {model, effort?, fallback?}}}`.
  - Unknown keys are refused.
- **Project:** `.autoloop/config.json` may carry `models` with any subset of roles and fields.
  - Schema 0.29.0, with a no-op migration from 0.28.0.
  - `models` is left out of the review contract's `projectConfig` fingerprint. Routing is not
    reviewed policy, and each dispatch result stamps the model it actually ran.
- **Resolution:** built-in defaults ← global ← project, per role and per field. Every tool reads
  one resolver.

## Roles and defaults

All ids carry `[1m]`; a gateway serves a bare id with a 200k window.

| role | model | effort | fallback |
|---|---|---|---|
| plan | gpt-6-astra | xhigh | claude-opus-5-5 |
| plan-review | claude-fable-5-1 | xhigh | claude-sonnet-5 |
| implement | claude-opus-5-5 | — | claude-fable-5-1 |
| fix | claude-opus-5-5 | — | claude-fable-5-1 |
| simplify | claude-fable-5-1 | — | claude-opus-5-5 |
| diff-review, code-review, doubt-review | gpt-6-astra | xhigh | claude-sonnet-5 |

- `effort` is `low|medium|high|xhigh|max` or absent (the engine default).
- `fallback` is a model id or `null`. The fallback runs at the role's effort.

## The invariant, enforced

The writer → reviewer pairs are:
- `plan` → `plan-review`;
- each of `implement`, `fix`, `simplify` → each of `diff-review`, `code-review`, `doubt-review`.

For every pair, the sets {reviewer model, reviewer fallback} and {writer model, writer fallback}
must not intersect. Ids are compared case-insensitively, with any `[…]` suffix and a
`<vendor>-gateway-` prefix removed.

A violation refuses the resolved config and names the pair. Prime then fails and dispatch fails
closed. A one-off `--model` override on a dispatch is outside the table and is stamped on the
result.

## Fallback

A dispatch falls back to its role's fallback in these cases:
- **Model unavailable**, any role: the engine reports `model_not_found` (measured: exit 1, zero
  tokens, "There's an issue with the selected model").
- **Usage limit or repeated transient failure**, reviewer roles, automatically, as today.
- **Writers at a usage limit** still take one manual `--fallback` retry.

A role with a `null` fallback refuses as `ROUTE_FALLBACK_MISSING`.

## Removed

- `dispatch.mjs --record-routes`, its presets, the `.git/autoloop/routes` file and the legacy
  `review-engine` file.
- `@url`/loopback parsing and `ANTHROPIC_BASE_URL` injection.
- The skill's "record routes" step and its model tables; the README's table becomes a pointer to
  the config.
- `session-preflight.sh`'s route printout. It prints the resolved table's source instead.

## Also

- Prime reports `models` (the resolved table) and `modelsSource`, so the run frame names the
  models.
- The global config is a protected path while a run is open: the loop does not change its own
  models.

## Testing

- The resolver self-test covers:
  - defaults, creating a missing global file, per-field merging;
  - unknown keys and bad effort refused;
  - every invariant pair refused, fallbacks included, with the normalisation;
  - the default table accepted.
- Dispatch self-test:
  - the route comes from the resolved table;
  - `model_not_found` falls back for a writer and a reviewer;
  - a `null` fallback refuses.
- Config-contract self-test: the 0.29.0 migration, and `models` absent from the fingerprint.
- `verify --plugin-root .`, plus a live `dispatch.mjs --role plan-review` smoke under plain
  `claude`, where astra is unavailable and the fallback path runs.
