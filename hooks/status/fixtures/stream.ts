// A synthetic dispatch live stream (claude stream-json, one event per
// line) and what tools/dispatch-render.mjs prints for it, so the mod's
// renderer is held to the same lines. Hand-written: the engine's own
// stream is not needed for the shapes, and the paths and names are not a
// project's.
export const STREAM_LINES = [
  '{"type":"system","subtype":"init","cwd":"/work/repo","model":"claude-opus-5-5"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the plan.\\nSecond line.\\n\\n"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/work/repo/tasks/plan.md","offset":10,"limit":20}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"ENOENT: no such file\\nsecond"}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"a fine result"}]}}',
  '{"type":"system","subtype":"thinking_tokens","estimated_tokens":1500}',
  '{"type":"system","subtype":"thinking_tokens","estimated_tokens":2400}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test\\necho done"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"foo","path":"/elsewhere/a/b/c/d"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"verdict":"pass","findings":[1,2]}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{"url":"https://example.com"}}]}}',
  '{"type":"error","message":"boom"}',
  '{"type":"rate_limit_event"}',
  '{"type":"other","subtype":"x"}',
  'not json',
  '{"type":"result","subtype":"success","duration_ms":65000,"num_turns":4,"total_cost_usd":1.234}',
]

/** The file as tail prints it: every line complete. */
export const STREAM = `${STREAM_LINES.join('\n')}\n`

/** What `node tools/dispatch-render.mjs < stream` prints for STREAM (checked by hand on 2026-10-13). */
export const RENDERED = [
  '■ engine up · claude-opus-5-5',
  '│ Reading the plan.',
  '│ Second line.',
  '▸ read tasks/plan.md :10-30',
  '  ✖ ENOENT: no such file second',
  '⋯ thinking ~2k tok',
  '▸ $ npm test',
  '▸ grep /foo/ in …/b/c/d',
  '■ verdict pass · 2 findings',
  '▸ WebFetch {"url":"https://example.com"}',
  '✖ boom',
  '· other/x',
  '· not json',
  '■ done · success · 1m 5s · 4 turns · $1.23',
]
