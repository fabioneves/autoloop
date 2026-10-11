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

Operator update, 2026-10-11:
- Default effort is `high` for every role and its fallback.
- Select model families, not fixed release IDs. Preserve role assignments and `[1m]` context selection.
- The serving CLI/gateway resolves each alias. Autoloop has no model-version map or catalog query.
- Update the operator's existing global table once, with approval. Do not automatically rewrite other saved tables or edit active run pins.

## Files

- **Global:** `${CLAUDE_CONFIG_DIR:-~/.claude}/autoloop/config.json`.
  - When the file is missing, the first tool that resolves models (prime, dispatch) writes it
    atomically with the defaults.
  - If it can't be written, the built-in defaults apply and prime says so.
  - Shape: `{"version": "1", "models": {<role>: {model, effort?, fallback?}}}`.
  - Unknown keys are refused.
- **Project:** `.autoloop/config.json` may carry `models` with any subset of roles and fields.
  - It is an optional key under schema 0.28.0. There is no version bump, which would have sent
    every repository through a migration PR for a key it need not carry.
  - `models` is left out of the review contract's `projectConfig` fingerprint. Routing is not
    reviewed policy, and each dispatch result stamps the model it actually ran.
- **Resolution:** built-in defaults ← global ← project, per role and per field. Every tool reads
  one resolver.

## Roles and defaults

All default selectors carry `[1m]` to preserve the configured context window. This suffix is not
a model version. The CLI/gateway owns alias availability and version selection; `astra` and `sol`
are gateway-defined aliases. No SDK or provider migration is part of this change.

| role | model | effort | fallback |
|---|---|---|---|
| plan | astra[1m] | high | opus[1m] |
| plan-review | fable[1m] | high | sonnet[1m] |
| implement | opus[1m] | high | fable[1m] |
| fix | opus[1m] | high | fable[1m] |
| simplify | fable[1m] | high | opus[1m] |
| diff-review, code-review, doubt-review | astra[1m] | high | sonnet[1m] |

- `effort` is `low|medium|high|xhigh|max` or `null`. Omitted fields inherit from the lower-precedence
  table; explicit `null` omits the CLI effort option and uses the engine default.
- `fallback` is a model selector or `null`. The fallback runs at the role's effort.
- `sol` is a supported selector, without a new default role assignment.
- Explicit fixed-version overrides remain supported; they are not default selections.

## The invariant, enforced

The writer → reviewer pairs are:
- `plan` → `plan-review`;
- each of `implement`, `fix`, `simplify` → each of `diff-review`, `code-review`, `doubt-review`.

For every pair, the sets {reviewer model, reviewer fallback} and {writer model, writer fallback}
must not intersect. Preserve the existing case, context suffix, vendor path, gateway prefix, and
release-date normalization. A recognized single-family alias can overlap any fixed-version ID
from that family; reject that pair in either direction. Do not collapse two explicit different
versions into one family identity. Unknown/custom selectors retain exact normalized comparison.

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
- Prime pins the resolved table at `<git common dir>/autoloop/models.json`, which is protected
  run state, and every dispatch runs the pinned table (review finding).
  - A writer editing its branch's `.autoloop/config.json` can't move its own reviewers.
  - A global edit takes effect at the next prime, not in an already running process.
  - A pin freezes the configured selector, not the upstream release to which an alias resolves.
  - Outside a run, a dispatch resolves the checkout's own table, and an invalid project config
    refuses.
- A writer is sent to its fallback only when the run did no work: the checkout is unchanged and
  the final result shows no tokens or turns (review finding).
- The global config is a protected path while a run is open: the loop does not change its own
  models.

## Source structure and code style

Use the existing Node.js ESM tools and embedded `--self-test` fixtures:
- `tools/models-config.mjs`: defaults, validation, comparison, resolution, and run pins.
- `tools/dispatch.mjs`, `tools/prime.mjs`: consumers and fake-CLI integration tests.
- `tools/step.mjs`: model labels and badges.
- `tools/regression-index.mjs`: retained regression anchors.

Keep immutable tables and small pure comparison functions. For example:

```js
const reviewer = (fallback) => Object.freeze({ model: 'astra[1m]', effort: 'high', fallback });
```

## Commands and boundaries

```bash
node tools/models-config.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/prime.mjs --self-test
node tools/step.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

- Always: test changes first, preserve override precedence and reviewer independence, and simplify before review.
- Ask first: dependency, permission, provider, project-override, release, installation, or publication changes.
- Never: overwrite unrelated work, edit active pins by hand, commit the operator's global file or secrets, or make paid model calls for these tests.

Plan and task tracking: `tasks/plan-model-defaults.md` and `tasks/todo-model-defaults.md`.

## Testing

- The resolver self-test covers:
  - defaults, creating a missing global file, per-field merging;
  - unknown keys and bad effort refused;
  - every invariant pair refused, fallbacks included, with the normalisation;
  - the default table accepted, with every effort `high` and no release-specific selector;
  - alias/version overlap in both directions, future versions, and explicit-version distinctions;
  - existing global files and run pins remain unchanged unless their owning operation updates them.
- Dispatch self-test:
  - the route comes from the resolved table;
  - `model_not_found` falls back for a writer and a reviewer;
  - a `null` fallback refuses.
- Config-contract self-test: `models` shape-checked, and absent from the fingerprint.
- Dispatch self-test also proves exact alias/`[1m]` and high-effort argv, explicit-null omission,
  and fallback fixtures that match the alias arguments.

### Historical live smoke

The 2026-09-30 smoke used `dispatch.mjs --role code-review` under plain `claude`, where astra
was unavailable and the fallback path ran. This is retained evidence, not a paid test to repeat
for the defaults change.
- plan-review used reachable Fable in that environment and could not exercise the fallback.
- Run 2026-09-30: `ENGINE_EXIT_NONZERO (model unavailable) on gpt-6-astra[1m]`, then
  `claude-sonnet-5[1m]` at `xhigh`, verdict `pass` in 22 s.
- `CLAUDE_CONFIG_DIR` also holds Claude Code's credentials. A real engine must keep the operator's.
