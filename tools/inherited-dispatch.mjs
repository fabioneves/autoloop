#!/usr/bin/env node
// autoloop — inherited-dispatch.mjs
//
// A dispatch outlives the session that launched it: dispatch-stream.sh
// double-forks it into its own session so a killed task never kills the
// work, and it writes its typed result to its --output-file on its own. When
// that session ends (a restart, a crash), the dispatch keeps working with no
// one to collect it. LFE run 2026-09-30: a new session found #389's fix
// dispatch still writing, refused to start, and offered to stop it — 50
// minutes of work.
//
// Every dispatch carries CLAUDE_PID and CLAUDE_CODE_SESSION_ID, the Claude
// process and conversation that launched it, in its environment (the id
// survives compaction: measured). Measured against those:
//   - own: this process and conversation;
//   - inherited: its conversation ended — the launcher is gone (no such
//     process, or one started after the dispatch: a reused pid), or it is this
//     process in another conversation (/clear) — so this session takes it over;
//   - foreign: a live launcher's, never touched (one this cannot recognise as
//     Claude stays here, the safe side);
//   - unknown: no launcher recorded (launched by hand, an older Claude Code).
// Linux reads /proc; anywhere it cannot look, nothing is reported.
//
// Usage: node inherited-dispatch.mjs --self-test

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { procEntry, processStart, sessionOwnerPid } from './run-markers.mjs';

/** Pure: a dispatch.mjs command line's facts, or null for anything else.
 *  `/proc/<pid>/cmdline` separates arguments with NUL. The stream wrapper and
 *  its tail name dispatch.mjs too, but only dispatch.mjs itself runs it. */
export function parseDispatchCmdline(cmdline) {
  const args = String(cmdline ?? '').split('\0').filter((arg) => arg !== '');
  if (!/(?:^|\/)node(?:js)?$/u.test(args[0] ?? '') || !/(?:^|\/)dispatch\.mjs$/u.test(args[1] ?? '')) return null;
  // The last occurrence wins, as dispatch.mjs's own parser reads it.
  const value = (flag) => {
    const index = args.lastIndexOf(flag);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  const role = value('--role');
  if (role === null) return null;
  const issue = value('--issue');
  return {
    role,
    issue: /^[1-9]\d*$/u.test(issue ?? '') ? Number(issue) : null,
    outputFile: value('--output-file'),
    liveFile: value('--live-file'),
    promptFile: value('--prompt-file'),
  };
}

/** Pure: the launching Claude process and conversation from a NUL-separated
 *  environment. Claude may be pid 1 (a container). */
export function launcherFromEnviron(environ) {
  const lines = String(environ ?? '').split('\0');
  const read = (name) => lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const pid = Number(read('CLAUDE_PID'));
  return {
    pid: Number.isSafeInteger(pid) && pid >= 1 ? pid : null,
    session: read('CLAUDE_CODE_SESSION_ID') || null,
  };
}

/** Pure: which dispatches this session inherits, which a live session owns,
 *  and which name no launcher. `owner` is {pid, session}; `entryOf(pid)` is a
 *  process-table entry or null when there is no such process; `startOf(pid)`
 *  its start in clock ticks, or null. */
export function classifyDispatches(dispatches, { owner, entryOf, startOf }) {
  const out = { inherited: [], foreign: [], unknown: [] };
  for (const dispatch of dispatches) {
    const { pid, session } = dispatch.launcher;
    if (pid === null) {
      out.unknown.push(dispatch);
      continue;
    }
    if (pid === owner.pid) {
      const sameConversation = session === null || owner.session === null || session === owner.session;
      if (!sameConversation) out.inherited.push(dispatch);
      continue;
    }
    const launcherStart = Number(startOf(pid));
    const dispatchStart = Number(startOf(dispatch.pid));
    const reused = launcherStart > 0 && dispatchStart > 0 && launcherStart > dispatchStart;
    (entryOf(pid) === null || reused ? out.inherited : out.foreign).push(dispatch);
  }
  return out;
}

/** Pure: worktree roots from `git worktree list --porcelain`. */
export function worktreeRoots(porcelain) {
  return String(porcelain ?? '').split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function within(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The dispatches running in this repository's worktrees, each with its
 *  launcher. Null where the process table cannot be read. */
export function runningDispatches(root) {
  let roots;
  let entries;
  try {
    roots = worktreeRoots(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    })).map((path) => {
      try { return realpathSync(path); } catch { return path; }
    });
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  const dispatches = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const facts = parseDispatchCmdline(readFileSync(`/proc/${entry}/cmdline`, 'utf8'));
      if (facts === null) continue;
      const cwd = realpathSync(`/proc/${entry}/cwd`);
      if (!within(cwd, roots)) continue;
      dispatches.push({
        pid: Number(entry),
        ...facts,
        cwd,
        launcher: launcherFromEnviron(readFileSync(`/proc/${entry}/environ`, 'utf8')),
      });
    } catch { /* gone, or not ours to read */ }
  }
  return dispatches;
}

