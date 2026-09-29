#!/usr/bin/env node
// autoloop — dispatch-render.mjs
//
// Human renderer for a dispatch live stream. dispatch-stream.sh pipes the tail
// of the live JSONL file through this filter so the host's task pane shows what
// the engine is DOING — reasoning ticks, tool calls, output text — instead of
// raw event JSON. The stream stays machine-readable on disk; only the pane view
// is rendered.
//
// Contract: NEVER throw, NEVER exit before stdin ends. A crashed renderer would
// end the watcher pipe while the dispatch runs on, making a live dispatch look
// dead — so every line is wrapped, unknown shapes degrade to a compact type
// marker, and garbage passes through truncated.
//
// Usage: tail -F <live.jsonl> | node dispatch-render.mjs
//        node dispatch-render.mjs --follow <live.jsonl>

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THINKING_TICK = 2000; // print a reasoning tick every N estimated tokens
const MAX_LINE = 400;

function compact(value, limit = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function textLines(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => `${prefix}${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line}`);
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

// Reviewers read scratch worktrees as often as the checkout itself, so a path
// is shown relative to whichever git checkout holds it.
const gitRoots = new Map();
function gitRoot(directory) {
  if (gitRoots.has(directory)) return gitRoots.get(directory);
  let root = null;
  try {
    if (existsSync(join(directory, '.git'))) root = directory;
    else if (dirname(directory) !== directory) root = gitRoot(dirname(directory));
  } catch {
    root = null;
  }
  gitRoots.set(directory, root);
  return root;
}

// Relative to its git checkout (or the engine's cwd); else the last three segments.
function shortPath(value, cwd) {
  const path = String(value ?? '');
  if (cwd && path === cwd) return '.';
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const root = path.startsWith('/') ? gitRoot(dirname(path)) : null;
  if (root && root !== '/') return path === root ? '.' : path.slice(root.length + 1);
  const segments = path.split('/').filter(Boolean);
  return path.startsWith('/') && segments.length > 3 ? `…/${segments.slice(-3).join('/')}` : path;
}

function toolLine(name, input, cwd) {
  const where = (path) => (path ? ` in ${shortPath(path, cwd)}` : '');
  if (name === 'Read') {
    const from = Number(input.offset);
    const range = Number.isFinite(from) && Number.isFinite(Number(input.limit))
      ? ` :${from}-${from + Number(input.limit)}`
      : '';
    return `▸ read ${shortPath(input.file_path, cwd)}${range}`;
  }
  if (name === 'Grep') return `▸ grep /${compact(input.pattern, 80)}/${where(input.path)}`;
  if (name === 'Glob') return `▸ glob ${compact(input.pattern, 80)}${where(input.path)}`;
  if (name === 'Bash') return `▸ $ ${compact(String(input.command ?? '').split('\n')[0], 140)}`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return `▸ ${name.toLowerCase()} ${shortPath(input.file_path ?? input.notebook_path, cwd)}`;
  }
  if (name === 'StructuredOutput') {
    return typeof input.verdict === 'string'
      ? `■ verdict ${input.verdict}${Array.isArray(input.findings) ? ` · ${input.findings.length} findings` : ''}`
      : '■ structured output';
  }
  return `▸ ${name ?? 'tool'} ${compact(input, 100)}`;
}

