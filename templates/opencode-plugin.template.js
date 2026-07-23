// Autoloop opencode plugin — vendored into the host repo as .opencode/plugins/autoloop.js by
// autoloop:setup. Wires opencode's plugin hooks to the repo-vendored guard scripts in
// tools/agentic/ — the repo's copies stay authoritative; this file carries NO policy of its own.
//
// Hook postures (each deliberate, mirroring .claude/settings.json / .codex/hooks.json):
//   tool.execute.before (bash) → command-guard.mjs   FAIL CLOSED: a missing or crashing guard
//                                                    blocks bash — refusing commands beats
//                                                    running unguarded ones.
//   tool.execute.after  (bash) → label-swap-reminder FAIL OPEN: a reminder must never break a
//                                                    tool result.
//   session.created            → session-preflight   FAIL OPEN + informational: FAIL lines are
//                                                    injected as context; the dev skill stops on
//                                                    them, the plugin does not gate.
//   session.idle (child)       → subagent-transcript FAIL OPEN: the child's own messages are
//                                                    captured via the SDK (attributable — unlike
//                                                    Codex transcript_path, child turns are
//                                                    provably the child's).
//   session.idle (own session) → writeback-check     Nudge-once: a hard gap (exit 2) injects ONE
//                                                    corrective turn; a marker file in
//                                                    .git/autoloop/ is the stop_hook_active
//                                                    equivalent and is removed when the check
//                                                    passes again. Verified: server-backed
//                                                    sessions process the nudge; detached
//                                                    one-shot `opencode run` does not (engine
//                                                    children opt out via AUTOLOOP_ENGINE_CHILD).
//   session.idle (own session) → relaunch-request    Auto-continue: after a CLEAN park (writeback
//                                                    passed), if the dev skill left a fresh
//                                                    .git/autoloop/relaunch-request and the tree is
//                                                    clean, spawn a FRESH session to take the next
//                                                    unit — draining the queue across the context
//                                                    boundary. Policy-free: the skill decides
//                                                    whether to write the request (opt-in, progress
//                                                    gate, generation cap); the plugin only executes
//                                                    it. Consume-once. Server-backed only — a
//                                                    fire-and-forget child needs the server to
//                                                    outlive this session (systemd/attach); the
//                                                    request is simply left for the human otherwise.
//
// AUTOLOOP_ENGINE_CHILD=1 (set by the Claude host on every `opencode run` engine dispatch)
// skips the orchestrator-only hooks (preflight injection, writeback nudge) so engine children
// never accrete injected context in their transcripts. Command guarding stays on for children.
//
// Runs under Bun (opencode's plugin runtime) but shells out to `node` for the vendored tools so
// exactly one copy of each guard exists per repo, with its own --self-test.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const Autoloop = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const tool = (name) => join(root, "tools/agentic", name)
  const isEngineChild = process.env.AUTOLOOP_ENGINE_CHILD === "1"

  const runNode = (script, stdinPayload) =>
    spawnSync("node", [script], {
      input: JSON.stringify(stdinPayload),
      encoding: "utf8",
      timeout: 45000,
      cwd: root,
    })

  // tool.execute.after receives only {title, output, metadata} — the command must be
  // correlated from the before hook by callID.
  const pendingCommands = new Map()
  const rememberCommand = (callID, command) => {
    if (pendingCommands.size > 100) pendingCommands.clear() // dropped afters must not leak
    if (callID) pendingCommands.set(callID, command)
  }

  // Context injection (noReply: the message is context for the next turn, not a new turn).
  const inject = async (sessionID, text) => {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text }] },
      })
    } catch (e) {
      await client.app.log({ body: { service: "autoloop", level: "warn", message: `context injection failed: ${e.message}` } }).catch(() => {})
    }
  }

  const log = (level, message) =>
    client.app.log({ body: { service: "autoloop", level, message } }).catch(() => {})

  // Clean tree = no uncommitted changes. The dev skill parks on the base branch with a clean tree;
  // a fresh session must never be spawned onto an in-progress unit.
  const gitClean = () => {
    const res = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 10000, cwd: root })
    return res.status === 0 && (res.stdout ?? "").trim() === ""
  }

  // The ONLY prompt the plugin will execute: the exact canonical drain template (mirrors
  // RELAUNCH_PROMPT_PREFIX in tools/agentic/run-scope.mjs), parameterized only by generation. A
  // marker is a request to run THIS drain, never an arbitrary instruction — anyone who can write
  // .git/autoloop/ (a denylist-only command guard does not stop that) could otherwise inject a
  // verbatim prompt into a fresh autonomous session. Validating the shape refuses everything else.
  const CANONICAL_RELAUNCH_PROMPT =
    /^Load the autoloop dev skill and drain the queue; auto-continue across sessions; stop per STATE's stop condition\. \[autoloop-relaunch gen=(\d+)\]$/

  // Consume a pending relaunch request after a clean park and spawn a fresh drain session. The dev
  // skill authored the request (it owns the opt-in, progress-gate, and generation-cap decisions);
  // here we only execute it, and only if it matches the canonical shape. Consume-once (delete before
  // spawning) and fail open — a relaunch failure leaves the session parked exactly as today.
  // Note: in a linked git worktree `.git` is a file, so this path never resolves and the mechanism
  // no-ops (fails safe). The marker is a single global slot, not per-session — safe because the loop
  // serializes one orchestrator per checkout, and freshness + shape bound any cross-session pickup.
  const maybeRelaunch = async () => {
    const reqPath = join(root, ".git", "autoloop", "relaunch-request")
    if (!existsSync(reqPath)) return
    let raw = ""
    let freshMs = Infinity
    let readOk = false
    try {
      raw = readFileSync(reqPath, "utf8")
      freshMs = Date.now() - statSync(reqPath).mtimeMs
      readOk = true
    } catch {
      /* unreadable — fall through to consume + ignore */
    }
    rmSync(reqPath, { force: true }) // consume-once: gone before any spawn, whatever the outcome
    let prompt = null
    try {
      const parsed = JSON.parse(raw)
      const m = parsed && parsed.v === 1 && typeof parsed.prompt === "string"
        ? parsed.prompt.match(CANONICAL_RELAUNCH_PROMPT)
        : null
      const gen = m ? Number(m[1]) : 0
      if (m && gen >= 1 && gen <= 99) prompt = parsed.prompt // sanity gen bound; the real cap lives in the skill
    } catch {
      /* malformed JSON */
    }
    // A relaunch fires within seconds of the skill writing the marker; a stale one (crashed session)
    // is ignored here and cleared at the next Prime.
    if (!readOk) return log("warn", "relaunch-request unreadable — ignored")
    if (freshMs > 5 * 60 * 1000) return log("info", "ignored stale relaunch-request")
    if (!prompt) return log("warn", "relaunch-request not the canonical drain shape — refused")
    if (!gitClean()) return log("warn", "relaunch-request skipped — working tree not clean")
    let newID = null
    try {
      const created = await client.session.create({ body: { title: "autoloop relaunch" }, query: { directory: root } })
      newID = created?.data?.id ?? created?.id
      if (!newID) return log("warn", "relaunch-request: session.create returned no id")
      await client.session.promptAsync({
        path: { id: newID },
        query: { directory: root },
        body: { parts: [{ type: "text", text: prompt }] },
      })
      return log("info", `relaunched drain as ${newID}`)
    } catch (e) {
      // Don't leave an empty "autoloop relaunch" session behind if the prompt never landed.
      if (newID) await client.session.delete?.({ path: { id: newID } }).catch(() => {})
      return log("warn", `relaunch failed: ${e.message}`)
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const guard = tool("command-guard.mjs")
      if (!existsSync(guard)) {
        throw new Error(
          `autoloop: command guard ${guard} not found — refusing commands until opencode runs from the repo root (re-run autoloop setup?)`,
        )
      }
      const res = runNode(guard, { tool_input: { command: output.args?.command } })
      if (res.status === 2) throw new Error(res.stderr || "blocked by autoloop command guard")
      if (res.error || res.status !== 0) {
        throw new Error(
          `autoloop: command guard failed to run (${res.error?.message ?? `exit ${res.status}`}) — failing closed`,
        )
      }
      rememberCommand(input.callID, output.args?.command)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      try {
        const command = pendingCommands.get(input.callID)
        pendingCommands.delete(input.callID)
        if (!command) return
        const reminder = tool("label-swap-reminder.mjs")
        if (!existsSync(reminder)) return
        const res = runNode(reminder, { tool_name: "Bash", tool_input: { command } })
        if (res.status !== 0 || !res.stdout) return
        const msg = JSON.parse(res.stdout)?.hookSpecificOutput?.additionalContext
        if (msg) output.output = `${output.output}\n\n${msg}`
      } catch {
        /* reminder is best-effort — never break a tool result */
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        if (isEngineChild) return
        const info = event.properties?.info ?? event.properties ?? {}
        const sessionID = info.id ?? event.properties?.sessionID
        if (!sessionID || info.parentID) return // children skip the orchestrator preflight
        const preflight = tool("session-preflight.sh")
        if (!existsSync(preflight)) {
          await inject(sessionID, `autoloop: ${preflight} not found — this repo is not set up (autoloop setup) or opencode was launched outside the repo root`)
          return
        }
        const res = spawnSync("bash", [preflight], { encoding: "utf8", timeout: 45000, cwd: root })
        const report = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
        if (report) await inject(sessionID, `## autoloop preflight (auto-injected)\n\n${report}`)
        return
      }

      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      let session = null
      try {
        const got = await client.session.get({ path: { id: sessionID } })
        session = got?.data ?? got
      } catch {
        /* session may already be gone — nothing to do */
      }

      // A child going idle IS the SubagentStop: capture its own messages as evidence.
      if (session?.parentID) {
        try {
          const capture = tool("subagent-transcript.mjs")
          if (!existsSync(capture)) return
          const got = await client.session.messages({ path: { id: sessionID } })
          const messages = got?.data ?? got ?? []
          runNode(capture, {
            hook_event_name: "opencode.child.idle",
            sessionID,
            parentID: session.parentID,
            agent: session.agent ?? null,
            title: session.title ?? null,
            messages,
          })
        } catch {
          /* capture is best-effort — a child stop must never wedge the parent */
        }
        return
      }

      // Orchestrator session idle → write-back contract check (Stop-hook equivalent).
      if (isEngineChild) return
      const writeback = tool("writeback-check.mjs")
      if (!existsSync(writeback)) return
      const markerDir = join(root, ".git", "autoloop")
      const marker = join(markerDir, `nudge-${sessionID}`)
      const nudged = existsSync(marker)
      // Always run the REAL check (stop_hook_active stays false): the marker — not the wire
      // flag — is what suppresses repeat nudges, and only a genuine pass may remove it.
      const res = runNode(writeback, { stop_hook_active: false })
      if (res.status === 2) {
        if (nudged) return // one corrective turn per gap — never loop
        mkdirSync(markerDir, { recursive: true })
        writeFileSync(marker, new Date().toISOString())
        const text = res.stderr || "autoloop: write-back contract gap detected — record terminal state before stopping (writeback-check.mjs)"
        client.session
          .prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
          .catch(() => {})
        return
      }
      if (res.status !== 0) return // writeback errored — not a clean park; do not relaunch
      if (nudged) rmSync(marker, { force: true }) // gap closed — re-arm
      // Clean, terminal park → honor a pending auto-continue relaunch request (opencode only).
      await maybeRelaunch()
    },
  }
}
