#!/usr/bin/env node
// Subagent transcript capture for the autoloop (Codex SubagentStop hook + opencode plugin). On Codex CLI versions with the spawn-schema
// gap (no `agent_type`, 0.144.5–0.144.6), reviews run in prompt-level isolation mode and the
// orchestrator must scan the child's transcript "whenever the runtime exposes it". The runtime
// exposes it HERE: Codex's SubagentStop hook payload carries `transcript_path` (manual, hooks
// "Common input fields"). This hook copies that file plus the raw payload into
// `.git/autoloop/subagent-transcripts/` — inside .git so captures can never be committed or
// dirty the worktree.
//
// CAVEAT the consumer must respect (autoloop:dev Prime): the manual describes `transcript_path`
// as "the session transcript" and subagent hooks reuse the PARENT session id, so whether the
// file holds the child's turns or the parent's is NOT verified. The orchestrator must confirm
// a capture contains the child's activity (e.g. the reviewer's own verdict text) before
// treating it as isolation evidence; otherwise record `transcript: unavailable` as before.
//
// Loop-safety: fail-open — a capture failure warns on stderr and exits 0; a subagent stop must
// never wedge the turn. Prunes oldest captures beyond KEEP_FILES. --self-test runs the
// pure-function fixtures.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAPTURE_DIR = join(ROOT, '.git', 'autoloop', 'subagent-transcripts');
const KEEP_FILES = 40; // ISO-stamped names sort chronologically; oldest pruned first

export function planCapture(payload, stamp, existingFiles) {
  const hasPath = payload && typeof payload.transcript_path === 'string' && payload.transcript_path;
  // opencode child payload: the plugin ships the child's messages inline (SDK
  // session.children/messages) instead of a file path; an EMPTY array is still captured —
  // an empty child transcript is itself evidence.
  const hasMessages = payload && Array.isArray(payload.messages);
  const plan = {
    payloadFile: `${stamp}-payload.json`,
    transcriptCopy: hasPath || hasMessages ? `${stamp}-transcript.jsonl` : null,
    prune: [],
  };
  const total = existingFiles.length + 1 + (plan.transcriptCopy ? 1 : 0);
  if (total > KEEP_FILES) {
    plan.prune = [...existingFiles].sort().slice(0, total - KEEP_FILES);
  }
  return plan;
}

function capture() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch { /* no stdin */ }
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('autoloop: SubagentStop hook received unparseable stdin — payload not captured\n');
  }
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const plan = planCapture(payload, stamp, readdirSync(CAPTURE_DIR));
  const { messages, ...meta } = payload ?? {};
  writeFileSync(join(CAPTURE_DIR, plan.payloadFile), JSON.stringify(payload === null ? null : meta, null, 2) ?? 'null');
  if (plan.transcriptCopy) {
    if (Array.isArray(messages)) {
      writeFileSync(
        join(CAPTURE_DIR, plan.transcriptCopy),
        messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''),
      );
    } else if (existsSync(payload.transcript_path)) {
      copyFileSync(payload.transcript_path, join(CAPTURE_DIR, plan.transcriptCopy));
    } else {
      process.stderr.write(`autoloop: transcript_path ${payload.transcript_path} not readable — payload captured without transcript\n`);
    }
  }
  for (const f of plan.prune) rmSync(join(CAPTURE_DIR, f), { force: true });
}

function selfTest() {
  const cases = [
    { name: 'payload+transcript', payload: { transcript_path: '/tmp/t.jsonl' }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'no transcript_path', payload: { hook_event_name: 'SubagentStop' }, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'null payload', payload: null, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'opencode child payload', payload: { sessionID: 'ses_x', agent: 'autoloop-reviewer', messages: [{ info: { role: 'user' } }] }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'opencode empty messages still captured', payload: { sessionID: 'ses_x', agent: 'build', messages: [] }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'opencode messages not an array', payload: { sessionID: 'ses_x', messages: 'nope' }, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'prunes oldest beyond cap', payload: { transcript_path: '/tmp/t.jsonl' }, existing: Array.from({ length: KEEP_FILES }, (_, i) => `2026-01-01T00-00-${String(i).padStart(2, '0')}-1-payload.json`), want: { transcript: true, prune: 2, oldestPruned: '2026-01-01T00-00-00-1-payload.json' } },
  ];
  let ok = true;
  for (const c of cases) {
    const plan = planCapture(c.payload, 'stamp', c.existing);
    const got = { transcript: Boolean(plan.transcriptCopy), prune: plan.prune.length };
    if (got.transcript !== c.want.transcript || got.prune !== c.want.prune ||
        (c.want.oldestPruned && plan.prune[0] !== c.want.oldestPruned)) {
      ok = false;
      console.log(`self-test case failed: ${c.name} → ${JSON.stringify(plan)}`);
    }
  }
  console.log(ok ? 'self-test OK' : 'self-test FAILED');
  return ok;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  try {
    capture();
  } catch (e) {
    process.stderr.write(`autoloop: subagent transcript capture failed (${e.message}) — continuing\n`);
  }
  process.exit(0);
}
