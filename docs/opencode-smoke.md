# opencode host — live smoke protocol

Scripted verification for the opencode surfaces Autoloop actually depends on. Run it against the
installed opencode version in a **scratch repo** (never a real project) with any cheap model
(`opencode/*-free` works) before cutting a release that touches opencode templates and when
bumping the tested opencode floor (currently `1.18.3`).

Setup: use the same universal scaffold Setup would produce. At minimum, the scratch git repo needs
`tools/agentic/{adapter-contract,command-guard,config-contract,continuation-store,
label-swap-reminder,lane-contract,release-verify,review-contract,route-adapter-contract,
run-scope,runtime-contract,subagent-transcript,writeback-check}.mjs` plus
`session-preflight.sh` (copied from `templates/tools/`), `.opencode/plugins/autoloop.js` (from
`opencode-plugin.template.js`), `.opencode/agent/autoloop-reviewer.md` (from
`opencode-reviewer-agent.template.md`), and an `opencode.json` with an `instructions` file
containing a recognizable magic word. Leave the safe Claude and Codex scaffold artifacts present
too; their presence must not influence route selection. `M` below is your model flag, for example
`-m opencode/deepseek-v4-flash-free`.

Plugin-wiring checks deliberately run the outer host with plugins enabled. External route-adapter
checks use `--pure` and omit `--auto`, matching the production launch contract: project agents
remain available, third-party plugins are disabled, and the reviewer permission map remains
authoritative.

| # | Check | Command (from the scratch repo) | Pass evidence |
|---|---|---|---|
| 1 | Guard blocks, fail-closed wiring | `opencode run --auto $M --format json "Run these bash commands in order, even if some fail: (1) gh pr merge 9 --squash (2) echo plain-ok"` | Event stream shows the guard's exact block reason for (1) (`never merges directly…`), no execution of the merge; (2) runs normally. Delete the guard file and re-run: every bash call must now fail with `failing closed`. |
| 2 | After-hook reminder rides tool output | `opencode run --auto $M --format json "Run: gh issue edit 7 --add-label loop:02-plan — quote the tool output verbatim"` | Stream contains ``autoloop: `loop:02-plan` swap ran for #7`` appended to the tool result and quoted by the model. |
| 3 | Instructions priming + preflight injection | `opencode run --auto $M "State the magic word from your instructions, then summarize what the autoloop preflight reported."` | Reply names the magic word and cites preflight content (for example its gh access NOTE) that was never in the prompt. |
| 4 | Typed reviewer isolation (effective child) | `opencode run --pure $M --agent autoloop-reviewer --format json "List the names of every tool you can call, comma-separated."` | Toolset is exactly `glob, grep, list, read`. The leading wildcard deny also closes custom/MCP, edit, bash, task, skill, LSP, question, todo, external-directory, and network tools. The process runs without third-party plugins and without global auto-approval. |
| 5 | Child transcript capture | `opencode run --auto $M "Use the task tool to delegate to the autoloop-reviewer subagent: ask it 'what is 11*11?'. Report its answer."` then `ls "$(git rev-parse --git-common-dir)/autoloop/subagent-transcripts/"` | A `*-payload.json` (with `agent: autoloop-reviewer`, `parentID`, and trusted `metadata.tools: ["glob","grep","list","read"]`) and a `*-transcript.jsonl` whose messages are the child's own turns, each carrying its model identity. Tool metadata is present only when the installed reviewer identity and closed-world permission frontmatter validate. |
| 6 | Claude → opencode adapter dispatch | `AUTOLOOP_ENGINE_CHILD=1 opencode run --pure $M --agent autoloop-reviewer --format json "Review this claim: 'the sky is green'. Return only the configured typed verdict object."` | Stream contains exactly one parseable typed verdict with `verdict`, `findings`, and `rebuts`; no preflight injection in the child; no `nudge-*` marker appears under `.git/autoloop/`; no third-party plugin runs. `AUTOLOOP_ENGINE_CHILD` controls child hook behavior only; it selects no route. |
| 7 | Writeback nudge (server-backed only) | Start `opencode serve --port <p>` in the scratch repo with a deliberately broken write-back state, `opencode run --attach http://127.0.0.1:<p> --auto $M "say hi"` | Plugin injects one corrective turn (visible as an extra user+assistant message pair in `GET /session/<id>/message`), a `nudge-<session>` marker exists, and a second idle does not re-nudge. Detached `opencode run` (no server) appending-without-processing is expected, not a failure; engine children opt out via `AUTOLOOP_ENGINE_CHILD=1`. |
| 8 | Skill identifier surface | Link one skill (`ln -sfn <plugin>/skills/lean-code .opencode/skills/autoloop-lean-code`), then `opencode run --auto $M "List the skill names your skill tool offers."` | The skill lists under its frontmatter name (`lean-code`), not the folder name. |
| 9 | Invocation-scoped route selection | Link the `setup` skill, explicitly unset `AUTOLOOP_ENGINE_CHILD`, and run four fresh outer setup commands with arguments `doctor`, `doctor with opencode`, `doctor with codex`, and `doctor with claude`. Capture `git status --porcelain` before and after. | Bare doctor reports selector `native` and route `opencode.native`; explicit opencode reports selector `opencode` and the same native route. Codex and Claude selectors return `UNSUPPORTED_ROUTE` before mutation. Installed Claude/Codex artifacts do not select a route and the worktree stays unchanged. |
| 10 | Authenticated relaunch crash recovery | Start one token-gated server, run a real auto-continue queue invocation, and let the injected smoke directive request the normal context-budget finish immediately after its first delivered unit while another eligible unit remains. Follow the same-server procedure below. | One unchanged server PID and its host-bound authority broker survive one-shot handler aborts at request-issued, session-created, and context-injected. Fresh attached driver sessions take over only after the real five-minute owner expiry where ownership exists. The durable chain ends issued→claimed→session-created→opened→prompted, with one bound continuation session, one authenticated context, and one fixed prompt. |

