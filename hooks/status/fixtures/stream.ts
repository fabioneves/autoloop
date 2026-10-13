// A synthetic dispatch live stream (claude stream-json, one event per
// line) and what tools/dispatch-render.mjs prints for it, so the mod's
// renderer is held to the same lines from both sides: live.test.ts holds
// render.ts to RENDERED, and the tool's self-test reads this file (one
// single-quoted string per line, nothing else in the arrays) and holds
// itself to it. Hand-written: the engine's own stream is not needed for
// the shapes, and the paths and names are not a project's (none is in a
// git checkout, so the tool's checkout-relative shortening does not act).
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
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob","input":{"pattern":"**/*.ts","path":"/work/repo/hooks"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/work/repo/hooks/status/read.ts"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/work/repo/notes.md"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/work/repo/README.md"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":5,"input":{"x":1}}]}}',
  '{"type":"system","subtype":"init","message":{"model":"claude-fable-5-1"}}',
  '{"type":"error","message":"boom"}',
  '{"type":"rate_limit_event"}',
  '{"type":"other","subtype":"x"}',
  'not json',
  '{"type":"result","subtype":"success","duration_ms":65000,"num_turns":4,"total_cost_usd":1.234}',
]

/** The file as tail prints it: every line complete. */
export const STREAM = `${STREAM_LINES.join('\n')}\n`

/** What `node tools/dispatch-render.mjs < stream` prints for STREAM: its self-test reads this file and holds the tool to it. */
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
  '▸ glob **/*.ts in hooks',
  '▸ edit hooks/status/read.ts',
  '▸ write notes.md',
  '▸ read README.md',
  '▸ 5 {"x":1}',
  '■ engine up · claude-fable-5-1',
  '✖ boom',
  '· other/x',
  '· not json',
  '■ done · success · 1m 5s · 4 turns · $1.23',
]
