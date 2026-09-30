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
// Every dispatch carries CLAUDE_PID, the Claude process that launched it, in
// its environment. Measured against that:
//   - own: launched by this session;
//   - inherited: its launcher is gone (dead, or the pid now names something
//     other than Claude), so this session takes it over;
//   - foreign: a live Claude session's, or its launcher is unknown — never
//     touched.
// Linux reads /proc; anywhere it cannot look, nothing is reported.
//
// Usage: node inherited-dispatch.mjs --self-test

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isClaudeProcess, procEntry, sessionOwnerPid } from './run-markers.mjs';

/** Pure: a dispatch.mjs command line's facts, or null for anything else.
 *  `/proc/<pid>/cmdline` separates arguments with NUL. The stream wrapper and
 *  its tail name dispatch.mjs too, but only dispatch.mjs itself runs it. */
export function parseDispatchCmdline(cmdline) {
  const args = String(cmdline ?? '').split('\0').filter((arg) => arg !== '');
  if (!/(?:^|\/)node(?:js)?$/u.test(args[0] ?? '') || !/(?:^|\/)dispatch\.mjs$/u.test(args[1] ?? '')) return null;
  const value = (flag) => {
    const index = args.indexOf(flag);
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

/** Pure: the launching Claude process from a NUL-separated environment. */
export function launcherFromEnviron(environ) {
  const entry = String(environ ?? '').split('\0').find((line) => line.startsWith('CLAUDE_PID='));
  const pid = Number(entry?.slice('CLAUDE_PID='.length));
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Pure: which dispatches this session inherits, and which belong to a live
 *  session. `entryOf(pid)` is a process-table entry, [parent, name, exe], or
 *  null when there is no such process. */
export function classifyDispatches(dispatches, { owner, entryOf }) {
  const inherited = [];
  const foreign = [];
  for (const dispatch of dispatches) {
    if (dispatch.launcher !== null && dispatch.launcher === owner) continue;
    const entry = dispatch.launcher === null ? undefined : entryOf(dispatch.launcher);
    const launcherGone = entry === null || (entry !== undefined && !isClaudeProcess(entry[1], entry[2]));
    (launcherGone ? inherited : foreign).push(dispatch);
  }
  return { inherited, foreign };
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
      if (facts === null || !within(realpathSync(`/proc/${entry}/cwd`), roots)) continue;
      dispatches.push({
        pid: Number(entry),
        ...facts,
        launcher: launcherFromEnviron(readFileSync(`/proc/${entry}/environ`, 'utf8')),
      });
    } catch { /* gone, or not ours to read */ }
  }
  return dispatches;
}

/** What prime reports: the dispatches this session inherits and the ones a
 *  live session owns. Empty where the process table cannot be read. */
export function dispatchInheritance(root, { owner = sessionOwnerPid(), entryOf = procEntry } = {}) {
  const dispatches = runningDispatches(root);
  if (dispatches === null) return { inherited: [], foreign: [] };
  const strip = ({ launcher, ...dispatch }) => dispatch;
  const { inherited, foreign } = classifyDispatches(dispatches, { owner, entryOf });
  return { inherited: inherited.map(strip), foreign: foreign.map(strip) };
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
  check('the launcher is CLAUDE_PID, and nothing else',
    launcherFromEnviron(nul('HOME=/h', 'CLAUDE_PID=3843700', 'X=1')) === 3843700
      && launcherFromEnviron(nul('HOME=/h')) === null
      && launcherFromEnviron(nul('CLAUDE_PID=1')) === null
      && launcherFromEnviron(nul('CLAUDE_PID=abc')) === null);
  const claude = [1, 'claude', '/home/u/.local/share/claude/versions/2.1.284'];
  const table = new Map([[100, claude], [200, claude], [300, [1, 'bash', '/usr/bin/bash']]]);
  const entryOf = (pid) => table.get(pid) ?? null;
  const at = (pid, launcher) => ({ pid, role: 'implement', issue: 389, outputFile: null, liveFile: null, promptFile: null, launcher });
  const sorted = classifyDispatches([
    at(1, 100), // own
    at(2, 200), // another live session
    at(3, 999), // launcher dead
    at(4, 300), // launcher pid reused by a non-Claude process
    at(5, null), // launcher unknown
  ], { owner: 100, entryOf });
  check('a dispatch whose launcher is gone is inherited; own, live-owned and unknown ones are not',
    sorted.inherited.map((d) => d.pid).join(',') === '3,4'
      && sorted.foreign.map((d) => d.pid).join(',') === '2,5');
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
