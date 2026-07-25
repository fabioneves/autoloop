#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const templatePath = fileURLToPath(
  new URL("./opencode-plugin.template.js", import.meta.url),
)
const source = readFileSync(templatePath, "utf8")
const reviewerProfile = readFileSync(
  fileURLToPath(
    new URL("./opencode-reviewer-agent.template.md", import.meta.url),
  ),
  "utf8",
)
const token = "0123456789abcdef".repeat(4)
const priorProtocol = process.env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL
const priorToken = process.env.AUTOLOOP_SMOKE_OPERATOR_TOKEN
process.env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL =
  "authenticated-continuation-crash-v1"
process.env.AUTOLOOP_SMOKE_OPERATOR_TOKEN = token
const instrumented = `${source}
export { armSmokeCrash, configuredSmokeCrash, smokeCrashConfig }
`
const plugin = await import(
  `data:text/javascript;base64,${Buffer.from(instrumented).toString("base64")}`
)
assert.equal(process.env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL, undefined)
assert.equal(process.env.AUTOLOOP_SMOKE_OPERATOR_TOKEN, undefined)
if (priorProtocol !== undefined) {
  process.env.AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL = priorProtocol
}
if (priorToken !== undefined) process.env.AUTOLOOP_SMOKE_OPERATOR_TOKEN = priorToken
assert.equal(plugin.configuredSmokeCrash.status, "available")
assert.equal("token" in plugin.configuredSmokeCrash, false)

const otherToken = "fedcba9876543210".repeat(4)
const leaseFingerprint = "a".repeat(64)
const sessionId = "ses_target"
const ownerSessionId = "ses_owner"

const absent = plugin.smokeCrashConfig({})
assert.deepEqual(absent, { configured: false, status: "inert" })

for (const env of [
  {
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
      "authenticated-continuation-crash-v1",
  },
  { AUTOLOOP_SMOKE_OPERATOR_TOKEN: token },
  {
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL: "unknown",
    AUTOLOOP_SMOKE_OPERATOR_TOKEN: token,
  },
  {
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
      "authenticated-continuation-crash-v1",
    AUTOLOOP_SMOKE_OPERATOR_TOKEN: "a".repeat(64),
  },
  {
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
      "authenticated-continuation-crash-v1",
    AUTOLOOP_SMOKE_OPERATOR_TOKEN: token.toUpperCase(),
  },
  {
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
      "authenticated-continuation-crash-v1",
    AUTOLOOP_SMOKE_OPERATOR_TOKEN: token.slice(1),
  },
]) {
  const invalid = plugin.smokeCrashConfig(env)
  assert.equal(invalid.configured, true)
  assert.equal(invalid.status, "unavailable")
  assert.match(invalid.reason, /smoke continuation protocol/u)
}

const config = plugin.smokeCrashConfig({
  AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
    "authenticated-continuation-crash-v1",
  AUTOLOOP_SMOKE_OPERATOR_TOKEN: token,
})
assert.equal(config.status, "available")
assert.match(config.tokenFingerprint, /^[a-f0-9]{64}$/u)
assert.notEqual(config.tokenFingerprint, token)
assert.equal("token" in config, false)