## Check 9: outer versus child process semantics

Run every doctor as an outer host with the child flag removed, even if the calling shell inherited
it:

```sh
env -u AUTOLOOP_ENGINE_CHILD opencode run --command setup --auto $M "doctor"
env -u AUTOLOOP_ENGINE_CHILD opencode run --command setup --auto $M "doctor with opencode"
env -u AUTOLOOP_ENGINE_CHILD opencode run --command setup --auto $M "doctor with codex"
env -u AUTOLOOP_ENGINE_CHILD opencode run --command setup --auto $M "doctor with claude"
```

`AUTOLOOP_ENGINE_CHILD=1` is valid only on an actual engine-child process, such as check 6. Its
negative meaning is limited to suppressing orchestrator-only preflight, write-back, and relaunch
hooks in that child. It is not a route selector, a doctor input, or evidence that an outer host is
safe. Setting it on an outer doctor invalidates check 9 because it disables the hooks being
examined.

## Check 10: same-server authenticated crash protocol

Use a fresh scratch repository with at least two genuinely eligible queue units. The first unit
must go through the normal delivery path; do not substitute a fixture, hand-written request, copied
Git state, or edited evidence. Begin on the configured base branch with a clean worktree and no
`relaunch-request`:

```sh
test -z "$(git status --porcelain)"
GIT_STATE=$(git rev-parse --git-path autoloop)
case "$GIT_STATE" in
  /*) ;;
  *) GIT_STATE="$PWD/$GIT_STATE" ;;
esac
test ! -e "$GIT_STATE/relaunch-request"

PORT=4097
BASE="http://127.0.0.1:$PORT"
EVIDENCE=$(mktemp -d)
SMOKE_TOKEN=$(openssl rand -hex 32)
SMOKE_TOKEN_FINGERPRINT=$(
  printf '%s' "$SMOKE_TOKEN" |
    node -e '
      const { createHash } = require("node:crypto")
      const chunks = []
      process.stdin.on("data", (chunk) => chunks.push(chunk))
      process.stdin.on("end", () => {
        process.stdout.write(
          createHash("sha256").update(Buffer.concat(chunks)).digest("hex")
        )
      })
    '
)

AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL=authenticated-continuation-crash-v1 \
AUTOLOOP_SMOKE_OPERATOR_TOKEN="$SMOKE_TOKEN" \
env -u AUTOLOOP_ENGINE_CHILD \
opencode serve --port "$PORT" >"$EVIDENCE/server.log" 2>&1 &
SERVER_PID=$!
unset SMOKE_TOKEN
test -z "${SMOKE_TOKEN+x}"
```

