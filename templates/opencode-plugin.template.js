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
//                                                    Git autoloop state is the stop_hook_active
//                                                    equivalent and is removed when the check
//                                                    passes again. Verified: server-backed
//                                                    sessions process the nudge; detached
//                                                    one-shot `opencode run` does not (engine
//                                                    children opt out via AUTOLOOP_ENGINE_CHILD).

// AUTOLOOP_ENGINE_CHILD=1 (set by the Claude host on every `opencode run` engine dispatch)
// skips the orchestrator-only hooks (preflight injection, writeback nudge) so engine children
// never accrete injected context in their transcripts. Command guarding stays on for children.
//
// Runs under Bun (opencode's plugin runtime) but shells out to `node` for the vendored tools so
// exactly one copy of each guard exists per repo, with its own --self-test.

import { spawnSync } from "node:child_process"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

const MAX_PLUGIN_INPUT_BYTES = 1024 * 1024

// The reviewer profile is repository content, so it is read without following
// links and with a hard size bound before any of it is trusted.
function boundedRegularText(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size > MAX_PLUGIN_INPUT_BYTES) {
      throw new Error("expected a bounded regular file")
    }
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}

const TRANSCRIPT_IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/
const REVIEWER_TOOLS = ["glob", "grep", "list", "read"]
const REVIEWER_FRONTMATTER = [
  "---",
  "description: Read-only independent reviewer for Autoloop plan and code review rounds.",
  "mode: all",
  "permission:",
  '  "*": deny',
  "  read: allow",
  "  glob: allow",
  "  grep: allow",
  "  list: allow",
  "---",
].join("\n")

function consistentChildAgent(messages) {
  if (!Array.isArray(messages)) return null
  const agents = messages
    .filter((message) => message?.info?.role === "user")
    .map((message) => message.info.agent)
  const agent = agents[0]
  if (
    typeof agent !== "string"
    || !TRANSCRIPT_IDENTITY_PATTERN.test(agent)
    || agents.some((candidate) => candidate !== agent)
  ) {
    return null
  }
  return agent
}

function consistentModelIdentity(messages) {
  if (!Array.isArray(messages)) return null
  const models = messages
    .filter((message) => message?.info?.role === "assistant")
    .map((message) => ({
      providerID: message.info.providerID,
      modelID: message.info.modelID,
    }))
  const model = models[0]
  if (
    model === undefined
    || typeof model.providerID !== "string"
    || typeof model.modelID !== "string"
    || models.some((candidate) =>
      candidate.providerID !== model.providerID
      || candidate.modelID !== model.modelID)
  ) {
    return null
  }
  const identity = `${model.providerID}/${model.modelID}`
  return TRANSCRIPT_IDENTITY_PATTERN.test(identity) ? identity : null
}

function trustedReviewerMetadata(root, agent) {
  if (agent !== "autoloop-reviewer") return null
  const path = join(root, ".opencode", "agent", "autoloop-reviewer.md")
  try {
    const content = boundedRegularText(path)
    if (!content.startsWith(`${REVIEWER_FRONTMATTER}\n`)) return null
    return { tools: [...REVIEWER_TOOLS] }
  } catch {
    return null
  }
}

export const Autoloop = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const tool = (name) => join(root, "tools/agentic", name)
  const isEngineChild = process.env.AUTOLOOP_ENGINE_CHILD === "1"
  const gitEnv = () => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_")) delete env[key]
    }
    return {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    }
  }

  const runNode = (script, stdinPayload, args = []) =>
    spawnSync("node", [script, ...args], {
      input: JSON.stringify(stdinPayload),
      encoding: "utf8",
      timeout: 45000,
      cwd: root,
    })

  const autoloopGitDir = () => {
    const result = spawnSync(
      "git",
      [
        "--no-replace-objects",
        "--no-optional-locks",
        "-C",
        root,
        "rev-parse",
        "--git-path",
        "autoloop",
      ],
      { encoding: "utf8", timeout: 10000, env: gitEnv() },
    )
    const path = result.status === 0 ? (result.stdout ?? "").trim() : ""
    if (!path) return null
    return isAbsolute(path) ? path : resolve(root, path)
  }

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
      return true
    } catch (e) {
      await client.app.log({ body: { service: "autoloop", level: "warn", message: `context injection failed: ${e.message}` } }).catch(() => {})
      return false
    }
  }

  const log = (level, message) =>
    client.app.log({ body: { service: "autoloop", level, message } }).catch(() => {})

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const guard = tool("command-guard.mjs")
      if (!existsSync(guard)) {
        throw new Error(
          `autoloop: command guard ${guard} not found — failing closed; refusing commands until opencode runs from the repo root (re-run autoloop setup?)`,
        )
      }
      const res = runNode(
        guard,
        { tool_input: { command: output.args?.command } },
        ["--config", join(root, "docs", "agentic", "STATE.md")],
      )
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
          const agent = consistentChildAgent(messages)
          const modelIdentity = consistentModelIdentity(messages)
          const metadata = trustedReviewerMetadata(root, agent)
          runNode(capture, {
            hook_event_name: "opencode.child.idle",
            sessionID,
            parentID: session.parentID,
            agent,
            title: session.title ?? null,
            ...(modelIdentity ? { modelIdentity } : {}),
            ...(metadata ? { metadata } : {}),
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
      const markerDir = autoloopGitDir()
      if (!markerDir) return log("warn", "writeback marker path unavailable")
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
      if (res.status !== 0) return
      if (nudged) rmSync(marker, { force: true }) // gap closed — re-arm
    },
  }
}
