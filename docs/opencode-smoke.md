# opencode host — live smoke protocol

Scripted verification for the opencode surfaces Autoloop actually depends on. Run it against the
installed opencode version in a **scratch repo** (never a real project) with any cheap model
(`opencode/*-free` works) before cutting a release that touches opencode templates and when
bumping the tested opencode floor (currently `1.18.3`).

opencode is a **host**: it runs the orchestrator and the vendored guards. It is not a dispatch
target — every role dispatch goes through `tools/agentic/dispatch.mjs`, which spawns `claude -p`
directly. These checks therefore cover hook wiring, not routing.

Setup: use the same universal scaffold Setup would produce. At minimum, the scratch git repo needs
`tools/agentic/{adapter-contract,command-guard,config-contract,dispatch,label-swap-reminder,
lane-contract,prime,release-verify,review-contract,subagent-transcript,writeback-check}.mjs` plus
`session-preflight.sh` (copied from `templates/tools/`), `.opencode/plugins/autoloop.js` (from
`opencode-plugin.template.js`), `.opencode/agent/autoloop-reviewer.md` (from
`opencode-reviewer-agent.template.md`), and an `opencode.json` with an `instructions` file
containing a recognizable magic word. `M` below is your model flag, for example
`-m opencode/deepseek-v4-flash-free`.

Plugin-wiring checks deliberately run the outer host with plugins enabled.

| # | Check | Command (from the scratch repo) | Pass evidence |
|---|---|---|---|
| 1 | Guard blocks, fail-closed wiring | `opencode run --auto $M --format json "Run these bash commands in order, even if some fail: (1) gh pr merge 9 --squash (2) echo plain-ok"` | Event stream shows the guard's exact block reason for (1) (`never merges directly…`), no execution of the merge; (2) runs normally. Delete the guard file and re-run: every bash call must now fail with `failing closed`. |
| 2 | After-hook reminder rides tool output | `opencode run --auto $M --format json "Run: gh issue edit 7 --add-label loop:02-plan — quote the tool output verbatim"` | Stream contains ``autoloop: `loop:02-plan` swap ran for #7`` appended to the tool result and quoted by the model. |
| 3 | Instructions priming + preflight injection | `opencode run --auto $M "State the magic word from your instructions, then summarize what the autoloop preflight reported."` | Reply names the magic word and cites preflight content (for example its gh access NOTE) that was never in the prompt. |
| 4 | Typed reviewer isolation (effective child) | `opencode run --pure $M --agent autoloop-reviewer --format json "List the names of every tool you can call, comma-separated."` | Toolset is exactly `glob, grep, list, read`. The leading wildcard deny also closes custom/MCP, edit, bash, task, skill, LSP, question, todo, external-directory, and network tools. |
| 5 | Child transcript capture | `opencode run --auto $M "Use the task tool to delegate to the autoloop-reviewer subagent: ask it 'what is 11*11?'. Report its answer."` then `ls "$(git rev-parse --git-common-dir)/autoloop/subagent-transcripts/"` | A `*-payload.json` (with `agent: autoloop-reviewer`, `parentID`, and trusted `metadata.tools: ["glob","grep","list","read"]`) and a `*-transcript.jsonl` whose messages are the child's own turns, each carrying its model identity. Tool metadata is present only when the installed reviewer identity and closed-world permission frontmatter validate. |
| 6 | Writeback nudge (server-backed only) | Start `opencode serve --port <p>` in the scratch repo with a deliberately broken write-back state, `opencode run --attach http://127.0.0.1:<p> --auto $M "say hi"` | Plugin injects one corrective turn (visible as an extra user+assistant message pair in `GET /session/<id>/message`), a `nudge-<session>` marker exists, and a second idle does not re-nudge. Detached `opencode run` (no server) appending-without-processing is expected, not a failure; engine children opt out via `AUTOLOOP_ENGINE_CHILD=1`. |
| 7 | Skill identifier surface | Link one skill (`ln -sfn <plugin>/skills/lean-code .opencode/skills/autoloop-lean-code`), then `opencode run --auto $M "List the skill names your skill tool offers."` | The skill lists under its frontmatter name (`lean-code`), not the folder name. |

## AUTOLOOP_ENGINE_CHILD

`AUTOLOOP_ENGINE_CHILD=1` suppresses the orchestrator-only hooks (preflight injection and the
write-back nudge) inside a child process so a child never accretes injected context. It is not a
route selector and grants nothing. Setting it on an outer host invalidates checks 3 and 6 because
it disables the hooks those checks examine.

## Release evidence

Historical verification: checks 1–7 passed on opencode 1.18.3 on 2026-07-21 (checks 1–5 and 7
scripted as above; 6 via the `session.prompt` spike recorded in the v0.35 planning notes). That
predates the v0.49.1 dispatch contract, and the rerun it requires has not been performed:

- v0.49.1 live smoke evidence: untested

`untested` is a declaration, not evidence. It means no check in this document was executed against
the v0.49.1 contract, so the opencode host wiring is statically verified only. Contract
verification and `--release-mode` both report the declaration as a note and neither treats it as a
passed check.

To retire the declaration, run all seven checks and replace the line with exactly one record
containing the real UTC date, installed opencode version, SHA-256 of the sanitized manifest's exact
bytes, and its committed repository-relative location:

`- v0.49.1 live smoke evidence: date=YYYY-MM-DD; opencode=X.Y.Z; checks=1-7; sha256=<64 lowercase hex>; location=evidence/opencode-v0.49.1/manifest.json`

The location is a committed repository-relative JSON manifest, not a URL or archive. It and every
inventory member must be a bounded regular non-symlink file committed unchanged at `HEAD`.
`sha256` is the digest of the manifest's exact bytes. The manifest has exactly:

```json
{
  "kind": "autoloop-opencode-live-smoke-evidence",
  "version": 1,
  "release": "0.42.0",
  "date": "YYYY-MM-DD",
  "opencode": "X.Y.Z",
  "checks": [1, 2, 3, 4, 5, 6, 7],
  "sanitized": true,
  "files": [
    {
      "role": "check-01-stream",
      "path": "files/check-01-stream.jsonl",
      "bytes": 123,
      "sha256": "<64 lowercase hex>"
    }
  ]
}
```

`files` is ordered by unique `role`; every path is unique, relative to the manifest directory,
and below `files/`. Each entry binds its committed file's exact positive byte length and SHA-256.
The complete role inventory is `check-01-stream` through `check-07-stream`. Sanitization must
remove tokens, credentials, global configuration, and unrelated repository data before hashing.

Fingerprint the manifest with the vendored helper so the recorded digest is portable:

```sh
node tools/agentic/release-verify.mjs \
  --fingerprint-stdin <evidence/opencode-v0.49.1/manifest.json
```