The plugin hashes the operator token once and deletes both smoke variables from its own process
environment during module loading. Only the fingerprint remains in status logs and crash markers.
The shell deletes its raw copy immediately after starting the server. Never persist either smoke
variable in a service definition.

Use these helpers. `assert_server` is run after every simulated handler crash. The owner helper
waits until the newest durable owner record is more than 300,000 milliseconds old; do not edit
timestamps, shorten the lease, change the clock, or restart the server.

```sh
assert_server () {
  kill -0 "$SERVER_PID"
  curl -fsS "$BASE/session" >/dev/null
}

wait_for_server () {
  until curl -fsS "$BASE/session" >/dev/null 2>&1; do
    kill -0 "$SERVER_PID"
    sleep 1
  done
}

wait_for_crash () {
  BOUNDARY=$1
  while true; do
    assert_server
    MATCHES=$(
      find "$GIT_STATE/smoke-crashes" -maxdepth 1 -type f \
        -name "*-$BOUNDARY.json" -print 2>/dev/null
    )
    COUNT=$(printf '%s\n' "$MATCHES" | sed '/^$/d' | wc -l | tr -d ' ')
    if [ "$COUNT" = 1 ]; then
      printf '%s\n' "$MATCHES"
      return
    fi
    test "$COUNT" = 0
    sleep 1
  done
}

wait_for_owner_expiry () {
  while true; do
    OWNER_MS=$(
      jq -s 'sort_by(.revision) | last | .acquiredAtMs' \
        "$LEASE_DIR"/owner-*.json
    )
    NOW_MS=$(node -p 'Date.now()')
    AGE_MS=$((NOW_MS - OWNER_MS))
    if [ "$AGE_MS" -gt 300000 ]; then
      printf '%s\n' "$AGE_MS" >>"$EVIDENCE/observed-owner-expiry-ms.txt"
      return
    fi
    sleep 5
  done
}

drive_recovery () {
  NAME=$1
  env -u AUTOLOOP_ENGINE_CHILD \
    opencode run --attach "$BASE" --auto $M --format json \
      "Recovery driver $NAME: acknowledge this message only." \
      >"$EVIDENCE/$NAME.jsonl" 2>&1 ||
    true
}
```

Wait for the server, then start the normal queue invocation. The smoke seam contributes only a
one-shot, no-reply directive: after the first real unit is delivered, gather fresh queue evidence,
call the normal authenticated `RuntimeContract.finish()` context-budget path, and pipe its complete
result unchanged to `continuation-store.mjs --issue`. The seam has no request constructor and
cannot write a continuation request itself.