const requestPath = source.indexOf('join(markerDir, "relaunch-request")')
const requestCrash = source.indexOf('await crashForSmoke("request-issued"')
const claim = source.indexOf('claim = storeResult(')
assert(requestPath < requestCrash && requestCrash < claim)
const sessionTransition = source.indexOf('nextStatus: "session-created"')
const sessionCrash = source.indexOf('await crashForSmoke("session-created"')
const openedTransition = source.indexOf('nextStatus: "opened"')
assert(sessionTransition < sessionCrash && sessionCrash < openedTransition)
assert.match(
  source,
  /integration: "opencode\.user-prompt-hook"/u,
)
assert.equal(source.includes('integration: "opencode-plugin"'), false)
assert.match(
  source,
  /hostAttestationRequest: \{\s*sessionId: opened\.session\?\.sessionId,\s*\}/u,
)
const contextIntent = source.indexOf('issueEffect("context-inject"')
const contextCheck = source.indexOf("const hasContext =")
const contextInjection = source.indexOf(
  "const injected = await boundedProviderCall",
)
const contextCrash = source.indexOf('await crashForSmoke("context-injected"')
const promptRead = source.indexOf("const prompt = opened.request?.prompt")
const promptIntent = source.indexOf('issueEffect("prompt"')
const promptPreparation = source.indexOf('["--prepare-prompt"]')
const promptDispatch = source.indexOf("await boundedProviderCall(client.session.promptAsync")
const promptedTransition = source.indexOf('nextStatus: "prompted"')
assert(
  contextIntent < contextCheck
  && contextCheck < contextInjection
  && contextInjection < contextCrash
  && contextCrash < promptRead
  && promptRead < promptIntent
  && promptIntent < promptPreparation
  && promptPreparation < promptDispatch
  && promptDispatch < promptedTransition,
)
assert.equal(source.includes("await new Promise(() => undefined)"), false)

const markerDirectory = mkdtempSync(join(tmpdir(), "autoloop-smoke-crash-"))
try {
  const inert = plugin.armSmokeCrash(absent, "context-injected", {
    markerDirectory,
    leaseFingerprint,
    continuationSessionId: sessionId,
    handlerSessionId: ownerSessionId,
    processId: 4242,
    createdAt: "2026-07-25T00:00:00.000Z",
  })
  assert.deepEqual(inert, { status: "inert" })
  assert.equal(existsSync(join(markerDirectory, "smoke-crashes")), false)

  const issued = plugin.armSmokeCrash(config, "request-issued", {
    markerDirectory,
    leaseFingerprint,
    continuationSessionId: null,
    handlerSessionId: ownerSessionId,
    processId: 4242,
    createdAt: "2026-07-25T00:00:00.000Z",
  })
  assert.equal(issued.status, "armed")
  assert.equal(
    issued.path,
    join(
      markerDirectory,
      "smoke-crashes",
      `${leaseFingerprint}-request-issued.json`,
    ),
  )
  assert.equal(lstatSync(join(markerDirectory, "smoke-crashes")).mode & 0o777, 0o700)
  assert.equal(lstatSync(issued.path).mode & 0o777, 0o600)

  const markerText = readFileSync(issued.path, "utf8")
  assert.equal(markerText.includes(token), false)
  assert.deepEqual(JSON.parse(markerText), {
    kind: "autoloop-opencode-smoke-crash",
    version: 1,
    boundary: "request-issued",
    leaseFingerprint,
    continuationSessionId: null,
    handlerSessionId: ownerSessionId,
    processId: 4242,
    operatorTokenFingerprint: config.tokenFingerprint,
    createdAt: "2026-07-25T00:00:00.000Z",
  })

  const consumed = plugin.armSmokeCrash(
    config,
    "request-issued",
    {
      markerDirectory,
      leaseFingerprint,
      continuationSessionId: null,
      handlerSessionId: "ses_recovery",
      processId: 4242,
      createdAt: "2026-07-25T00:05:01.000Z",
    },
  )
  assert.equal(consumed.status, "consumed")
  assert.equal(consumed.path, issued.path)

  const sessionArmed = plugin.armSmokeCrash(
    config,
    "session-created",
    {
      markerDirectory,
      leaseFingerprint,
      continuationSessionId: sessionId,
      handlerSessionId: ownerSessionId,
      processId: 4242,
      createdAt: "2026-07-25T00:00:02.000Z",
    },
  )
  assert.equal(sessionArmed.status, "armed")
  assert.equal(
    JSON.parse(readFileSync(sessionArmed.path, "utf8")).boundary,
    "session-created",
  )

  const contextArmed = plugin.armSmokeCrash(
    config,
    "context-injected",
    {
      markerDirectory,
      leaseFingerprint,
      continuationSessionId: sessionId,
      handlerSessionId: "ses_context",
      processId: 4242,
      createdAt: "2026-07-25T00:05:03.000Z",
    },
  )
  assert.equal(contextArmed.status, "armed")

  const conflicting = plugin.smokeCrashConfig({
    AUTOLOOP_SMOKE_CONTINUATION_PROTOCOL:
      "authenticated-continuation-crash-v1",
    AUTOLOOP_SMOKE_OPERATOR_TOKEN: otherToken,
  })
  assert.throws(
    () => plugin.armSmokeCrash(
      conflicting,
      "session-created",
      {
        markerDirectory,
        leaseFingerprint,
        continuationSessionId: sessionId,
        handlerSessionId: ownerSessionId,
        processId: 4242,
      },
    ),
    /marker conflicts/u,
  )
  assert.throws(
    () => plugin.armSmokeCrash(config, "request-issued", {
      markerDirectory,
      leaseFingerprint,
      continuationSessionId: null,
      handlerSessionId: "ses_other_server",
      processId: 5252,
    }),
    /marker conflicts/u,
  )
} finally {
  rmSync(markerDirectory, { recursive: true, force: true })
}