// Stateful so thinking ticks throttle across lines and paths shorten against
// the engine's cwd. Returns the rendered lines for one raw input line.
export function createRenderer() {
  let lastThinkingTick = 0;
  let cwd = null;
  return function renderLine(raw) {
    try {
      const line = String(raw).trim();
      if (line.length === 0) return [];
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [`· ${compact(line, 120)}`];
      }
      if (event === null || typeof event !== 'object') return [];

      // claude stream-json
      if (event.type === 'system' && event.subtype === 'thinking_tokens') {
        const total = Number(event.estimated_tokens);
        if (!Number.isFinite(total)) return [];
        if (total - lastThinkingTick < THINKING_TICK) return [];
        lastThinkingTick = total;
        return [`⋯ thinking ~${Math.round(total / 1000)}k tok`];
      }
      if (event.type === 'system' && event.subtype === 'init') {
        if (typeof event.cwd === 'string') cwd = event.cwd;
        const model = event.model ?? event.message?.model ?? '';
        return [`■ engine up${model ? ` · ${model}` : ''}`];
      }
      if (event.type === 'assistant' || event.type === 'user') {
        const parts = event.message?.content;
        if (!Array.isArray(parts)) return [];
        const lines = [];
        for (const part of parts) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            lines.push(...textLines(part.text, '│ '));
          } else if (part?.type === 'tool_use') {
            lines.push(toolLine(part.name, part.input ?? {}, cwd));
          } else if (part?.type === 'tool_result' && part.is_error === true) {
            lines.push(`  ✖ ${compact(part.content ?? '', 160)}`);
          }
        }
        return lines;
      }
      if (event.type === 'result') {
        const facts = [
          event.subtype ?? 'result',
          Number.isFinite(event.duration_ms) ? duration(event.duration_ms) : null,
          Number.isFinite(event.num_turns) ? `${event.num_turns} turns` : null,
          Number.isFinite(event.total_cost_usd) ? `$${event.total_cost_usd.toFixed(2)}` : null,
        ].filter(Boolean);
        return [`■ done · ${facts.join(' · ')}`];
      }

      if (event.type === 'error') return [`✖ ${compact(event.message ?? event, 200)}`];
      if (event.type === 'rate_limit_event' || event.type === 'system') return [];

      const label = [event.type, event.subtype].filter(Boolean).join('/');
      return label ? [`· ${label}`] : [];
    } catch {
      return [];
    }
  };
}

// The pane view for a FOREGROUND dispatch, whose whole stdout becomes the
// orchestrator's tool result (LFE, 2026-09-29: ~196 lines / 21.9 KB at 5.5
// minutes of one implement). Milestones and errors always show; reads and
// searches fold into one count line; each text block shows its first line;
// thinking ticks drop; detail stops after a fixed budget, and a totals line
// closes it. The full stream stays one `--follow` away.
const COMPACT_DETAIL_LINES = 30;
const COMPACT_ERROR_LINES = 10;
const FOLDED = Object.freeze(['read', 'grep', 'glob']);

export function createCompactRenderer() {
  const render = createRenderer();
  const totals = new Map();
  const folded = new Map();
  let detail = 0;
  let errors = 0;
  let noted = false;
  const count = (kind) => totals.set(kind, (totals.get(kind) ?? 0) + 1);
  const spend = (line) => {
    if (detail < COMPACT_DETAIL_LINES) {
      detail += 1;
      return [line];
    }
    if (noted) return [];
    noted = true;
    return ['… more in the full view (the ▸ full view command above)'];
  };
  const flush = () => {
    if (folded.size === 0) return [];
    const line = `▸ ${[...folded].map(([kind, n]) => `${kind} ×${n}`).join(' · ')}`;
    folded.clear();
    return spend(line);
  };
  const renderLine = (raw) => {
    const out = [];
    let textShown = false;
    for (const line of render(raw)) {
      if (line.startsWith('⋯ ')) continue;
      if (line.startsWith('■ ')) {
        out.push(...flush(), line);
        continue;
      }
      if (line.trimStart().startsWith('✖')) {
        count('error');
        out.push(...flush());
        if (errors < COMPACT_ERROR_LINES) {
          errors += 1;
          out.push(line);
        }
        continue;
      }
      if (line.startsWith('│ ')) {
        if (!textShown) out.push(...flush(), ...spend(compact(line, 100)));
        textShown = true;
        continue;
      }
      const kind = /^▸ (\S+)/u.exec(line)?.[1];
      if (kind !== undefined) count(kind);
      if (FOLDED.includes(kind)) {
        folded.set(kind, (folded.get(kind) ?? 0) + 1);
        continue;
      }
      out.push(...flush(), ...spend(line));
    }
    return out;
  };
  const finish = () => [
    ...flush(),
    ...(totals.size ? [`■ totals · ${[...totals].map(([kind, n]) => `${kind} ${n}`).join(' · ')}`] : []),
  ];
  return { renderLine, finish };
}

