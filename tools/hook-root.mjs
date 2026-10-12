#!/usr/bin/env node
// autoloop — hook-root.mjs
//
// Where a plugin hook acts, and whether it acts at all. Hooks ship in the
// plugin (hooks/hooks.json) and fire in every session the user opens, so
// each one finds the project from CLAUDE_PROJECT_DIR — never from its own
// location, which is the plugin directory.
//
// A hook acts only for the session that owns the run (run-markers.mjs
// ownedRun): its Claude process's open latch names the conversation in the
// hook's input. Without it every hook does nothing — no output, no git, no
// GitHub, no file — whatever the repository holds. Prime, setup and doctor
// ask activeAutoloopRoot instead: whether the repository is devendored
// (`.autoloop/config.json` present, or unreadable: the resolver then refuses).
//
//   node <plugin-tools>/hook-root.mjs --self-test

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, PROJECT_CONFIG_FILE, repositoryRoot } from './config-contract.mjs';
import { ownedRun, processStart, sessionOwnerPid } from './run-markers.mjs';

const VENDORED_DIR = 'tools/agentic';

// Every file the plugin ever vendored into tools/agentic/: each name ever under
// templates/tools (now tools) in this repository's history, plus the executor's installed
// name. A repository's own files there (a gate script) are not in it, and
// nothing outside it is ever treated as the tool's.
export const VENDORED_TOOL_NAMES = Object.freeze([
  'adapter-contract.mjs',
  'api-shape.mjs',
  'attestation-contract.mjs',
  'auto-merge.mjs',
  'auto-merge.reference.mjs',
  'briefs/code-review.md',
  'briefs/diff-review.md',
  'briefs/doubt-review.md',
  'briefs/fix.md',
  'briefs/implement.md',
  'briefs/plan-review.md',
  'briefs/plan.md',
  'briefs/simplify.md',
  'checkout-contract.mjs',
  'claim-contract.mjs',
  'command-guard.mjs',
  'config-contract.mjs',
  'continuation-store.mjs',
  'contract-lint.mjs',
  'delivery-contract.mjs',
  'dispatch-render.mjs',
  'dispatch-stream.sh',
  'dispatch.mjs',
  'edit-guard.mjs',
  'escalate-paths.mjs',
  'guard-corpus.json',
  'hook-relay.mjs',
  'hook-root.mjs',
  'intent-contract.mjs',
  'label-swap-reminder.mjs',
  'lane-contract.mjs',
  'lifecycle-contract.mjs',
  'lifecycle-driver.mjs',
  'loop-scope.mjs',
  'loop-smoke.mjs',
  'measurement-contract.mjs',
  'merge-authorization-contract.mjs',
  'overlap-report.mjs',
  'prime.mjs',
  'publish-verdict.mjs',
  'regression-index.mjs',
  'release-verify.mjs',
  'review-contract.mjs',
  'route-adapter-contract.mjs',
  'run-scope.mjs',
  'runtime-contract.mjs',
  'scaffold.mjs',
  'scan.mjs',
  'self-test-manifest.json',
  'session-preflight.sh',
  'setup.mjs',
  'sizing-contract.mjs',
  'snapshot-contract.mjs',
  'stats.mjs',
  'step-subject.mjs',
  'step.mjs',
  'subagent-transcript.mjs',
  'unit.mjs',
  'verify.mjs',
  'writeback-check.mjs',
]);

// A hook command that runs a vendored tool.
export function runsVendoredTool(command) {
  const text = String(command ?? '');
  return VENDORED_TOOL_NAMES.some((name) => text.includes(`${VENDORED_DIR}/${name}`));
}

function hookCommands(root, file) {
  let document;
  try {
    document = JSON.parse(readFileSync(join(root, file), 'utf8'));
  } catch {
    return [];
  }
  return Object.values(document?.hooks ?? {}).flatMap((groups) => (Array.isArray(groups) ? groups : [])
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((handler) => String(handler?.command ?? '')));
}

