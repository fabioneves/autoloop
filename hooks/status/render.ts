// The live stream's renderer: tools/dispatch-render.mjs `createRenderer`,
// line for line, in the mod's own environment. The host lets a hooks
// module import its own files and `claude-code` only, and dispatch-render
// imports node:child_process for its `--follow` mode, so the renderer is
// held here and live.test.ts holds it to the tool's output on one stream
// (fixtures/stream.ts). One difference: a path is shortened against the
// stream's own `cwd` or to its last three segments, never against a git
// checkout, since the mod reads no file system.
//
// Contract, as the tool's: never throw. An unknown shape degrades to a
// compact type marker, and garbage passes through truncated.

/** A reasoning tick is printed every this many estimated tokens. */
const THINKING_TICK = 2000
const MAX_LINE = 400

type Record = { [key: string]: unknown }

const isRecord = (value: unknown): value is Record => typeof value === 'object' && value !== null && !Array.isArray(value)

function compact(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function textLines(text: unknown, prefix: string): string[] {
  return String(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => `${prefix}${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line}`)
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

/** Relative to the stream's cwd; else an absolute path keeps its last three segments. */
function shortPath(value: unknown, cwd: string | null): string {
  const path = String(value ?? '')
  if (cwd !== null && path === cwd) return '.'
  if (cwd !== null && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const segments = path.split('/').filter(Boolean)
  return path.startsWith('/') && segments.length > 3 ? `…/${segments.slice(-3).join('/')}` : path
}

function toolLine(name: unknown, input: Record, cwd: string | null): string {
  const where = (path: unknown) => (path ? ` in ${shortPath(path, cwd)}` : '')
  if (name === 'Read') {
    const from = Number(input['offset'])
    const range = Number.isFinite(from) && Number.isFinite(Number(input['limit']))
      ? ` :${from}-${from + Number(input['limit'])}`
      : ''
    return `▸ read ${shortPath(input['file_path'], cwd)}${range}`
  }
  if (name === 'Grep') return `▸ grep /${compact(input['pattern'], 80)}/${where(input['path'])}`
  if (name === 'Glob') return `▸ glob ${compact(input['pattern'], 80)}${where(input['path'])}`
  if (name === 'Bash') return `▸ $ ${compact(String(input['command'] ?? '').split('\n')[0], 140)}`
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    return `▸ ${name.toLowerCase()} ${shortPath(input['file_path'] ?? input['notebook_path'], cwd)}`
  }
  if (name === 'StructuredOutput') {
    const findings = input['findings']
    return typeof input['verdict'] === 'string'
      ? `■ verdict ${input['verdict']}${Array.isArray(findings) ? ` · ${findings.length} findings` : ''}`
      : '■ structured output'
  }
  return `▸ ${typeof name === 'string' ? name : 'tool'} ${compact(input, 100)}`
}

/** Stateful, so thinking ticks throttle across lines and paths shorten against the stream's cwd. Returns the rendered lines for one raw line. */
export function createRenderer(): (raw: string) => string[] {
  let lastThinkingTick = 0
  let cwd: string | null = null
  return function renderLine(raw: string): string[] {
    try {
      const line = String(raw).trim()
      if (line.length === 0) return []
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        return [`· ${compact(line, 120)}`]
      }
      if (!isRecord(event)) return []

      // claude stream-json
      if (event['type'] === 'system' && event['subtype'] === 'thinking_tokens') {
        const total = Number(event['estimated_tokens'])
        if (!Number.isFinite(total)) return []
        if (total - lastThinkingTick < THINKING_TICK) return []
        lastThinkingTick = total
        return [`⋯ thinking ~${Math.round(total / 1000)}k tok`]
      }
      if (event['type'] === 'system' && event['subtype'] === 'init') {
        if (typeof event['cwd'] === 'string') cwd = event['cwd']
        const message = event['message']
        const model = event['model'] ?? (isRecord(message) ? message['model'] : undefined) ?? ''
        return [`■ engine up${model ? ` · ${String(model)}` : ''}`]
      }
      if (event['type'] === 'assistant' || event['type'] === 'user') {
        const message = event['message']
        const parts = isRecord(message) ? message['content'] : undefined
        if (!Array.isArray(parts)) return []
        const lines: string[] = []
        for (const part of parts as unknown[]) {
          if (!isRecord(part)) continue
          if (part['type'] === 'text' && typeof part['text'] === 'string') {
            lines.push(...textLines(part['text'], '│ '))
          } else if (part['type'] === 'tool_use') {
            lines.push(toolLine(part['name'], isRecord(part['input']) ? part['input'] : {}, cwd))
          } else if (part['type'] === 'tool_result' && part['is_error'] === true) {
            lines.push(`  ✖ ${compact(part['content'] ?? '', 160)}`)
          }
        }
        return lines
      }
      if (event['type'] === 'result') {
        const ms = event['duration_ms']
        const turns = event['num_turns']
        const cost = event['total_cost_usd']
        const facts = [
          String(event['subtype'] ?? 'result'),
          typeof ms === 'number' && Number.isFinite(ms) ? duration(ms) : null,
          typeof turns === 'number' && Number.isFinite(turns) ? `${turns} turns` : null,
          typeof cost === 'number' && Number.isFinite(cost) ? `$${cost.toFixed(2)}` : null,
        ].filter((fact): fact is string => fact !== null)
        return [`■ done · ${facts.join(' · ')}`]
      }

      if (event['type'] === 'error') return [`✖ ${compact(event['message'] ?? event, 200)}`]
      if (event['type'] === 'rate_limit_event' || event['type'] === 'system') return []

      const label = [event['type'], event['subtype']].filter((part) => typeof part === 'string' && part !== '').join('/')
      return label ? [`· ${label}`] : []
    } catch {
      return []
    }
  }
}
