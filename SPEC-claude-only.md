# Spec: claude-only

## Objective

Autoloop runs on Claude Code only. Other models are reached through a Claude Code proxy route
(`claude <model> @<loopback-url>`), which the routing table already supports. Codex CLI and opencode
support is removed as a host and as a dispatch engine. The operator uses neither, and each one
doubles the surface that hooks, setup, verify and release have to keep in sync.

Decisions (operator, 2026-09-24):
- Codex is removed as a dispatch engine too: no `with codex` preset and no codex `ENGINES` entry.
- Setup's reconcile deletes the codex/opencode files it generated in target repositories, and only
  those. Anything it cannot prove it generated is reported and left alone.
- Every model on the standing table is assumed available. When a route's model fails and the route
  records no `>model`, the fallback is `claude-opus-5-5` on the native route. The exception is the
  code reviewers (`diff-review`, `code-review`, `doubt-review`), which default to `claude-fable-5-1`,
  because Opus wrote the code they judge (operator, same day). A route already on its default has
  no fallback and parks as today.

## Scope

| Area | Change |
|---|---|
| Plugin packaging | Delete `.codex-plugin/` and `.agents/plugins/marketplace.json` (the Codex marketplace). Keep `.claude-plugin/`. |
| Templates | Delete `codex-hooks.template.json`, `codex-reviewer-agent.template.toml`, `opencode-config.template.json`, `opencode-plugin.template.js`, `opencode-plugin.test.mjs`, `opencode-reviewer-agent.template.md`. |
| Docs | Delete `docs/opencode-smoke.md`. Strip Codex/opencode from README, CONTRIBUTING, the four affected skills, LOOP template and flow SVG. |
| `dispatch.mjs` | Remove the codex engine, its sandbox and permission-profile handling, the `codex` preset, and `review-engine` lines naming codex. The claude engine and proxy routes are unchanged. |
| `scaffold.mjs` | Stop writing `.codex/**` and `.opencode/**`. Reconcile removes a previously generated file only when its bytes match a known generated fingerprint (every released template version, or the current merge output). Otherwise it reports the file as `stale-left`. `.opencode/node_modules` and lockfiles are never touched. |
| `verify.mjs`, `release-verify.mjs`, `contract-lint.mjs`, `adapter-contract.mjs` | Drop codex/opencode artifacts, manifests and smoke-evidence rules. Keep `adapter-contract` for the Claude reviewer agent if it validates one; otherwise delete it. |
| `config-contract.mjs` | The current schema carries no host keys. Legacy migration readers keep accepting old `codex`/`opencode` host values, so an old STATE.md still migrates, and they map them to claude. No schema version bump. |
| Guard, preflight, lane, writeback, lifecycle, subagent-transcript | Remove codex/opencode-only branches and comments. `subagent-transcript` stays, since Claude's SubagentStop hook uses it. Protected-path lists keep `.codex/**` and `.opencode/**`, so a stale copy still can't be edited by the loop. |
| Default fallback | `routeFor` in `dispatch.mjs`: `--fallback` on a route with no recorded fallback resolves to `claude-opus-5-5`, native with no URL, instead of `ROUTE_FALLBACK_MISSING`. The one exception is a route whose model is already Opus, which still reports it. The automatic retry path picks up the same default, so a diff-review or code-review on astra falls back to Opus. SKILL routing table shows the defaulted fallbacks. |
| Regression index | Incidents anchored to removed code are retired with a one-line note saying why. Incidents that still apply are re-anchored. |
| Version | 0.51.0, a breaking removal in 0.x. The CHANGELOG states the removal and the reconcile deletion. |

## Out of scope

- Historical SPEC/review documents (`SPEC.md`, `review.md`, `autoloop-review-consolidated.md`,
  `docs/specs/*`, earlier module specs) keep their text. They record history.
- CHANGELOG history entries.

## Boundaries

- Never delete a file in a target repository that setup cannot prove it generated.
- Never change the claude dispatch path, the routes grammar, or the loopback rule.
- No behaviour change for a Claude Code user beyond the removal.

## Testing

- Each touched tool's `--self-test` passes, `verify.mjs --plugin-root .` passes, and
  `release-verify.mjs` passes.
- New scaffold cases, written to fail first:
  - A reconcile over a repository holding the generated `.codex/hooks.json`,
    `.codex/agents/autoloop-reviewer.toml` and the `.opencode/` files removes them.
  - A hand-edited copy is reported as `stale-left` and kept.
  - `.opencode/node_modules` is untouched.
- `dispatch.mjs`: `--engine codex` and a `review-engine` line naming codex are refused with a typed
  error, not silently mapped.
- `dispatch.mjs`: a route with no `>model` falls back to Opus, native, with the URL stripped. An Opus route with none still reports `ROUTE_FALLBACK_MISSING`. A recorded fallback still wins.
- `rg -i 'codex|opencode'` over `skills/`, `templates/`, `README.md`, `CONTRIBUTING.md` returns
  only deliberate residue:
  - the protected-path lists;
  - legacy config migration and legacy lifecycle-marker `selector` values;
  - the guard's command corpus;
  - the removed-engine refusal and the retired-file table;
  - contract-lint rules that reject stale wording.
- Live: a reconcile on living-football-engine (the operator's repository) removes its generated
  files, and a doctor run is clean.