```sh
wait_for_server
env -u AUTOLOOP_ENGINE_CHILD \
  opencode run --attach "$BASE" --auto $M --format json \
    "/autoloop:dev; auto-continue; drain the eligible queue" \
    >"$EVIDENCE/origin.jsonl" 2>&1 ||
  true

REQUEST_CRASH=$(wait_for_crash request-issued)
assert_server
test "$(jq -r '.processId' "$REQUEST_CRASH")" = "$SERVER_PID"
test "$(jq -r '.operatorTokenFingerprint' "$REQUEST_CRASH")" = \
  "$SMOKE_TOKEN_FINGERPRINT"

LEASE=$(jq -r '.leaseFingerprint' "$REQUEST_CRASH")
LEASE_DIR="$GIT_STATE/continuations/$LEASE"
test -f "$LEASE_DIR/request.json"
test -f "$LEASE_DIR/state-000-issued.json"
test "$(find "$LEASE_DIR" -maxdepth 1 -name 'state-*.json' | wc -l | tr -d ' ')" = 1
test "$(find "$LEASE_DIR" -maxdepth 1 -name 'owner-*.json' | wc -l | tr -d ' ')" = 0
jq -e --arg lease "$LEASE" '
  .action == "relaunch"
  and .reason == "context-budget"
  and .continuationState.status == "issued"
  and .lease.fingerprint == $lease
' "$LEASE_DIR/request.json"
```

The request-issued abort occurs only after the original run has issued its validated request and
before the plugin calls `--claim`; no owner exists yet. Archive the genuine delivery, finish, and
issue output from `origin.jsonl`. A request marker without a normally delivered first unit and a
store-accepted request is not pass evidence.

The first fresh driver consumes the request-issued marker, claims the request, creates and binds
the continuation session, then aborts immediately after `session-created`:

```sh
drive_recovery driver-session-created
SESSION_CRASH=$(wait_for_crash session-created)
assert_server
test "$(jq -r '.processId' "$SESSION_CRASH")" = "$SERVER_PID"
test "$(jq -r '.leaseFingerprint' "$SESSION_CRASH")" = "$LEASE"
SESSION_ID=$(jq -r '.continuationSessionId' "$SESSION_CRASH")
test -n "$SESSION_ID"
test -f "$LEASE_DIR/session.json"
test -f "$LEASE_DIR/state-002-session-created.json"
test ! -e "$LEASE_DIR/state-003-opened.json"
```

Wait for the real owner lease to expire. A second fresh driver then adopts the same durable claim
and bound continuation session, opens the authenticated bundle, injects the context, and aborts
before prompt intent:

```sh
wait_for_owner_expiry
drive_recovery driver-context-injected
CONTEXT_CRASH=$(wait_for_crash context-injected)
assert_server
test "$(jq -r '.processId' "$CONTEXT_CRASH")" = "$SERVER_PID"
test "$(jq -r '.continuationSessionId' "$CONTEXT_CRASH")" = "$SESSION_ID"
test -f "$LEASE_DIR/state-003-opened.json"
test -f "$LEASE_DIR/effect-context-inject.json"
test ! -e "$LEASE_DIR/effect-prompt.json"
test ! -e "$LEASE_DIR/state-004-prompted.json"
```

After the next real owner expiry, a third fresh driver reconciles the already injected context,
sends the fixed prompt once, and completes the append-only transition:

```sh
wait_for_owner_expiry
drive_recovery driver-prompted
while [ ! -f "$LEASE_DIR/state-004-prompted.json" ]; do
  assert_server
  sleep 1
done
assert_server

ACTUAL_STATES=$(
  node tools/agentic/release-verify.mjs \
    --list-continuation-states "$LEASE_DIR"
)
EXPECTED_STATES=$(printf '%s\n' \
  state-000-issued.json \
  state-001-claimed.json \
  state-002-session-created.json \
  state-003-opened.json \
  state-004-prompted.json)
test "$ACTUAL_STATES" = "$EXPECTED_STATES"
test "$(jq -r '.sessionId' "$LEASE_DIR/session.json")" = "$SESSION_ID"
test -f "$LEASE_DIR/effect-prompt.json"

jq -s -e \
  --argjson pid "$SERVER_PID" \
  --arg token "$SMOKE_TOKEN_FINGERPRINT" '
    length == 3
    and all(.[]; .processId == $pid)
    and all(.[]; .operatorTokenFingerprint == $token)
    and (map(.handlerSessionId) | unique | length) == 3
  ' "$REQUEST_CRASH" "$SESSION_CRASH" "$CONTEXT_CRASH"
```