// This session: the CLAUDE_PID and conversation its own dispatches record.
function currentOwner() {
  const pid = Number(process.env.CLAUDE_PID);
  return {
    pid: Number.isSafeInteger(pid) && pid >= 1 ? pid : sessionOwnerPid(),
    session: process.env.CLAUDE_CODE_SESSION_ID || null,
  };
}

/** What prime reports. Empty where the process table cannot be read. */
export function dispatchInheritance(root, { owner = null, entryOf = procEntry, startOf = processStart, scan = runningDispatches } = {}) {
  const dispatches = scan(root);
  if (dispatches === null || dispatches.length === 0) return { inherited: [], foreign: [], unknown: [] };
  const strip = ({ launcher, ...dispatch }) => dispatch;
  const sorted = classifyDispatches(dispatches, { owner: owner ?? currentOwner(), entryOf, startOf });
  return {
    inherited: sorted.inherited.map(strip),
    foreign: sorted.foreign.map(strip),
    unknown: sorted.unknown.map(strip),
  };
}

function selfTest() {
  const results = [];
  const check = (name, ok) => results.push([name, ok === true]);
  const nul = (...args) => `${args.join('\0')}\0`;
  const cmdline = nul('node', '/p/tools/dispatch.mjs', '--role', 'implement', '--prompt-file', '/t/p.md',
    '--issue', '389', '--live-file', '/t/live.jsonl', '--output-file', '/t/result.json', '--json');
  check('a dispatch command line names its role, unit and files',
    JSON.stringify(parseDispatchCmdline(cmdline)) === JSON.stringify({
      role: 'implement', issue: 389, outputFile: '/t/result.json', liveFile: '/t/live.jsonl', promptFile: '/t/p.md',
    }));
  check('the stream wrapper, its tail, a wait and a non-dispatch are not dispatches',
    parseDispatchCmdline(nul('bash', '/p/tools/dispatch-stream.sh', '/t/l', '/t/r', '--role', 'implement')) === null
      && parseDispatchCmdline(nul('tail', '--pid', '9', '/t/dispatch.mjs')) === null
      && parseDispatchCmdline(nul('node', '/p/tools/dispatch.mjs', '--wait-file', '/t/r')) === null
      && parseDispatchCmdline(nul('node', '/p/tools/prime.mjs', '--role', 'x')) === null);
  check('a repeated flag reads its last value, as dispatch.mjs does',
    parseDispatchCmdline(nul('node', '/p/dispatch.mjs', '--role', 'implement', '--output-file', '/t/a', '--output-file', '/t/b')).outputFile === '/t/b');
  check('the launcher is CLAUDE_PID (pid 1 included) and its conversation',
    JSON.stringify(launcherFromEnviron(nul('HOME=/h', 'CLAUDE_PID=3843700', 'CLAUDE_CODE_SESSION_ID=s1')))
      === JSON.stringify({ pid: 3843700, session: 's1' })
      && launcherFromEnviron(nul('CLAUDE_PID=1')).pid === 1
      && JSON.stringify(launcherFromEnviron(nul('HOME=/h'))) === JSON.stringify({ pid: null, session: null })
      && launcherFromEnviron(nul('CLAUDE_PID=abc')).pid === null);
  // pid -> [entry, start]: 100 this session, 200 a live session, 300 a
  // process that took a dead launcher's pid after the dispatch started.
  const table = new Map([[100, 10], [200, 10], [300, 90], [1, 5]]);
  const entryOf = (pid) => (table.has(pid) ? [0, 'x', ''] : null);
  const startOf = (pid) => (table.has(pid) ? String(table.get(pid)) : String(50));
  const at = (pid, launcherPid, session = 's-new') => ({ pid, role: 'implement', issue: 389, launcher: { pid: launcherPid, session } });
  const sorted = classifyDispatches([
    at(1, 100), // own
    at(2, 200), // a live session's
    at(3, 999), // launcher dead
    at(4, 300), // launcher pid reused after the dispatch started
    at(5, null), // no launcher recorded
    at(6, 100, 's-old'), // this process, an earlier conversation (/clear)
    at(7, 1, 's-pid1'), // Claude as pid 1, a live launcher
  ], { owner: { pid: 100, session: 's-new' }, entryOf, startOf });
  check('ended conversations are inherited; own is skipped; live launchers are foreign; none recorded is unknown',
    sorted.inherited.map((d) => d.pid).join(',') === '3,4,6'
      && sorted.foreign.map((d) => d.pid).join(',') === '2,7'
      && sorted.unknown.map((d) => d.pid).join(',') === '5');
  check('Claude as pid 1 owns its own dispatch',
    classifyDispatches([at(8, 1, 's')], { owner: { pid: 1, session: 's' }, entryOf, startOf }).inherited.length === 0
      && classifyDispatches([at(8, 1, 's')], { owner: { pid: 1, session: 's' }, entryOf, startOf }).foreign.length === 0);
  // The process table end to end (Linux): fake dispatch processes in a
  // scratch repository, one per kind.
  if (process.platform === 'linux') {
    const scratch = mkdtempSync(join(tmpdir(), 'inherit-'));
    const children = [];
    try {
      execFileSync('git', ['init', '-q', scratch]);
      mkdirSync(join(scratch, 'tools'));
      const fake = join(scratch, 'tools', 'dispatch.mjs');
      writeFileSync(fake, 'setTimeout(() => {}, 30000);\n');
      const gone = spawnSync(process.execPath, ['-e', '0']).pid;
      const launch = (issue, env) => {
        const child = spawn(process.execPath, [fake, '--role', 'implement', '--issue', String(issue), '--output-file', `/t/${issue}.json`],
          { cwd: scratch, stdio: 'ignore', env: { PATH: process.env.PATH, ...env } });
        children.push(child);
      };
      launch(11, { CLAUDE_PID: String(gone), CLAUDE_CODE_SESSION_ID: 'old' });
      launch(12, { CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: 'other' });
      launch(13, { CLAUDE_PID: '424242', CLAUDE_CODE_SESSION_ID: 'mine' });
      launch(14, {});
      const deadline = Date.now() + 5000;
      let found = [];
      while (Date.now() < deadline && found.length < 4) found = runningDispatches(scratch) ?? [];
      const report = dispatchInheritance(scratch, { owner: { pid: 424242, session: 'mine' } });
      const real = realpathSync(scratch);
      check('the process table yields each fake dispatch with its facts, sorted by launcher',
        found.length === 4
          && report.inherited.map((d) => d.issue).join(',') === '11'
          && report.inherited[0].outputFile === '/t/11.json' && report.inherited[0].cwd === real
          && report.inherited[0].launcher === undefined
          && report.foreign.map((d) => d.issue).join(',') === '12'
          && report.unknown.map((d) => d.issue).join(',') === '14');
    } finally {
      for (const child of children) child.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  check('worktree roots come from the porcelain listing',
    worktreeRoots('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/w\nHEAD def\ndetached\n').join(',') === '/r,/tmp/w');
  const failed = results.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`FAIL ${name}`);
  console.log(failed.length === 0 ? `self-test OK (${results.length} cases)` : `self-test FAILED (${failed.length}/${results.length})`);
  return failed.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
  console.error('usage: inherited-dispatch.mjs --self-test');
  process.exit(2);
}