const symlinkMarkerDirectory = mkdtempSync(
  join(tmpdir(), "autoloop-smoke-crash-symlink-"),
)
const symlinkTarget = mkdtempSync(
  join(tmpdir(), "autoloop-smoke-crash-target-"),
)
try {
  mkdirSync(join(symlinkMarkerDirectory, "parent"))
  symlinkSync(
    symlinkTarget,
    join(symlinkMarkerDirectory, "parent", "smoke-crashes"),
  )
  assert.throws(
    () => plugin.armSmokeCrash(config, "session-created", {
      markerDirectory: join(symlinkMarkerDirectory, "parent"),
      leaseFingerprint,
      continuationSessionId: sessionId,
      handlerSessionId: ownerSessionId,
    }),
    /real directory/u,
  )
} finally {
  rmSync(symlinkMarkerDirectory, { recursive: true, force: true })
  rmSync(symlinkTarget, { recursive: true, force: true })
}

const entrypointRoot = mkdtempSync(join(tmpdir(), "autoloop-opencode-entrypoint-"))
try {
  const toolDirectory = join(entrypointRoot, "tools", "agentic")
  mkdirSync(toolDirectory, { recursive: true })
  writeFileSync(
    join(toolDirectory, "intent-contract.mjs"),
    [
      'import { appendFileSync, readFileSync } from "node:fs"',
      'const input = JSON.parse(readFileSync(0, "utf8"))',
      'appendFileSync(new URL("./captured.jsonl", import.meta.url), `${JSON.stringify(input)}\\n`)',
      'const outcome = input.command === "setup"',
      '  ? { captured: false, reason: "non-runtime-autoloop-command" }',
      '  : { captured: input.hook_event_name === "opencode.command", reason: null }',
      'process.stdout.write(`${JSON.stringify(outcome)}\\n`)',
    ].join("\n"),
  )
  const handlers = await plugin.Autoloop({
    client: { app: { log: async () => undefined } },
    directory: entrypointRoot,
  })
  assert.equal(typeof handlers["command.execute.before"], "function")
  await handlers["command.execute.before"]({
    command: "dev",
    sessionID: "ses_command",
    arguments: "take one issue with codex",
  }, { parts: [] })
  await handlers["chat.message"](
    { sessionID: "ses_command" },
    {
      message: { id: "msg_command" },
      parts: [{ type: "text", text: "expanded skill prompt" }],
    },
  )
  await handlers["command.execute.before"]({
    command: "setup",
    sessionID: "ses_setup",
    arguments: "reconfigure",
  }, { parts: [] })
  await handlers["chat.message"](
    { sessionID: "ses_setup" },
    {
      message: { id: "msg_setup" },
      parts: [{ type: "text", text: "expanded /autoloop:dev documentation" }],
    },
  )
  await handlers["chat.message"](
    { sessionID: "ses_direct" },
    {
      message: { id: "msg_direct" },
      parts: [{ type: "text", text: "pitcrew revise this pull request" }],
    },
  )
  const captured = readFileSync(
    join(toolDirectory, "captured.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(captured, [
    {
      hook_event_name: "opencode.command",
      session_id: "ses_command",
      cwd: entrypointRoot,
      command: "dev",
      arguments: "take one issue with codex",
    },
    {
      hook_event_name: "opencode.command",
      session_id: "ses_setup",
      cwd: entrypointRoot,
      command: "setup",
      arguments: "reconfigure",
    },
    {
      hook_event_name: "opencode.user-prompt",
      session_id: "ses_direct",
      turn_id: "msg_direct",
      cwd: entrypointRoot,
      prompt: "pitcrew revise this pull request",
    },
  ])
} finally {
  rmSync(entrypointRoot, { recursive: true, force: true })
}

