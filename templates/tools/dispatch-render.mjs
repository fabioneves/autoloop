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

import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
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

// Stateful so thinking ticks throttle across lines. Returns the rendered lines
// for one raw input line (possibly none).
export function createRenderer() {
  let lastThinkingTick = 0;
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
            lines.push(`→ ${part.name ?? 'tool'} ${compact(part.input ?? {}, 140)}`);
          } else if (part?.type === 'tool_result') {
            const body = compact(part.content ?? '', 100);
            lines.push(`← result${body ? ` · ${body}` : ''}`);
          }
        }
        return lines;
      }
      if (event.type === 'result') {
        return [`■ done · ${event.subtype ?? 'result'}`];
      }

      // codex exec --json
      if (event.type === 'item.completed' || event.type === 'item.updated') {
        const item = event.item ?? {};
        if (item.type === 'reasoning') return ['⋯ reasoning'];
        if (item.type === 'command_execution') {
          return [`→ $ ${compact(item.command ?? '', 140)}`];
        }
        if (item.type === 'agent_message') {
          return textLines(item.text ?? '', '│ ');
        }
        return [`· ${item.type ?? event.type}`];
      }
      if (event.type === 'turn.completed') {
        const used = event.usage?.output_tokens;
        return [`■ turn done${Number.isFinite(used) ? ` · ${used} out tok` : ''}`];
      }
      if (event.type === 'thread.started') return ['■ engine up'];
      if (event.type === 'error') return [`✖ ${compact(event.message ?? event, 200)}`];

      const label = [event.type, event.subtype].filter(Boolean).join('/');
      return label ? [`· ${label}`] : [];
    } catch {
      return [];
    }
  };
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
    ['tool use renders name and compact input', feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file: '/x.go' } }] },
    })[0].startsWith('→ Read'),
    ],
    ['codex command execution renders', feed({
      type: 'item.completed', item: { type: 'command_execution', command: 'rg -n foo' },
    }).join('') === '→ $ rg -n foo'],
    ['codex agent message renders text', feed({
      type: 'item.completed', item: { type: 'agent_message', text: 'verdict: fail' },
    }).join('') === '│ verdict: fail'],
    ['terminal result renders', feed({ type: 'result', subtype: 'success' }).join('') === '■ done · success'],
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

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const render = createRenderer();
  const reader = createInterface({ input: process.stdin, terminal: false });
  reader.on('line', (line) => {
    for (const out of render(line)) process.stdout.write(`${out}\n`);
  });
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
