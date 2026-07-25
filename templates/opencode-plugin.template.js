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
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

const SMOKE_PROTOCOL = "authenticated-continuation-crash-v1"
const SMOKE_BOUNDARIES = new Set([
  "request-issued",
  "session-created",
  "context-injected",
])
const SMOKE_TOKEN_PATTERN = /^[a-f0-9]{64}$/
const SMOKE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const SMOKE_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const TRANSCRIPT_IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/
const MAX_PLUGIN_INPUT_BYTES = 1024 * 1024
const SMOKE_MARKER_KEYS = [
  "boundary",
  "continuationSessionId",
  "createdAt",
  "handlerSessionId",
  "kind",
  "leaseFingerprint",
  "operatorTokenFingerprint",
  "processId",
  "version",
]
const SMOKE_DIRECTIVE = [
  "## autoloop authenticated continuation smoke",
  "",
  "Run the requested queue invocation through the normal authenticated path.",
  "After exactly one unit reaches its normal delivered terminal state, if fresh",
  "queue evidence proves another eligible unit remains, finish with reason",
  "`context-budget`, the real delivered-unit count, and the real checkout.",
  "Pipe the complete finish result unchanged to `continuation-store.mjs --issue`.",
  "Do not create, edit, copy, restore, or reseal relaunch or continuation files.",
  "Stop the initiating turn after the issue command returns.",
].join("\n")
const SMOKE_CRASH_CODE = "AUTOLOOP_SMOKE_HANDLER_CRASH"
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

const isSmokeFingerprint = (value) =>
  typeof value === "string" && SMOKE_FINGERPRINT_PATTERN.test(value)

const isSmokeSession = (value) =>
  typeof value === "string" && SMOKE_SESSION_PATTERN.test(value)

function boundedRegularText(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size > MAX_PLUGIN_INPUT_BYTES) {
      throw new Error("plugin input is not a bounded regular file")
    }
    return readFileSync(descriptor, "utf8")
  } finally {
    closeSync(descriptor)
  }
}

const isCanonicalTimestamp = (value) => {
  if (typeof value !== "string") return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function smokeCrashConfig(env) {
  const protocol = env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL
  const token = env.AUTOLOOP_SMOKE_OPERATOR_TOKEN
  if (protocol === undefined && token === undefined) {
    return { configured: false, status: "inert" }
  }
  if (
    protocol !== SMOKE_PROTOCOL
    || typeof token !== "string"
    || !SMOKE_TOKEN_PATTERN.test(token)
    || new Set(token).size < 8
  ) {
    return {
      configured: true,
      status: "unavailable",
      reason:
        "smoke continuation protocol requires its exact version and a varied 256-bit lowercase-hex operator token",
    }
  }
  return {
    configured: true,
    status: "available",
    tokenFingerprint: createHash("sha256").update(token).digest("hex"),
  }
}

function validSmokeMarker(marker, binding) {
  if (
    marker === null
    || typeof marker !== "object"
    || Array.isArray(marker)
    || Object.keys(marker).sort().join("\0") !== SMOKE_MARKER_KEYS.join("\0")
  ) {
    return false
  }
  return marker.kind === "autoloop-opencode-smoke-crash"
    && marker.version === 1
    && SMOKE_BOUNDARIES.has(marker.boundary)
    && isSmokeFingerprint(marker.leaseFingerprint)
    && (
      marker.continuationSessionId === null
      || isSmokeSession(marker.continuationSessionId)
    )
    && isSmokeSession(marker.handlerSessionId)
    && Number.isSafeInteger(marker.processId)
    && marker.processId > 0
    && isSmokeFingerprint(marker.operatorTokenFingerprint)
    && isCanonicalTimestamp(marker.createdAt)
    && (
      marker.boundary === "request-issued"
        ? marker.continuationSessionId === null
        : isSmokeSession(marker.continuationSessionId)
    )
    && marker.boundary === binding.boundary
    && marker.leaseFingerprint === binding.leaseFingerprint
    && marker.continuationSessionId === binding.continuationSessionId
    && marker.processId === binding.processId
    && marker.operatorTokenFingerprint === binding.operatorTokenFingerprint
}

function armSmokeCrash(
  config,
  boundary,
  {
    markerDirectory,
    leaseFingerprint,
    continuationSessionId,
    handlerSessionId,
    processId = process.pid,
    createdAt = new Date().toISOString(),
  },
) {
  if (config?.status !== "available") {
    return { status: "inert" }
  }
  if (
    !isSmokeFingerprint(config.tokenFingerprint)
    || typeof markerDirectory !== "string"
    || markerDirectory.length === 0
    || !isAbsolute(markerDirectory)
    || !SMOKE_BOUNDARIES.has(boundary)
    || !isSmokeFingerprint(leaseFingerprint)
    || (
      boundary === "request-issued"
        ? continuationSessionId !== null
        : !isSmokeSession(continuationSessionId)
    )
    || !isSmokeSession(handlerSessionId)
    || !Number.isSafeInteger(processId)
    || processId <= 0
    || !isCanonicalTimestamp(createdAt)
  ) {
    throw new Error("smoke crash attribution is invalid")
  }

  const directory = join(markerDirectory, "smoke-crashes")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("smoke crash marker path must be a real directory")
  }
  chmodSync(directory, 0o700)

  const path = join(directory, `${leaseFingerprint}-${boundary}.json`)
  const binding = {
    boundary,
    leaseFingerprint,
    continuationSessionId,
    processId,
    operatorTokenFingerprint: config.tokenFingerprint,
  }
  const readExisting = () => {
    const markerStat = lstatSync(path)
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("smoke crash marker conflicts with this operator or continuation")
    }
    let marker
    try {
      marker = JSON.parse(boundedRegularText(path))
    } catch {
      throw new Error("smoke crash marker conflicts with this operator or continuation")
    }
    if (!validSmokeMarker(marker, binding)) {
      throw new Error("smoke crash marker conflicts with this operator or continuation")
    }
    return { status: "consumed", path }
  }
  if (existsSync(path)) return readExisting()

  const marker = {
    kind: "autoloop-opencode-smoke-crash",
    version: 1,
    boundary,
    leaseFingerprint,
    continuationSessionId,
    handlerSessionId,
    processId,
    operatorTokenFingerprint: config.tokenFingerprint,
    createdAt,
  }
  try {
    writeFileSync(path, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    if (error?.code === "EEXIST") return readExisting()
    throw error
  }
  return { status: "armed", path }
}

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

