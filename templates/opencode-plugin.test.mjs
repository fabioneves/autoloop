#!/usr/bin/env node

import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
const plugin = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
)

// The plugin carries no policy of its own: it wires opencode's hooks to the
// repo-vendored guards. It must never reach for a tool that no longer exists.
for (const retired of [
  "intent-contract.mjs",
  "continuation-store.mjs",
  "run-scope.mjs",
  "measurement-contract.mjs",
]) {
  assert.equal(source.includes(retired), false, `retired tool referenced: ${retired}`)
}
assert.equal(source.includes("relaunch"), false)
assert.equal(source.includes("command.execute.before"), false)
assert.equal(source.includes("chat.message"), false)

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
