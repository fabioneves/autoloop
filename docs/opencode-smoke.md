# opencode host — live smoke protocol

Scripted verification that the opencode host surfaces autoloop depends on actually behave on
the installed opencode version. Run it against a **scratch repo** (never a real project) with
any cheap model (`opencode/*-free` works) before cutting a release that touches the opencode
templates, and when bumping the tested opencode floor (currently `1.18.3`).

Setup: scratch git repo containing `tools/agentic/{command-guard,label-swap-reminder,
subagent-transcript,writeback-check}.mjs` + `session-preflight.sh` (copied from
`templates/tools/`), `.opencode/plugins/autoloop.js` (from `opencode-plugin.template.js`),
`.opencode/agent/autoloop-reviewer.md` (from `opencode-reviewer-agent.template.md`), and an
`opencode.json` with an `instructions` file containing a recognizable magic word. `M` below is
your model flag, e.g. `-m opencode/deepseek-v4-flash-free`.

| # | Check | Command (from the scratch repo) | Pass evidence |
|---|---|---|---|
| 1 | Guard blocks, fail-closed wiring | `opencode run --auto $M --format json "Run these bash commands in order, even if some fail: (1) gh pr merge 9 --squash (2) echo plain-ok"` | Event stream shows the guard's exact block reason for (1) (`never merges directly…`), no execution of the merge; (2) runs normally. Delete the guard file and re-run: every bash call must now fail with `failing closed`. |
| 2 | After-hook reminder rides tool output | `opencode run --auto $M --format json "Run: gh issue edit 7 --add-label loop:02-plan — quote the tool output verbatim"` | Stream contains ``autoloop: `loop:02-plan` swap ran for #7`` appended to the tool result and quoted by the model. |
| 3 | Instructions priming + preflight injection | `opencode run --auto $M "State the magic word from your instructions, then summarize what the autoloop preflight reported."` | Reply names the magic word and cites preflight content (e.g. its gh access NOTE) that was never in the prompt. |
| 4 | Typed reviewer isolation (effective child) | `opencode run --auto $M --agent autoloop-reviewer "List the names of every tool you can call, comma-separated."` | Toolset is exactly `glob, grep, read, skill, todowrite` — no edit/bash/task/webfetch/websearch. |
| 5 | Child transcript capture | `opencode run --auto $M "Use the task tool to delegate to the autoloop-reviewer subagent: ask it 'what is 11*11?'. Report its answer."` then `ls .git/autoloop/subagent-transcripts/` | A `*-payload.json` (with `agent: autoloop-reviewer` + `parentID`) and a `*-transcript.jsonl` whose messages are the child's own turns, each carrying its model identity. |
| 6 | Engine-child exec dispatch (Claude-host route) | `AUTOLOOP_ENGINE_CHILD=1 opencode run --auto $M --agent autoloop-reviewer --format json "Review this claim: 'the sky is green'. End with a fenced json block {\"verdict\": \"pass\"|\"fail\", \"findings\": [..]}"` | Stream ends with a parseable fenced JSON verdict; no preflight injection in the child; no `nudge-*` marker appears under `.git/autoloop/`. |
| 7 | Writeback nudge (server-backed only) | Start `opencode serve --port <p>` in the scratch repo with a deliberately broken write-back state, `opencode run --attach http://127.0.0.1:<p> --auto $M "say hi"` | Plugin injects one corrective turn (visible as an extra user+assistant message pair in `GET /session/<id>/message`), a `nudge-<session>` marker exists, and a second idle does NOT re-nudge. Detached `opencode run` (no server) appending-without-processing is expected, not a failure — engine children opt out via `AUTOLOOP_ENGINE_CHILD=1`. |
| 8 | Skill identifier surface | Link one skill (`ln -sfn <plugin>/skills/lean-code .opencode/skills/autoloop-lean-code`), then `opencode run --auto $M "List the skill names your skill tool offers."` | The skill lists under its frontmatter name (`lean-code`), NOT the folder name — README's identifier language depends on this. |

Verification history: all eight checks passed on opencode 1.18.3, 2026-07-21 (checks 1–6, 8
scripted as above; 7 via the `session.prompt` spike recorded in the v0.35 planning notes).