const missingEntrypointRoot = mkdtempSync(
  join(tmpdir(), "autoloop-opencode-entrypoint-missing-"),
)
try {
  const handlers = await plugin.Autoloop({
    client: { app: { log: async () => undefined } },
    directory: missingEntrypointRoot,
  })
  await assert.rejects(
    handlers["command.execute.before"]({
      command: "dev",
      sessionID: "ses_missing",
      arguments: "",
    }, { parts: [] }),
    /intent capture .* not found/u,
  )
  await assert.rejects(
    handlers["chat.message"](
      { sessionID: "ses_missing" },
      {
        message: { id: "msg_missing" },
        parts: [{ type: "text", text: "dev" }],
      },
    ),
    /intent capture .* not found/u,
  )
} finally {
  rmSync(missingEntrypointRoot, { recursive: true, force: true })
}

const guardRoot = mkdtempSync(join(tmpdir(), "autoloop-opencode-guard-"))
try {
  const handlers = await plugin.Autoloop({
    client: { app: { log: async () => undefined } },
    directory: guardRoot,
  })
  await assert.rejects(
    handlers["tool.execute.before"](
      { tool: "bash", callID: "call_missing_guard" },
      { args: { command: "echo should-not-run" } },
    ),
    /failing closed/u,
  )
} finally {
  rmSync(guardRoot, { recursive: true, force: true })
}

const smokeDirectiveRoot = mkdtempSync(
  join(tmpdir(), "autoloop-opencode-smoke-directive-"),
)
try {
  execFileSync("git", ["init", "-q"], { cwd: smokeDirectiveRoot })
  const prompts = []
  const logs = []
  const handlers = await plugin.Autoloop({
    client: {
      app: {
        log: async ({ body }) => {
          logs.push(body.message)
        },
      },
      session: {
        prompt: async (input) => {
          prompts.push(input)
        },
      },
    },
    directory: smokeDirectiveRoot,
  })
  await handlers.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_smoke_origin" } },
    },
  })
  await handlers.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_smoke_driver" } },
    },
  })
  const smokePrompts = prompts.filter((entry) =>
    entry.body.parts.some(
      (part) =>
        part.text.startsWith("## autoloop authenticated continuation smoke"),
    ),
  )
  assert.equal(smokePrompts.length, 1)
  assert.equal(smokePrompts[0].path.id, "ses_smoke_origin")
  assert.equal(smokePrompts[0].body.parts[0].text.includes(token), false)
  assert(logs.some((message) =>
    message.includes('"status":"armed"')
    && message.includes('"sessionId":"ses_smoke_origin"')))
} finally {
  rmSync(smokeDirectiveRoot, { recursive: true, force: true })
}