Fetch `GET /session/$SESSION_ID/message` and retain the sanitized response. It must contain exactly
one context beginning `## autoloop continuation (validated and session-bound)` whose JSON includes
`continuationAuthorization`, and exactly one text part equal to `.prompt` from
`$LEASE_DIR/request.json`. Their SHA-256 values must match the corresponding durable effect
intent. The three crash markers, the armed status log, and every successful recovery transition
must name the original `SERVER_PID`; a server exit, restart, changed PID, lost authority broker, or
typed unavailable status makes the check unavailable or failed, never recovered.

Do not create scratch copies at intermediate filesystem states, restore a cleared pointer, mutate
authenticated inputs, or claim a live prompted-replay result. Deterministic corruption, replay,
CAS, and validation rejection cases belong to the vendored contract self-tests. This live check
proves only the genuine same-server path it actually executes.

Copy the sanitized origin/driver streams, server log, message response, request, state/effect/
owner files, and crash markers into the manifest directory's `files/` tree in the release
checkout. Exclude credentials, global opencode configuration, unrelated prompts, and the raw
operator token. Stop and wait for the server only after those evidence copies are complete:

```sh
kill "$SERVER_PID"
wait "$SERVER_PID" || true
node tools/agentic/release-verify.mjs \
  --fingerprint-stdin <evidence/opencode-v0.41.1/manifest.json
```

The plugin reports a typed
`{"kind":"autoloop-opencode-continuation-smoke","status":"unavailable",...}` when the token gate is
malformed, the Git state path is unavailable, a request predates the smoke origin, or directive
injection fails. Record that result as unavailable; do not seed a request or reconstruct evidence
to continue. With both smoke variables absent, the seam is inert.

Historical verification: checks 1–8 passed on opencode 1.18.3 on 2026-07-21 (checks 1–6 and 8
scripted as above; 7 via the `session.prompt` spike recorded in the v0.35 planning notes). That
predates the v0.40.0 invocation contract, and the rerun it requires was deliberately skipped, so the
OpenCode routes ship without live verification:

- v0.41.1 live smoke evidence: untested

`untested` is a declaration, not evidence. It means no check in this document was executed against
the v0.40.0 contract: the two OpenCode routes in the closed catalog — native opencode and
Claude→opencode — are statically verified only, and their live behaviour is unproven. Contract
verification and `--release-mode` both report the declaration as a note and neither treats it as a
passed route. Operators selecting `with opencode` are running an unverified route.

To retire the declaration, run all ten checks and replace the line with exactly one record
containing the real UTC date, installed opencode version, SHA-256 of the sanitized manifest's exact
bytes, and its committed repository-relative location:

`- v0.41.1 live smoke evidence: date=YYYY-MM-DD; opencode=X.Y.Z; checks=1-10; sha256=<64 lowercase hex>; location=evidence/opencode-v0.41.1/manifest.json`

The location is a committed repository-relative JSON manifest, not a URL or archive. It and every
inventory member must be a bounded regular non-symlink file committed unchanged at `HEAD`.
`sha256` is the digest of the manifest's exact bytes. The manifest has exactly:

```json
{
  "kind": "autoloop-opencode-live-smoke-evidence",
  "version": 1,
  "release": "0.41.0",
  "date": "YYYY-MM-DD",
  "opencode": "X.Y.Z",
  "checks": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
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
The complete role inventory is `check-01-stream` through `check-09-stream`, then
`check-10-origin-stream`, the three `check-10-driver-{request-issued,session-created,context-injected}-stream`
roles, `check-10-server-log`, `check-10-message-response`, `check-10-request`, the five
`check-10-state-{issued,claimed,session-created,opened,prompted}` roles, the three
`check-10-effect-{session-create,context-inject,prompt}` roles, the three
`check-10-owner-{claim,session-recovery,context-recovery}` roles, and the three
`check-10-crash-{request-issued,session-created,context-injected}` roles. Sanitization must remove
tokens, credentials, global configuration, and unrelated repository data before hashing.
