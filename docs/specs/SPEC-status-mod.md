# Spec: Status mod

Module: `status-mod`. A Claude Code mod (function hooks) that shows the state of the loop, its work, and the model proxy in the session that owns a run.

## Objective

The operator sees, without a command, what the loop does now, what waits, and what needs a decision. The information is in a band above the prompt and, on request, in a pane on the right. The mod reads; it never acts.

Today the same facts are spread over `step.mjs --card-run` text, GitHub labels, the proxy TUI, and the transcript. The operator reads them by hand.

## Operator decisions (2026-10-12)

1. The proxy column shows three facts only: ON or OFF, the count of active requests, and the model on each request. No provider health, no routing, no history.
2. The proxy is optional. When the session does not use it, the column does not exist.
3. Placement: a band above the prompt with three columns (Loop, Work, Proxy). A pane on the right opens on request only.
4. Visual style: the mockup palette (see Code style). Status is carried by a glyph and a word, never by color alone.
5. The mod is read-only in release one. No restart, cancel, merge, or routing control.
6. Autoloop owns the mod. It ships in the plugin, on by default, and a project turns it off in `.autoloop/config.json` with `"ui": { "status": false }`.
7. The mod shows only in a session that owns a `/autoloop:dev` run. The proxy column alone never makes it appear.

## Required behavior

### Data sources

1. **One projection, owned by autoloop.** `node tools/status.mjs --json --session <id>` prints the run status as one JSON object on stdout. It is the one entry the mod calls; today it delegates to `step.mjs`'s card projection (`runCard`, `projectParked`, `ownRunMarkers`, `readPinnedModels`), and a later release that replaces the step state machine replaces only the producer. The JSON carries `"schema": "autoloop.status/1"`; the mod refuses another schema and shows `stale`. The mod does not read `.git/autoloop/` files itself and never interprets a step id: it reads `phase`, `disposition`, and `round` only. The text card does not change.
2. **Ownership.** The projection applies the session-ownership predicate (`SPEC-session-ownership.md`): the run latch of this Claude process must carry the session id the mod passes as `--session`, and a run marker must be open. A missing or different session id is not ownership. When this session owns no run, the JSON is `{ "schema": "autoloop.status/1", "owned": false }`. The mod starts the projection with `$.process.run` so the child shares the Claude pid lineage, and it passes the session id from the mod API; pid ancestry alone is not ownership.
3. **Proxy.** The mod reads `ANTHROPIC_BASE_URL` with `$.env.get`. When it is unset, the proxy column does not exist. When it is set, each tick fetches `<base>/status` with `$.http.fetch` (no `auth`). A response `{ ok: true, active_requests: [...] }` is ON. A failed fetch, a non-200, or a body that does not parse is OFF. The contract is the proxy's `GET /status` (fields: `id`, `started_at`, `elapsed_ms`, `requested_model`, `model`, `session_id`).
4. **Refresh.** One `$.clock.every(3000)` tick runs both reads. A tick that is still running when the next one fires is skipped. Each read has a timeout of 2 s. A read failure keeps the last value and marks it stale.
5. **No GitHub calls, no writes.** The projection and the mod read local files, `git rev-parse --git-common-dir`, `git config remote.origin.url`, and the proxy's loopback endpoint. Nothing else.

### JSON shape of `status.mjs --json`

```json
{
  "schema": "autoloop.status/1",
  "owned": true,
  "enabled": true,
  "run": { "openedAtMs": 0, "parkedUntil": null, "closedAt": null, "snapshotScannedAt": "ISO", "snapshotAuthority": "current|history|none" },
  "phases": ["plan", "build", "simplify", "review", "gate", "deliver"],
  "unit": { "issue": 412, "title": "...", "phase": "review", "role": "code-review", "model": "gpt-astra", "fallback": false, "round": { "kind": "fix", "n": 2, "budget": 3 }, "inFlight": true, "startedAtMs": 0, "returnedAtMs": null, "waitingOn": null, "decisions": 1 },
  "units": [
    { "issue": 412, "title": "...", "disposition": "active|waiting|blocked|returned|delivered", "phase": "review", "role": "code-review", "model": "gpt-astra", "detail": "1 major finding", "waitingOn": null, "pr": 204, "decisions": 1, "needsYou": null }
  ],
  "counts": { "active": 2, "waiting": 1, "blocked": 1, "delivered": 1, "eligible": 4 },
  "models": { "implement": "opus", "code-review": "gpt-astra" }
}
```