const configuredSmokeCrash = smokeCrashConfig(process.env)
delete process.env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL
delete process.env.AUTOLOOP_SMOKE_OPERATOR_TOKEN

export const Autoloop = async ({ client, directory, worktree }) => {
  const root = worktree || directory
  const tool = (name) => join(root, "tools/agentic", name)
  const isEngineChild = process.env.AUTOLOOP_ENGINE_CHILD === "1"
  const smokeCrash = configuredSmokeCrash
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
  const pendingIntentCommands = new Set()
  const rememberCommand = (callID, command) => {
    if (pendingCommands.size > 100) pendingCommands.clear() // dropped afters must not leak
    if (callID) pendingCommands.set(callID, command)
  }
  const rememberIntentCommand = (sessionID) => {
    if (pendingIntentCommands.size > 100) pendingIntentCommands.clear()
    pendingIntentCommands.add(sessionID)
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

  let smokeProtocolStatus = smokeCrash.status
  let smokeStatusLogged = false
  const smokeStatusMessage = (status, details = {}) => JSON.stringify({
    kind: "autoloop-opencode-continuation-smoke",
    version: 1,
    status,
    processId: process.pid,
    ...details,
  })
  const smokeUnavailable = async (reason) => {
    smokeProtocolStatus = "unavailable"
    if (smokeStatusLogged) return
    smokeStatusLogged = true
    await log("warn", smokeStatusMessage("unavailable", { reason }))
  }
  const armSmokeProtocol = async (sessionID) => {
    if (smokeProtocolStatus === "inert" || smokeProtocolStatus === "armed") {
      return
    }
    if (smokeProtocolStatus === "unavailable") {
      await smokeUnavailable(smokeCrash.reason)
      return
    }
    const markerDirectory = autoloopGitDir()
    if (!markerDirectory) {
      await smokeUnavailable("git-state-path-unavailable")
      return
    }
    if (existsSync(join(markerDirectory, "relaunch-request"))) {
      await smokeUnavailable("preexisting-relaunch-request")
      return
    }
    if (!await inject(sessionID, SMOKE_DIRECTIVE)) {
      await smokeUnavailable("directive-injection-failed")
      return
    }
    smokeProtocolStatus = "armed"
    smokeStatusLogged = true
    await log("warn", smokeStatusMessage("armed", {
      sessionId: sessionID,
      operatorTokenFingerprint: smokeCrash.tokenFingerprint,
    }))
  }
  const crashForSmoke = async (boundary, facts) => {
    if (smokeProtocolStatus !== "armed") return
    const result = armSmokeCrash(smokeCrash, boundary, facts)
    if (result.status !== "armed") return
    await log(
      "warn",
      smokeStatusMessage("handler-crashed", {
        boundary,
        leaseFingerprint: facts.leaseFingerprint,
        handlerSessionId: facts.handlerSessionId,
        continuationSessionId: facts.continuationSessionId,
        marker: result.path,
      }),
    )
    const error = new Error(
      `autoloop smoke simulated continuation handler crash at ${boundary}`,
    )
    error.code = SMOKE_CRASH_CODE
    throw error
  }
  const pendingLeaseFingerprint = (markerDirectory) => {
    const path = join(markerDirectory, "relaunch-request")
    try {
      const stats = lstatSync(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return null
      const pointer = JSON.parse(boundedRegularText(path))
      if (
        pointer === null
        || typeof pointer !== "object"
        || Array.isArray(pointer)
        || Object.keys(pointer).sort().join("\0")
          !== ["leaseFingerprint", "pointerNonce", "version"].join("\0")
        || pointer.version !== 1
        || !isSmokeFingerprint(pointer.leaseFingerprint)
        || !isSmokeSession(pointer.pointerNonce)
      ) {
        return null
      }
      return pointer.leaseFingerprint
    } catch {
      return null
    }
  }

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
  // prompted CAS. One-shot effect intents precede provider mutations; prompt preparation lets the
  // exact target open while promptAsync is in flight, and recovery reconciles exact messages.
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
    const pendingLease = pendingLeaseFingerprint(markerDir)
    if (pendingLease) {
      await crashForSmoke("request-issued", {
        markerDirectory: markerDir,
        leaseFingerprint: pendingLease,
        continuationSessionId: null,
        handlerSessionId: ownerSessionID,
      })
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
          integration: "opencode.user-prompt-hook",
          sessionId: newID,
        })
        claim = { ...claim, ...created }
      }

      await crashForSmoke("session-created", {
        markerDirectory: markerDir,
        leaseFingerprint,
        continuationSessionId: newID,
        handlerSessionId: ownerSessionID,
      })

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
          sessionId: opened.session?.sessionId,
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

      await crashForSmoke("context-injected", {
        markerDirectory: markerDir,
        leaseFingerprint,
        continuationSessionId: newID,
        handlerSessionId: ownerSessionID,
      })

      const prompt = opened.request?.prompt
      if (typeof prompt !== "string") {
        throw new Error("opened continuation has no canonical prompt")
      }
      const promptIntent = issueEffect("prompt", "opened", prompt)
      storeResult(store, ["--prepare-prompt"], {
        leaseFingerprint,
        claimFingerprint,
        ownerFingerprint,
        continuation: opened.continuation,
      })
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
      if (e?.code === SMOKE_CRASH_CODE) throw e
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
    "command.execute.before": async (input) => {
      if (isEngineChild) return
      const capture = tool("intent-contract.mjs")
      if (!existsSync(capture)) {
        throw new Error(
          `autoloop: intent capture ${capture} not found — refusing unattested commands until setup is rerun`,
        )
      }
      const result = runNode(capture, {
        hook_event_name: "opencode.command",
        session_id: input.sessionID,
        cwd: root,
        command: input.command,
        arguments: input.arguments,
      }, ["--capture-hook-json"])
      if (result.error || result.status !== 0) {
        throw new Error(
          result.stderr
          || result.error?.message
          || "autoloop host command intent capture failed",
        )
      }
      let outcome
      try {
        outcome = JSON.parse(result.stdout)
      } catch {
        throw new Error("autoloop host command intent capture returned invalid evidence")
      }
      if (
        outcome?.captured === true
        || outcome?.reason === "already-sealed"
        || outcome?.reason === "non-runtime-autoloop-command"
      ) {
        rememberIntentCommand(input.sessionID)
      }
    },

    "chat.message": async (input, output) => {
      if (isEngineChild) return
      const sessionID = input.sessionID
      const messageID = output.message?.id ?? output.message?.messageID
      const prompt = (output.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
      if (!prompt) return
      if (!sessionID || !messageID) {
        throw new Error(
          "autoloop: opencode prompt attribution is unavailable — refusing an unattested prompt",
        )
      }
      if (pendingIntentCommands.delete(sessionID)) return
      const capture = tool("intent-contract.mjs")
      if (!existsSync(capture)) {
        throw new Error(
          `autoloop: intent capture ${capture} not found — refusing unattested prompts until setup is rerun`,
        )
      }
      const result = runNode(capture, {
        hook_event_name: "opencode.user-prompt",
        session_id: sessionID,
        turn_id: messageID,
        cwd: root,
        prompt,
      }, ["--capture-hook"])
      if (result.error || result.status !== 0) {
        throw new Error(
          result.stderr
          || result.error?.message
          || "autoloop host intent capture failed",
        )
      }
    },

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
        await armSmokeProtocol(sessionID)
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
      if (res.status !== 0) return // writeback errored — not a clean park; do not relaunch
      if (nudged) rmSync(marker, { force: true }) // gap closed — re-arm
      // Clean, terminal park → honor a pending auto-continue relaunch request (opencode only).
      await maybeRelaunch(sessionID)
    },
  }
}
