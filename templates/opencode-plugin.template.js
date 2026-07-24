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
//   session.idle (own session) → relaunch-request    Auto-continue: after a CLEAN park (writeback
//                                                    passed), if the dev skill left a fresh
//                                                    relaunch-request marker and the tree is
//                                                    clean, spawn a FRESH session to take the next
//                                                    unit — draining the queue across the context
//                                                    boundary. Policy-free: the skill decides
//                                                    whether to write the request (opt-in, progress
//                                                    gate, generation cap); the plugin only executes
//                                                    it. Durable CAS recovery. Server-backed only — a
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
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

export const Autoloop = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const tool = (name) => join(root, "tools/agentic", name)
  const isEngineChild = process.env.AUTOLOOP_ENGINE_CHILD === "1"
  const relaunchOwnerNonce = randomUUID()
  const textFingerprint = (value) =>
    createHash("sha256").update(value).digest("hex")
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

  // Clean tree = no uncommitted changes. The dev skill parks on the base branch with a clean tree;
  // a fresh session must never be spawned onto an in-progress unit.
  const gitClean = () => {
    const res = spawnSync("git", [
      "--no-replace-objects",
      "--no-optional-locks",
      "-C",
      root,
      "status",
      "--porcelain",
    ], { encoding: "utf8", timeout: 10000, env: gitEnv() })
    return res.status === 0 && (res.stdout ?? "").trim() === ""
  }

  const storeResult = (store, args, input = {}) => {
    const result = runNode(store, input, args)
    if (result.status !== 0 || result.error) {
      throw new Error(
        result.stderr
        || result.error?.message
        || `continuation store exited ${result.status}`,
      )
    }
    const parsed = JSON.parse(result.stdout)
    if (parsed?.ok !== true) {
      throw new Error(parsed?.error || "continuation store rejected the operation")
    }
    return parsed.value
  }

  const sessionList = async () => {
    const listed = await client.session.list({ query: { directory: root } })
    const value = listed?.data ?? listed ?? []
    return Array.isArray(value) ? value : value.items ?? []
  }

  const messageContains = async (sessionID, text) => {
    const got = await client.session.messages({ path: { id: sessionID } })
    const value = got?.data ?? got ?? []
    const messages = Array.isArray(value) ? value : value.items ?? []
    return messages.some((message) => {
      const parts = message?.parts ?? message?.message?.parts ?? []
      return parts.some((part) => part?.type === "text" && part.text === text)
    })
  }

  const boundedProviderCall = async (operation) => {
    let timer
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("provider operation exceeded 60 seconds")),
            60_000,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // The vendored store keeps an append-only issued → claimed → session-created → opened →
  // prompted CAS. One-shot effect intents precede provider mutations; recovery reconciles the
  // lease-named session and exact messages without repeating an unresolved mutation.
  let relaunchInFlight = false

  const maybeRelaunchOwned = async (ownerSessionID) => {
    const markerDir = autoloopGitDir()
    if (!markerDir) return log("warn", "relaunch-request skipped — Git state path unavailable")
    const reqPath = join(markerDir, "relaunch-request")
    if (!existsSync(reqPath)) return
    if (!gitClean()) return log("warn", "relaunch-request skipped — working tree not clean")

    const store = tool("continuation-store.mjs")
    if (!existsSync(store)) {
      return log("warn", "relaunch-request refused — continuation store missing")
    }
    let claim
    try {
      claim = storeResult(
        store,
        ["--claim"],
        { ownerId: `${ownerSessionID}:${relaunchOwnerNonce}` },
      )
    } catch (e) {
      return log("warn", `relaunch-request lease rejected: ${e.message}`)
    }

    const leaseFingerprint = claim.request?.lease?.fingerprint
    const claimFingerprint = claim.state?.claimFingerprint
    let ownerFingerprint = claim.ownerFingerprint
    if (typeof leaseFingerprint !== "string") {
      return log("warn", "relaunch-request claim has no lease fingerprint")
    }
    if (typeof claimFingerprint !== "string") {
      return log("warn", "relaunch-request claim has no owner fingerprint")
    }
    if (typeof ownerFingerprint !== "string") {
      return log("warn", "relaunch-request claim has no owner lease")
    }
    const renewOwner = () => {
      const renewed = storeResult(store, ["--renew"], {
        leaseFingerprint,
        ownerFingerprint,
      })
      ownerFingerprint = renewed.ownerFingerprint
      return renewed
    }
    const issueEffect = (effect, expectedStatus, subject) => {
      renewOwner()
      return storeResult(store, ["--issue-effect"], {
        leaseFingerprint,
        claimFingerprint,
        ownerFingerprint,
        expectedStatus,
        effect,
        subjectFingerprint: textFingerprint(subject),
      })
    }
    const title = `autoloop relaunch ${leaseFingerprint.slice(0, 16)}`
    let newID = claim.session?.sessionId ?? null
    try {
      if (newID) {
        const got = await boundedProviderCall(
          client.session.get({ path: { id: newID } }),
        )
        const bound = got?.data ?? got
        if (!bound) {
          throw new Error(
            "UNKNOWN_PROVIDER_EFFECT: lease-bound session is missing; human reconciliation is required",
          )
        }
        const boundTitle = bound.title ?? bound.info?.title
        if (boundTitle !== title) {
          throw new Error("the lease-bound session title does not match")
        }
      } else {
        const effect = issueEffect("session-create", "claimed", title)
        const sessions = await boundedProviderCall(sessionList())
        const matching = sessions.filter((session) =>
          (session?.title ?? session?.info?.title) === title)
        if (matching.length > 1) {
          throw new Error("multiple sessions match the continuation lease")
        }
        if (matching.length === 1) {
          if (effect.created) {
            throw new Error(
              "UNKNOWN_PROVIDER_EFFECT: a session predated its one-shot intent",
            )
          }
          newID = matching[0]?.id ?? matching[0]?.info?.id
        } else if (!effect.created) {
          throw new Error(
            "UNKNOWN_PROVIDER_EFFECT: session creation may still complete; automatic retry refused",
          )
        } else {
          renewOwner()
          const created = await boundedProviderCall(client.session.create({
            body: { title },
            query: { directory: root },
          }))
          newID = created?.data?.id ?? created?.id
        }
      }
      if (!newID) throw new Error("session.create returned no id")

      if (claim.state.status === "claimed") {
        const created = storeResult(store, ["--transition"], {
          leaseFingerprint,
          claimFingerprint,
          ownerFingerprint,
          expectedStatus: "claimed",
          nextStatus: "session-created",
          activeHost: "opencode",
          integration: "opencode-plugin",
          sessionId: newID,
        })
        claim = { ...claim, ...created }
      }

      const opened = storeResult(store, ["--transition"], {
        leaseFingerprint,
        claimFingerprint,
        ownerFingerprint,
        expectedStatus: "session-created",
        nextStatus: "opened",
      })
      const continuationContext = {
        continuation: opened.continuation,
        hostAttestationRequest: {
          integration: opened.session?.integration,
          sessionId: opened.session?.sessionId,
          observedSurface: { tool: "task" },
          expectedHost: "opencode",
        },
      }
      const context =
        "## autoloop continuation (validated and session-bound)\n\n"
        + JSON.stringify(continuationContext)
      const contextIntent = issueEffect("context-inject", "opened", context)
      const hasContext = await boundedProviderCall(
        messageContains(newID, context),
      )
      if (hasContext && contextIntent.created) {
        throw new Error(
          "UNKNOWN_PROVIDER_EFFECT: continuation context predated its one-shot intent",
        )
      }
      if (!hasContext) {
        if (!contextIntent.created) {
          throw new Error(
            "UNKNOWN_PROVIDER_EFFECT: context injection may still complete; automatic retry refused",
          )
        }
        renewOwner()
        const injected = await boundedProviderCall(inject(newID, context))
        if (!injected) {
          throw new Error(
            "UNKNOWN_PROVIDER_EFFECT: continuation context injection is unresolved",
          )
        }
      }

      const prompt = opened.request?.prompt
      if (typeof prompt !== "string") {
        throw new Error("opened continuation has no canonical prompt")
      }
      const promptIntent = issueEffect("prompt", "opened", prompt)
      const hasPrompt = await boundedProviderCall(
        messageContains(newID, prompt),
      )
      if (hasPrompt && promptIntent.created) {
        throw new Error(
          "UNKNOWN_PROVIDER_EFFECT: relaunch prompt predated its one-shot intent",
        )
      }
      if (!hasPrompt) {
        if (!promptIntent.created) {
          throw new Error(
            "UNKNOWN_PROVIDER_EFFECT: relaunch prompt may still complete; automatic retry refused",
          )
        }
        renewOwner()
        await boundedProviderCall(client.session.promptAsync({
          path: { id: newID },
          query: { directory: root },
          body: { parts: [{ type: "text", text: prompt }] },
        }))
      }
      renewOwner()
      storeResult(store, ["--transition"], {
        leaseFingerprint,
        claimFingerprint,
        ownerFingerprint,
        expectedStatus: "opened",
        nextStatus: "prompted",
      })
      return log("info", `relaunched drain as ${newID}`)
    } catch (e) {
      return log(
        "warn",
        `relaunch paused at a durable recovery point: ${e.message}`,
      )
    }
  }

  const maybeRelaunch = async (ownerSessionID) => {
    if (relaunchInFlight) return
    relaunchInFlight = true
    try {
      await maybeRelaunchOwned(ownerSessionID)
    } finally {
      relaunchInFlight = false
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
      if (res.status !== 0) return // writeback errored — not a clean park; do not relaunch
      if (nudged) rmSync(marker, { force: true }) // gap closed — re-arm
      // Clean, terminal park → honor a pending auto-continue relaunch request (opencode only).
      await maybeRelaunch(sessionID)
    },
  }
}