`title` comes from the snapshot when present, else null. `phases` is the producer's ordered phase list; `phase` is one of them, mapped in `step.mjs` beside `STEPS` (`plan` = premise, plan, plan review, claim; `build` = implement; `simplify`; `review` = diff review, code review, fix; `gate`; `deliver` = publish, record). `round` follows the `step.mjs --round` grammar: `{kind: "full"|"fix"|"re-plan"|"open-findings", n, budget}`, `n` and `budget` only for `fix`; null when the step has no round. `waitingOn` is `{kind: "issue"|"pr"|"base"|"time", number, paths, until}`. `disposition` follows the parked-view precedence in `parkedLine`; `delivered` is a unit whose merge is pending (`pending` on the step record), with its `pr`. `needsYou` is null or `{kind: "block"|"decide"|"authorize", text}`: a `POLICY_DENIED` or `IRREVERSIBLE_ACTION` block with its question, a draft delivered with `human:decide`, or a pull request carrying `human:authorize`; `counts.blocked` counts units whose `needsYou` is not null.

### Band (AbovePrompt)

6. **Visibility.** The band draws only when `owned` is true and `ui.status` is not false in the project config. Otherwise the hook passes (`next(e)`): a session that owns no run sees nothing, with or without the proxy. The band yields to a survey (`e.props.hasSurvey`). The projection reports the config value as `enabled`, so the mod reads no config file itself; when `enabled` is false the tick stops until the next `session.start`.
7. **Columns.**
   - Loop: glyph + phase + `#issue`, then `role · fix 2/3` (`re-plan`, `open findings`, or nothing when the step has no round). Idle: `Idle · last delivered #N`.
   - Work: `n active · n waiting · n needs you`. `needs you` is drawn in the critical color and only when n > 0.
   - Proxy: `● ON · n active requests` then one row per distinct `requested_model` with its count (`Opus ×1`), models sorted by count then name; or `○ OFF · 0 requests`.
8. **Phase row.** Drawn only when `unit` exists: the producer's `phases` in order, done ones with `✓`, the current with `●`, the rest with `○`. The row does not show a percentage.
9. **Needs-you row.** When `counts.blocked > 0`: one highlighted row for the oldest unit with `needsYou`, `! #N <text>`, and on the right `answer on #N` for a block or a decide, `merge or label PR #M` for an authorize. More than one: `+n more` after it. The mod registers no decide command; a human answers on the issue.
10. **Quiet minimum.** With no unit in flight and no blocked unit the band is the header plus one row per column, no phase row.
11. **Stale.** The header shows `checked Ns ago`. Past 30 s without a successful read the glyphs turn hollow and the header says `stale`.
12. **Narrow terminals.** Under 120 columns the proxy column drops the per-model rows and shows `ON · n req`; the Loop column drops the title.
13. **Expand.** A `Button` labelled `expand` with hotkey `e` opens the pane. The engine's own `ctrl+x ctrl+a` collapses the band.

### Pane

14. **Opening.** `/autoloop` (registered by the mod) and the band's `expand` button open the pane `autoloop-status`. The mod never opens it unasked. `/autoloop close` closes it.
15. **Sections.** `Needs you` (blocked units, question text, `decision` and `PR` chips), `Active`, `Waiting`, then `Proxy` with one row per active request: `requested_model → model` (or `requested_model` alone while `model` is null), elapsed time, and a `this session` mark when `session_id` equals this session's id. Empty sections are not drawn.
16. **Toast.** One toast per unit the first time it appears as blocked in this session: `#N needs you: <short>`. Tracked in `$.state`; a hot reload does not repeat it.

### Models

17. The Loop column names the pinned model of the current role from `models.<role>`; `unit.fallback` true shows `model (fallback)`.

### Config