function selfTest() {
  const render = createRenderer();
  const feed = (value) => render(typeof value === 'string' ? value : JSON.stringify(value));
  const cases = [
    ['first thinking tick renders', feed({
      type: 'system', subtype: 'thinking_tokens', estimated_tokens: 2400,
    }).join('') === '⋯ thinking ~2k tok'],
    ['sub-threshold ticks are throttled', feed({
      type: 'system', subtype: 'thinking_tokens', estimated_tokens: 2500,
    }).length === 0],
    ['assistant text renders as pane lines', feed({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Reviewing the diff.\n\nOne Major.' }] },
    }).join('\n') === '│ Reviewing the diff.\n│ One Major.'],
    // A live pane in LFE was raw JSON inputs and absolute /tmp paths scrolling
    // past, with every tool result's content dumped under it.
    ['the engine line names the model and anchors paths at its cwd', feed({
      type: 'system', subtype: 'init', model: 'claude-fable-5-1', cwd: '/repo',
    }).join('') === '■ engine up · claude-fable-5-1'],
    ['a read shows the repo-relative path and range', feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/engine/a.go', offset: 40, limit: 20 } }] },
    }).join('') === '▸ read engine/a.go :40-60'],
    ['a path inside any git checkout is shown relative to it', (() => {
      const root = mkdtempSync(join(tmpdir(), 'render-wt-'));
      mkdirSync(join(root, 'engine', 'core'), { recursive: true });
      writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
      const rendered = feed({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(root, 'engine', 'core', 'b.go') } }] },
      }).join('');
      rmSync(root, { recursive: true, force: true });
      return rendered === '▸ read engine/core/b.go';
    })()],
    ['--follow takes exactly one live file', followTarget(['--follow', '/tmp/l.jsonl']) === '/tmp/l.jsonl'
      && followTarget(['--follow']) === null && followTarget([]) === null
      && followTarget(['--follow', 'a', 'b']) === null],
    ['host chatter is not rendered', feed({ type: 'rate_limit_event' }).length === 0
      && feed({ type: 'system', subtype: 'commands_changed' }).length === 0],
    ['a search shows its pattern and where, a path outside the repo shortened', feed({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Grep', input: { pattern: 'sort', path: '/tmp/wt-9/packages/c/src/x.ts', output_mode: 'content' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '*artifact*', path: '/repo/engine' } },
      ] },
    }).join('\n') === '▸ grep /sort/ in …/c/src/x.ts\n▸ glob *artifact* in engine'],
    ['a shell call shows its first command line', feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git log -3\nmore' } }] },
    }).join('') === '▸ $ git log -3'],
    ['tool result bodies are dropped; only errors show', feed({
      type: 'user',
      message: { content: [
        { type: 'tool_result', content: 'x'.repeat(5000) },
        { type: 'tool_result', is_error: true, content: 'File does not exist.' },
      ] },
    }).join('\n') === '  ✖ File does not exist.'],
    ['the verdict is announced', feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdict: 'fail', findings: [{}, {}] } }] },
    }).join('') === '■ verdict fail · 2 findings'],
    ['terminal result renders duration, turns and cost', feed({
      type: 'result', subtype: 'success', duration_ms: 459377, num_turns: 59, total_cost_usd: 6.312,
    }).join('') === '■ done · success · 7m 39s · 59 turns · $6.31'],
    ['terminal result renders', feed({ type: 'result', subtype: 'success' }).join('') === '■ done · success'],
    ['an edit or write names its file, not its JSON input', feed({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/engine/a.go', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/engine/b.go', content: 'z'.repeat(500) } },
      ] },
    }).join('\n') === '▸ edit engine/a.go\n▸ write engine/b.go'],
    // LFE, 2026-09-29: dispatches run in the FOREGROUND (background shells were
    // killed), so the whole pane stream becomes the orchestrator's tool result:
    // ~196 lines / 21.9 KB at 5.5 minutes of one implement dispatch.
    ['the compact pane folds reads, keeps changes and milestones, and totals at the end', (() => {
      const pane = createCompactRenderer();
      const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', cwd: '/repo' }),
        ...Array.from({ length: 5 }, (unused, index) => tool('Read', { file_path: `/repo/f${index}.ts` })),
        tool('Grep', { pattern: 'x', path: '/repo' }),
        tool('Edit', { file_path: '/repo/f1.ts', old_string: 'a', new_string: 'b' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented the codec.\nAll green.' }] } }),
        JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9000 }),
        tool('Bash', { command: 'pnpm test' }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'exit 1' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 61000, num_turns: 9 }),
      ].flatMap((line) => pane.renderLine(line));
      return [...lines, ...pane.finish()].join('\n') === [
        '■ engine up · claude-opus-5-5',
        '▸ read ×5 · grep ×1',
        '▸ edit f1.ts',
        '│ Implemented the codec.',
        '▸ $ pnpm test',
        '  ✖ exit 1',
        '■ done · success · 1m 1s · 9 turns',
        '■ totals · read 5 · grep 1 · edit 1 · $ 1 · error 1',
      ].join('\n');
    })()],
    ['the compact pane is bounded however long the dispatch runs', (() => {
      const pane = createCompactRenderer();
      const out = [];
      for (let index = 0; index < 400; index += 1) {
        out.push(...pane.renderLine(JSON.stringify({ type: 'assistant', message: { content: [
          { type: 'tool_use', name: index % 2 ? 'Read' : 'Edit', input: { file_path: `/x/f${index}.ts` } }] } })));
      }
      out.push(...pane.finish());
      return out.length <= 34
        && out.filter((line) => line.startsWith('… ')).length === 1
        && out.at(-1) === '■ totals · edit 200 · read 200';
    })()],
    ['unknown typed events degrade to a marker', feed({ type: 'stream_event', subtype: 'x' }).join('') === '· stream_event/x'],
    ['non-JSON garbage passes through truncated', render('not json at all')[0] === '· not json at all'],
    ['empty and null lines render nothing', render('').length === 0 && render('null').length === 0],
    ['nothing throws on hostile shapes', (() => {
      const hostile = ['{"type":{"deep":1}}', '{"message":9}', '[]', '"str"', '{"type":"assistant","message":{"content":[{"type":"text","text":123}]}}'];
      try {
        for (const value of hostile) render(value);
        return true;
      } catch {
        return false;
      }
    })()],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

// `--follow <live-file>` watches a dispatch from any terminal at full size, from
// its first event: the task pane is small and shares the screen.
export function followTarget(args) {
  return args.length === 2 && args[0] === '--follow' && args[1].length > 0 ? args[1] : null;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const compactPane = process.argv.length === 3 && process.argv[2] === '--compact';
  const pane = compactPane ? createCompactRenderer() : null;
  const render = pane?.renderLine ?? createRenderer();
  const follow = followTarget(process.argv.slice(2));
  const input = follow === null
    ? process.stdin
    : spawn('tail', ['-n', '+1', '-F', follow], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  const reader = createInterface({ input, terminal: false });
  reader.on('line', (line) => {
    for (const out of render(line)) process.stdout.write(`${out}\n`);
  });
  if (pane !== null) {
    reader.on('close', () => {
      for (const out of pane.finish()) process.stdout.write(`${out}\n`);
    });
  }
  // The pipe closing (tail exited with the dispatch) ends the renderer; any
  // stdout error (pane gone) must not crash a still-running dispatch's watcher.
  process.stdout.on('error', () => {});
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