function filesUnder(directory, prefix = '') {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

// What of the vendored layout is still in a repository: shipped files under
// tools/agentic/ and hook commands running them, in either settings file.
export function vendoredLeftovers(root) {
  return {
    files: filesUnder(join(root, VENDORED_DIR)).filter((name) => VENDORED_TOOL_NAMES.includes(name)),
    hooks: ['.claude/settings.json', '.claude/settings.local.json'].flatMap((file) =>
      hookCommands(root, file).filter(runsVendoredTool).map((command) => ({ file, command }))),
  };
}

export function hookRoot(env = process.env, cwd = process.cwd()) {
  return repositoryRoot(typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== ''
    ? resolve(env.CLAUDE_PROJECT_DIR)
    : cwd);
}

// Only a missing file is absent (the resolver's rule): an inaccessible
// `.autoloop/` keeps the hooks active so the guard refuses rather than sleeps.
function configPresent(root) {
  try {
    lstatSync(join(root, PROJECT_CONFIG_FILE));
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

export function activeAutoloopRoot(root = hookRoot()) {
  return configPresent(root) ? root : null;
}

// Where a plugin hook acts: the project root, for the session that owns a
// run, whatever the checkout now says; null for every other session, decided
// before the project root is looked up (that costs a git call).
export function guardedRoot(sessionId) {
  const owned = ownedRun({ sessionId });
  return owned === null || owned.unreadable ? null : hookRoot();
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hook-root-')));
  try {
    const repo = join(scratch, 'repo');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    spawnSync('git', ['init', '-q', repo]);
    check('CLAUDE_PROJECT_DIR is the root, whatever the cwd',
      hookRoot({ CLAUDE_PROJECT_DIR: repo }, join(repo, 'src', 'deep')) === repo);
    // A session started in a subdirectory still guards the repository prime
    // opened its run in.
    check('CLAUDE_PROJECT_DIR in a subdirectory resolves to its git top level',
      hookRoot({ CLAUDE_PROJECT_DIR: join(repo, 'src', 'deep') }, scratch) === repo);
    check('without CLAUDE_PROJECT_DIR, a subdirectory cwd resolves to the git top level',
      hookRoot({}, join(repo, 'src', 'deep')) === repo);
    check('an unrelated repository is inactive', activeAutoloopRoot(repo) === null);
    mkdirSync(join(repo, '.autoloop'));
    writeFileSync(join(repo, '.autoloop', 'config.json'), '{}');
    check('a devendored autoloop repository is active', activeAutoloopRoot(repo) === repo);
    mkdirSync(join(repo, '.claude'));
    // The one definition of what is left of the vendored layout: shipped
    // files and hooks running them — never a repository's own gate script.
    mkdirSync(join(repo, 'tools', 'agentic', 'briefs'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'agentic', 'gate.mjs'), '// the repository\'s own\n');
    writeFileSync(join(repo, 'tools', 'agentic', 'briefs', 'plan.md'), '# plan\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash(node tools/agentic/prime.mjs --json)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node tools/agentic/writeback-check.mjs' },
        { type: 'command', command: 'node tools/agentic/gate.mjs' }] }] },
    }));
    const leftovers = vendoredLeftovers(repo);
    check('vendored leftovers are the shipped files and the hooks that run them, nothing of the repository\'s own',
      JSON.stringify(leftovers.files) === '["briefs/plan.md"]'
        && JSON.stringify(leftovers.hooks.map(({ command }) => command)) === '["node tools/agentic/writeback-check.mjs"]');
    rmSync(join(repo, 'tools'), { recursive: true, force: true });
    rmSync(join(repo, '.claude', 'settings.local.json'));
    // The shell hooks ask the same question through the CLI, with the hook's
    // input on stdin.
    const home = join(scratch, 'home');
    const owner = sessionOwnerPid(process.pid);
    mkdirSync(join(home, '.claude', 'autoloop', 'run-latches'), { recursive: true });
    writeFileSync(join(home, '.claude', 'autoloop', 'run-latches', `${owner}.json`), JSON.stringify({
      version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', scope: repo, sessionId: 'S',
    }));
    const cli = (input) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--guarded-root'], {
      input, encoding: 'utf8', cwd: tmpdir(), timeout: 15000, env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repo },
    });
    const ownerCli = cli('{"session_id":"S"}');
    const others = [cli('{"session_id":"T"}'), cli('')];
    check('--guarded-root prints the root for the owning session and exits 0, else exits 1 silently',
      ownerCli.status === 0 && ownerCli.stdout.trim() === repo
        && others.every((result) => result.status === 1 && result.stdout === ''));
    rmSync(join(repo, '.autoloop'), { recursive: true, force: true });
    writeFileSync(join(repo, '.autoloop'), 'not a directory');
    check('an inaccessible config path keeps the hooks active (the resolver refuses)',
      activeAutoloopRoot(repo) === repo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  sessionOwnershipCases(check);
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

// Every hook entry point, as the host runs it, in a repository with
// .autoloop/config.json: a session that does not own a run sees no hook
// effect and pays no git or GitHub call; the owning session keeps them all.
// Counting shims stand in for gh and git, and HOME is the fixture's.
function sessionOwnershipCases(check) {
  const tools = dirname(fileURLToPath(import.meta.url));
  const realGit = (process.env.PATH ?? '').split(':').map((dir) => join(dir, 'git'))
    .find((path) => spawnSync(path, ['--version'], { timeout: 5000 }).status === 0);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hook-ownership-')));
  const readers = [];
  try {
    const bin = join(scratch, 'bin');
    const log = join(scratch, 'calls.log');
    mkdirSync(bin);
    writeFileSync(log, '');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "git $*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const home = join(scratch, 'home');
    const latches = join(home, '.claude', 'autoloop', 'run-latches');
    const config = JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' } });
    const repository = (name) => {
      const dir = join(scratch, name);
      spawnSync(realGit, ['init', '-q', '-b', 'main', dir], { timeout: 10000 });
      mkdirSync(join(dir, '.autoloop'));
      writeFileSync(join(dir, '.autoloop', 'config.json'), config);
      writeFileSync(join(dir, '.autoloop', 'STATE.md'), '# STATE\nSTATE-PROSE-MARK\n');
      return dir;
    };
    const repo = repository('repo');
    const stalled = repository('stalled');
    rmSync(join(stalled, '.git', 'config'));
    spawnSync('mkfifo', [join(stalled, '.git', 'config')], { timeout: 5000 });
    const transcript = join(scratch, 'child.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    const env = (project = repo) => ({
      ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'), CLAUDE_CODE_SESSION_ID: '', AUTOLOOP_GUARD_BUDGET_MS: '3000',
    });
    const run = (args, input, project) => spawnSync(args[0], args.slice(1), {
      input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: project ?? repo,
      env: env(project), timeout: 20000, killSignal: 'SIGKILL',
    });
    const node = (tool, input, project) => run([process.execPath, join(tools, tool)], input, project);
    const calls = () => readFileSync(log, 'utf8');
    const owner = sessionOwnerPid(process.pid);
    const latch = (fields) => {
      rmSync(latches, { recursive: true, force: true });
      if (fields === null) return;
      mkdirSync(latches, { recursive: true });
      writeFileSync(join(latches, `${owner}.json`), JSON.stringify({
        version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', scope: repo, latchedAtMs: 1, sessionId: 'S', ...fields,
      }));
    };
    const reader = () => {
      if (process.platform !== 'linux') return;
      readers.push(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'dispatch.mjs', '--role', 'diff-review'], { cwd: repo, stdio: 'ignore' }));
    };
    const bash = (command, session = 'S') => node('command-guard.mjs', { session_id: session, tool_name: 'Bash', cwd: repo, tool_input: { command } });
    const edit = (filePath, project) => node('edit-guard.mjs', { session_id: 'S', tool_name: 'Edit', cwd: project ?? repo, tool_input: { file_path: filePath } }, project);
    const transcripts = join(repo, '.git', 'autoloop', 'subagent-transcripts');
    const hooks = {
      preflight: () => run(['bash', join(tools, 'session-preflight.sh')], { session_id: 'S', hook_event_name: 'SessionStart', source: 'startup' }),
      rider: () => node('label-swap-reminder.mjs', { session_id: 'S', tool_name: 'Bash', tool_input: { command: 'gh issue edit 4 --add-label loop-blocked' } }),
      transcript: () => node('subagent-transcript.mjs', { session_id: 'S', hook_event_name: 'SubagentStop', transcript_path: transcript }),
      stop: () => node('writeback-check.mjs', { session_id: 'S', hook_event_name: 'Stop', stop_hook_active: false }),
    };
    reader();
    // An unreadable payload names no session: beside this process's open
    // latch it may be the owner's, so the guard refuses it as its crash
    // fallback does; with no open latch it is allowed.
    const notOwned = (variant, openLatchHeld) => {
      writeFileSync(log, '');
      const preflight = hooks.preflight();
      const stop = hooks.stop();
      const unreadable = node('command-guard.mjs', 'not json').status;
      const verdicts = [
        bash('rm -rf .git/autoloop/run'), bash(`echo ${'x'.repeat(70 * 1024)}`), bash('git switch main'),
        { status: unreadable === (openLatchHeld ? 2 : 0) ? 0 : 1 },
        node('command-guard.mjs', { session_id: 'S', tool_name: 'AskUserQuestion', tool_input: {} }),
        node('command-guard.mjs', { session_id: 'S', tool_name: 'Bash', cwd: stalled, tool_input: { command: 'ls' } }, stalled),
        edit(join(latches, 'x.json')), edit(join(repo, '.claude', 'settings.json')), edit(join(stalled, 'a.txt'), stalled),
      ].map((result) => result.status);
      const rider = hooks.rider();
      const captured = hooks.transcript();
      return {
        [`${variant}: no preflight, no STATE injection, no Stop output`]: preflight.status === 0 && preflight.stdout === ''
          && stop.status === 0 && stop.stdout === '' && stop.stderr === '',
        [`${variant}: the guards allow run-state edits, a large command, a branch switch beside a reviewer and a stalled git; an unreadable payload only beside no open latch`]:
          verdicts.every((status) => status === 0),
        [`${variant}: no rider and no transcript copy`]: rider.stdout === '' && captured.status === 0 && !existsSync(transcripts),
        [`${variant}: no gh or git call and no reminder file`]: calls() === '' && !existsSync(join(repo, '.git', 'autoloop', 'draft-reminders')),
      };
    };
    const variants = [
      ['no latch', null],
      ['another conversation after /clear', { sessionId: 'S-before-clear' }],
      ['a closed run', { closedAt: '2026-10-12T00:00:00.000Z' }],
      ['a reused pid', { ownerStart: 'another-process' }],
    ];
    for (const [variant, fields] of variants) {
      latch(fields);
      const held = fields !== null && fields.closedAt === undefined && fields.ownerStart === undefined;
      for (const [name, passed] of Object.entries(notOwned(variant, held))) check(`a session that owns no run, ${name}`, passed);
    }
    latch(null);
    const prime = join(tools, 'prime.mjs');
    const other = join(scratch, 'other');
    spawnSync(realGit, ['init', '-q', other], { timeout: 10000 });
    const primeCompound = bash(`node ${prime} --json && rm -rf .git/autoloop/run`);
    const foreignPrime = run([process.execPath, join(tools, 'command-guard.mjs')],
      { session_id: 'S', tool_name: 'Bash', cwd: repo, tool_input: { command: `node ${prime} --json` } }, other);
    check('without a run, the guard still refuses a prime compound that deletes run state, and a prime in a foreign repository',
      primeCompound.status === 2 && primeCompound.stderr.includes('opens a run')
        && foreignPrime.status === 2 && foreignPrime.stderr.includes('outside it'));
    latch({});
    writeFileSync(log, '');
    const preflight = hooks.preflight();
    const stop = hooks.stop();
    const stopCalls = calls();
    const rider = hooks.rider();
    hooks.transcript();
    check('the owning session keeps the preflight and STATE, the Stop check, the rider and the transcript copy',
      preflight.stdout.includes('## autoloop preflight') && preflight.stdout.includes('STATE-PROSE-MARK')
        && stopCalls.includes('gh pr list') && stop.stdout.includes('no GitHub data was reachable')
        && rider.stdout.includes('PushNotification') && existsSync(transcripts) && readdirSync(transcripts).length === 2);
    check('the owning session keeps both guards: run state, a branch switch beside a reviewer, an unreadable payload',
      bash('rm -rf .git/autoloop/run').status === 2 && edit(join(latches, 'x.json')).status === 2
        && (process.platform !== 'linux' || bash('git switch main').stderr.includes('reading this checkout'))
        && node('command-guard.mjs', 'not json').status === 2
        && bash('rm -rf .git/autoloop/run', 'S-before-clear').status === 0);
  } finally {
    for (const child of readers) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  }
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
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  // For the shell hooks (session-preflight): the root a hook acts in, or
  // exit 1. The hook's input arrives on stdin, as it does for every hook.
  if (process.argv.includes('--guarded-root')) {
    let sessionId;
    try {
      sessionId = JSON.parse(readFileSync(0, 'utf8'))?.session_id;
    } catch { /* no hook input: no session, so no owner */ }
    const root = guardedRoot(sessionId);
    if (root !== null) console.log(root);
    process.exit(root === null ? 1 : 0);
  }
  console.error('usage: hook-root.mjs --guarded-root | --self-test');
  process.exit(2);
}