18. **`ui.status`.** `.autoloop/config.json` accepts an optional `ui` object with one key, `status: boolean`. There is no default key: a config that never sets it keeps the hash it had (the `protectedPaths` route; a `DEFAULT_CONFIG` entry broke the devendor round-trip and would change every project's resolved-config hash). Readers ask `statusBandEnabled(config)`, true unless `ui.status === false`. Optional, so the schema version does not change. `reviewedConfig` leaves `ui` out of the review fingerprint: a display preference is not reviewed policy. `status.mjs --json` reports the value as `enabled`.

## Commands

```bash
node tools/status.mjs --json --session <id>      # the projection (delegates to step.mjs today)
node tools/status.mjs --self-test
node tools/step.mjs --self-test                  # covers the card projection the JSON is built from
node tools/verify.mjs --plugin-root .            # the plugin's full check
claude plugin validate .                         # manifest + module admission
claude plugin test .                             # the mod's *.test.ts
```

## Project structure

```
hooks/hooks.json                 adds "modules": ["./status/register.tsx"] beside the classic hooks
hooks/status/register.tsx        hooks: session.start, command.run, ui.render (AbovePrompt, Pane)
hooks/status/read.ts             the two reads: projection via $.process.run, proxy via $.http.fetch
hooks/status/view.ts             pure functions: counts → column text, width rules, model grouping
hooks/status/theme.ts            the palette and glyphs
hooks/status/*.test.ts           claude plugin test
types/index.d.ts                 PluginState contract: autoloop.status (last reads, seen blocked ids, pane open)
tools/status.mjs                 the stable producer entry: --json --session <id>, schema autoloop.status/1
tools/step.mjs                   statusProjection() beside runCard, and the PHASES map beside STEPS
docs/specs/SPEC-status-mod.md    this file
```

Risk: the engine may refuse a `hooks.json` that holds both `hooks` and `modules`. `claude plugin validate` decides this in the first build task. If refused, the mod moves to `mods/status/` with its own manifest in this repository, released with the plugin.

## Code style

- The module follows the repository's ESM style: no default exports, named functions, no classes. Pure view functions take plain data and return strings or trees; they hold no `$`.
- Palette (hex, accepted by `Text`/`Box` color props): background `#1b1c20`, panel `#22242a`, card `#282a31`, line `#363942`, ink `#e6e6e3`, ink-2 `#a3a6ad`, ink-3 `#6f737c`, accent `#d97b4f`, good `#5fb37a`, warn `#d9a441`, info `#6fa3e0`, crit `#e06c6c`.
- Glyphs: `●` active, `◷` waiting, `!` needs you, `✓` done, `○` not yet, hollow `○` for OFF and stale.
- Text wears ink colors; status colors go on glyphs and the words ON, OFF, needs you.
- Comments say why, as in the surrounding tools.

## Testing strategy

- `step.mjs --self-test` gains cases for `statusProjection`: not owned (no latch for the session id, or a different id) → `{owned:false}`; `ui.status: false` → `enabled: false`; an in-flight review step → `unit.inFlight`, `phase: 'review'`, `round: {kind:'fix', n:2, budget:3}`; a `re-plan` and an `open-findings` round; a `waiting` step on an issue and on a PR with paths → `waitingOn`; a delivered unit with `pending` → disposition `delivered` and `counts.delivered`; a `POLICY_DENIED` block, a `human:decide` draft, and a `human:authorize` PR → `needsYou` of each kind and `counts.blocked`; a fallback model → `fallback: true`; a decision count; the text card output is byte-identical before and after.
- `status.mjs --self-test`: the schema field; `--session` required; a wrong schema is refused by the view (mod test).
- `config-contract.mjs --self-test` gains: `ui.status` accepted, `ui.other` refused, `ui` absent from `reviewedConfig`.
- The mod's `*.test.ts` (via `claude plugin test`): the band passes when not owned, and when `enabled` is false even with the proxy up; the proxy column is absent with `ANTHROPIC_BASE_URL` unset; OFF on a failed fetch; ON with grouped model counts; the needs-you toast fires once per issue; stale after 30 s with the mock clock; the narrow-width rules.
- Test doubles replace only the host: `$.http.fetch` (the proxy is an external service to the mod) and `$.process.run` output, which is the projection's real JSON captured from `step.mjs --self-test` fixtures, not hand-written.
- Each test is shown failing once before the behavior exists.

## Boundaries

**Always**
- Read-only: no file writes outside `$.state` and `$.store`, no GitHub calls, no git writes, no proxy calls other than `GET /status`.
- Hide everything in a session that owns no run, and in a project with `ui.status: false`.
- Keep the text card and every existing `step.mjs` mode unchanged.

**Ask first**
- Any control (cancel, restart, merge, route change).
- A new state store under `.git/autoloop/` (the session-ownership spec requires it).
- Auto-opening the pane.

**Never**
- Draw a status that was not read: no green on missing data, no invented percentage, no guessed serving model.
- Commit secrets; the proxy endpoint carries none and the mod stores none.