const unavailableSmokeRoot = mkdtempSync(
  join(tmpdir(), "autoloop-opencode-smoke-unavailable-"),
)
try {
  execFileSync("git", ["init", "-q"], { cwd: unavailableSmokeRoot })
  const markerDirectory = join(unavailableSmokeRoot, ".git", "autoloop")
  mkdirSync(markerDirectory, { recursive: true })
  writeFileSync(join(markerDirectory, "relaunch-request"), "{}\n")
  const prompts = []
  const logs = []
  const handlers = await plugin.Autoloop({
    client: {
      app: {
        log: async ({ body }) => {
          logs.push(body.message)
        },
      },
      session: {
        prompt: async (input) => {
          prompts.push(input)
        },
      },
    },
    directory: unavailableSmokeRoot,
  })
  await handlers.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_smoke_unavailable" } },
    },
  })
  assert.equal(
    prompts.some((entry) =>
      entry.body.parts.some((part) =>
        part.text.startsWith("## autoloop authenticated continuation smoke"))),
    false,
  )
  assert(logs.some((message) =>
    message.includes('"status":"unavailable"')
    && message.includes('"reason":"preexisting-relaunch-request"')))
} finally {
  rmSync(unavailableSmokeRoot, { recursive: true, force: true })
}

const reviewerRoot = mkdtempSync(
  join(tmpdir(), "autoloop-opencode-reviewer-metadata-"),
)
try {
  const toolDirectory = join(reviewerRoot, "tools", "agentic")
  const agentDirectory = join(reviewerRoot, ".opencode", "agent")
  mkdirSync(toolDirectory, { recursive: true })
  mkdirSync(agentDirectory, { recursive: true })
  writeFileSync(
    join(agentDirectory, "autoloop-reviewer.md"),
    reviewerProfile,
  )
  writeFileSync(
    join(toolDirectory, "subagent-transcript.mjs"),
    [
      'import { appendFileSync, readFileSync } from "node:fs"',
      'const input = JSON.parse(readFileSync(0, "utf8"))',
      'appendFileSync(new URL("./payloads.jsonl", import.meta.url), `${JSON.stringify(input)}\\n`)',
    ].join("\n"),
  )
  const sessions = {
    ses_reviewer_valid: {
      id: "ses_reviewer_valid",
      projectID: "prj_fixture",
      directory: reviewerRoot,
      parentID: "ses_parent",
      title: "valid reviewer",
      version: "1.18.3",
      time: { created: 1, updated: 2 },
    },
    ses_reviewer_drifted: {
      id: "ses_reviewer_drifted",
      projectID: "prj_fixture",
      directory: reviewerRoot,
      parentID: "ses_parent",
      title: "drifted reviewer",
      version: "1.18.3",
      time: { created: 3, updated: 4 },
    },
    ses_reviewer_inconsistent: {
      id: "ses_reviewer_inconsistent",
      projectID: "prj_fixture",
      directory: reviewerRoot,
      parentID: "ses_parent",
      title: "inconsistent reviewer",
      version: "1.18.3",
      time: { created: 5, updated: 6 },
    },
    ses_reviewer_malformed: {
      id: "ses_reviewer_malformed",
      projectID: "prj_fixture",
      directory: reviewerRoot,
      parentID: "ses_parent",
      title: "malformed reviewer",
      version: "1.18.3",
      time: { created: 7, updated: 8 },
    },
  }
  const userMessage = (sessionID, id, agent) => ({
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 10 },
      agent,
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      },
    },
    parts: [],
  })
  const assistantMessage = (sessionID, id, parentID, modelID) => ({
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 11, completed: 12 },
      parentID,
      providerID: "anthropic",
      modelID,
      mode: "autoloop-reviewer",
      path: { cwd: reviewerRoot, root: reviewerRoot },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    },
    parts: [],
  })
  const messages = {
    ses_reviewer_valid: [
      userMessage(
        "ses_reviewer_valid",
        "msg_reviewer_valid_user",
        "autoloop-reviewer",
      ),
      assistantMessage(
        "ses_reviewer_valid",
        "msg_reviewer_valid_assistant",
        "msg_reviewer_valid_user",
        "claude-sonnet-4-5",
      ),
    ],
    ses_reviewer_drifted: [
      userMessage(
        "ses_reviewer_drifted",
        "msg_reviewer_drifted_user",
        "autoloop-reviewer",
      ),
      assistantMessage(
        "ses_reviewer_drifted",
        "msg_reviewer_drifted_assistant",
        "msg_reviewer_drifted_user",
        "claude-sonnet-4-5",
      ),
    ],
    ses_reviewer_inconsistent: [
      userMessage(
        "ses_reviewer_inconsistent",
        "msg_reviewer_inconsistent_user_1",
        "autoloop-reviewer",
      ),
      assistantMessage(
        "ses_reviewer_inconsistent",
        "msg_reviewer_inconsistent_assistant_1",
        "msg_reviewer_inconsistent_user_1",
        "claude-sonnet-4-5",
      ),
      userMessage(
        "ses_reviewer_inconsistent",
        "msg_reviewer_inconsistent_user_2",
        "build",
      ),
      assistantMessage(
        "ses_reviewer_inconsistent",
        "msg_reviewer_inconsistent_assistant_2",
        "msg_reviewer_inconsistent_user_2",
        "claude-opus-4-1",
      ),
    ],
    ses_reviewer_malformed: [
      userMessage(
        "ses_reviewer_malformed",
        "msg_reviewer_malformed_user",
        123,
      ),
      assistantMessage(
        "ses_reviewer_malformed",
        "msg_reviewer_malformed_assistant",
        "msg_reviewer_malformed_user",
        456,
      ),
    ],
  }
  const handlers = await plugin.Autoloop({
    client: {
      app: { log: async () => undefined },
      session: {
        get: async ({ path }) => ({ data: sessions[path.id] }),
        messages: async ({ path }) => ({ data: messages[path.id] }),
      },
    },
    directory: reviewerRoot,
  })
  await handlers.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "ses_reviewer_valid" },
    },
  })
  writeFileSync(
    join(agentDirectory, "autoloop-reviewer.md"),
    reviewerProfile.replace("  list: allow", "  bash: allow"),
  )
  await handlers.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "ses_reviewer_drifted" },
    },
  })
  writeFileSync(
    join(agentDirectory, "autoloop-reviewer.md"),
    reviewerProfile,
  )
  await handlers.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "ses_reviewer_inconsistent" },
    },
  })
  await handlers.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "ses_reviewer_malformed" },
    },
  })
  const payloads = readFileSync(
    join(toolDirectory, "payloads.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(Object.hasOwn(sessions.ses_reviewer_valid, "agent"), false)
  assert.equal(payloads[0].agent, "autoloop-reviewer")
  assert.equal(payloads[0].modelIdentity, "anthropic/claude-sonnet-4-5")
  assert.deepEqual(payloads[0].messages, messages.ses_reviewer_valid)
  assert.deepEqual(
    payloads[0].metadata,
    { tools: ["glob", "grep", "list", "read"] },
  )
  assert.equal(payloads[1].agent, "autoloop-reviewer")
  assert.equal(payloads[1].modelIdentity, "anthropic/claude-sonnet-4-5")
  assert.equal(Object.hasOwn(payloads[1], "metadata"), false)
  assert.equal(payloads[2].agent, null)
  assert.equal(Object.hasOwn(payloads[2], "modelIdentity"), false)
  assert.equal(Object.hasOwn(payloads[2], "metadata"), false)
  assert.equal(payloads[3].agent, null)
  assert.equal(Object.hasOwn(payloads[3], "modelIdentity"), false)
  assert.equal(Object.hasOwn(payloads[3], "metadata"), false)
} finally {
  rmSync(reviewerRoot, { recursive: true, force: true })
}

console.log("self-test OK")
