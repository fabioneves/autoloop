#!/usr/bin/env node
// Shared execution admission and registered worker tool entry tests.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestorChain, procEntry, workerGuardClaims, workerGuardDirectory, workerGuardProcessKey, executionProtectedPaths, toolGuardFallbackProblem as fallbackToolProblem } from './run-markers.mjs';
import { boundedGit } from './git-budget.mjs';
// The hook bootstrap must remain loadable if a primary guard's scheduler/prime
// dependency fails before payload parsing. Load that graph only inside its try.
const bootstrap = process.argv[2] === '--guard-entry';
let scheduler = bootstrap ? null : await import('./scheduler-contract.mjs');

// The immutable runtime locator names a known process, but the current lease
// and checkpoint must corroborate the complete attempt before tools are admitted.
export function workerToolContext({ sessionId, cwd, workerDirectory = workerGuardDirectory(), startPid = process.ppid } = {}) {
  const identities = [];
  const unverifiedPids = [];
  for (const pid of new Set([startPid, ...ancestorChain(startPid, procEntry)])) {
    try { identities.push(scheduler.readProcessIdentity(pid)); }
    catch { unverifiedPids.push(pid); }
  }
  const found = workerGuardClaims(identities, { directory: workerDirectory, unverifiedPids });
  if (found.unreadable) return found;
  if (found.length === 0) return null;
  try {
    const records = [...new Map(found.map((claim) => [scheduler.schedulerDigest(claim.record), claim])).values()];
    assert.equal(records.length, 1, 'The process has more than one worker attempt.');
    const { record, identity } = records[0];
    assert.deepEqual(Object.keys(record).sort(), ['baseBranch', 'pinsDigest', 'repository', 'schema', 'worker']);
    assert.equal(record.schema, 'autoloop.worker-guard/1');
    const { worker } = record;
    assert([worker.process, worker.groupLeader].some((process) => scheduler.schedulerDigest(process) === scheduler.schedulerDigest(identity)));
    assert.equal(worker.sessionId, sessionId, 'The worker hook names another session.');
    const repository = scheduler.resolveRepository(record.repository.coordinatorRoot);
    assert.deepEqual(repository, record.repository);
    const held = scheduler.readSchedulerOwner(repository);
    assert.equal(held.state, 'alive', 'The worker scheduler owner is not live.');
    assert.equal(held.released, false);
    assert.equal(held.lease.runId, worker.runId);
    assert.equal(held.lease.generation, worker.generation);
    const checkpoint = scheduler.readCheckpoint(repository, worker.runId);
    assert.equal(checkpoint.generation, worker.generation);
    assert.equal(checkpoint.pinsDigest, record.pinsDigest);
    const current = checkpoint.workers.find((item) => item.attemptId === worker.attemptId);
    assert.deepEqual(current, worker, 'The worker binding changed or ended.');
    assert(!['stopped', 'failed'].includes(checkpoint.state) && checkpoint.desiredState !== 'stopped' && !worker.cancelledByOperator);
    assert.equal(scheduler.boundGroupState(worker), 'alive', 'The worker group cannot be verified.');
    const pins = scheduler.readPins(repository, worker.runId);
    scheduler.assertPinsLive(repository, pins);
    assert.equal(pins.baseBranch, record.baseBranch);
    const git = boundedGit(['-C', cwd, 'rev-parse', '--absolute-git-dir']);
    assert.equal(git.status, 0, 'The worker checkout cannot be verified.');
    assert.equal(realpathSync(git.stdout.trim()), worker.worktreeGitDir, 'The hook names another worker checkout.');
    return { worker, repository, baseBranch: record.baseBranch, directory: workerDirectory, path: records[0].path };
  } catch (error) {
    return { unreadable: true, path: found[0].path, message: error.message };
  }
}

export { toolGuardFallbackProblem as fallbackToolProblem } from './run-markers.mjs';
async function runGuardEntry(kind) {
  // Keep the complete input only in this process's memory. No transcript,
  // environment handoff or temporary file contains the tool payload.
  const inputText = readFileSync(0, 'utf8');
  let payload = null;
  try { payload = JSON.parse(inputText); } catch { /* ownership decides failure */ }
  try {
    scheduler ??= await import('./scheduler-contract.mjs');
    const module = await import(kind === 'command' ? './command-guard.mjs' : './edit-guard.mjs');
    if (kind === 'command') module.runCommandGuard({ inputText, argv: [] });
    else module.runEditGuard({ inputText });
  } catch {
    const reason = fallbackToolProblem(payload, { entrypoint: join(dirname(fileURLToPath(import.meta.url)), `${kind}-guard.mjs`) });
    if (reason !== null) { console.error(reason); process.exit(2); }
    process.exit(0);
  }
}

async function selfTest() {
  const prime = await import('./prime.mjs');
  const { CONFIG_VERSION, resolveConfigText } = await import('./config-contract.mjs');
  const { DEFAULT_MODELS, mergeModels } = await import('./models-config.mjs');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-execution-admission-')));
  const fixtureAccount = await scheduler.createSchedulerTestAccount(scratch);
  const cases = [];
  const check = async (name, run) => {
    try { await run(); cases.push([name, true]); }
    catch (error) { cases.push([name, false]); console.error(`FAIL ${name}: ${error.stack}`); }
  };
  const git = (root, args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  };
  const repository = () => {
    const root = join(scratch, randomUUID());
    mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    return scheduler.resolveRepository(root);
  };
  const pinsOf = (repo) => scheduler.createPins(repo, {
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))), enginePath: process.execPath,
    config: resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config,
    models: mergeModels(DEFAULT_MODELS),
  });
  const legacy = (repo, sessionId = randomUUID()) => prime.openLegacyRun({ root: repo.coordinatorRoot,
    owner: process.pid, sessionId, baseBranch: 'main', latches: join(scratch, 'latches', sessionId) });
  const start = (repo, pins = pinsOf(repo)) => scheduler.acquireScheduler(repo, pins,
    { kind: 'terminal', sessionId: null, process: scheduler.readProcessIdentity() });
  const stop = (repo, acquired) => {
    const current = scheduler.readCheckpoint(repo, acquired.runId);
    scheduler.commitTransition(acquired.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
    scheduler.releaseScheduler(acquired.lease);
  };
  try {
    await check('upgraded legacy start and status keep ordinary 0775 Git-admin compatibility without chmod', async () => {
      const repo = repository(); const { chmodSync, existsSync, lstatSync } = await import('node:fs'); chmodSync(repo.commonDir, 0o775);
      const admission = join(fixtureAccount.accountHome, '.claude', 'autoloop', 'execution-admission', repo.repositoryKey);
      assert.equal(scheduler.readCurrentCheckpoint(repo), null);
      assert.equal(scheduler.readSchedulerOwner(repo).state, 'absent');
      const { statusJson } = await import('./status.mjs');
      assert.equal(statusJson({ root: repo.coordinatorRoot, session: randomUUID() }).error, undefined);
      assert.equal(existsSync(admission), false, 'A legacy status read must not create admission authority.');
      const result = legacy(repo);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(lstatSync(repo.commonDir).mode & 0o777, 0o775);
      assert.equal(existsSync(join(repo.commonDir, 'autoloop', 'scheduler')), false, 'Legacy admission must not create daemon storage.');
    });
    await check('a legacy start publishes under common admission and prevents daemon acquisition', () => {
      const repo = repository();
      const result = legacy(repo);
      assert.equal(result.ok, true);
      assert.throws(() => start(repo), (error) => error.code === 'LEGACY_RUN_ACTIVE' && error.owner?.pid === process.pid);
      const marker = JSON.parse(readFileSync(result.runMarker, 'utf8'));
      assert.equal(marker.sessionId, result.sessionId);
      assert.deepEqual(marker.owner, scheduler.readProcessIdentity());
      assert(marker.pids.includes(process.pid));
    });
    await check('a held daemon fence prevents legacy starts through linked worktree and symlink aliases', () => {
      const repo = repository();
      const linked = join(scratch, randomUUID());
      git(repo.coordinatorRoot, ['worktree', 'add', '-q', '-b', 'linked', linked]);
      const alias = join(scratch, randomUUID()); symlinkSync(linked, alias);
      const acquired = start(repo);
      const pinPath = join(repo.commonDir, 'autoloop', 'scheduler', 'runs', acquired.runId, 'pins.json');
      const originalPins = readFileSync(pinPath);
      for (const root of [repo.coordinatorRoot, linked, alias]) {
        const result = legacy(scheduler.resolveRepository(root));
        assert.equal(result.error?.code, 'SCHEDULER_ACTIVE');
        assert.deepEqual(result.error.owner, scheduler.readProcessIdentity());
        assert.equal(result.error.runId, acquired.runId);
        assert.deepEqual(readFileSync(pinPath), originalPins);
      }
      prime.closeRun(repo.coordinatorRoot, { directory: join(scratch, 'unowned') });
      assert.equal(scheduler.readSchedulerOwner(repo).state, 'alive');
      stop(repo, acquired);
      assert.equal(legacy(repo).ok, true);
    });
    await check('legacy admission waits for leased prepared-intent accounting', () => {
      const repo = repository(); const pins = pinsOf(repo); const acquired = start(repo, pins);
      scheduler.commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const operationId = randomUUID();
      scheduler.prepareEffect(acquired.lease, 2, { operationId, requestId: null, runId: pins.runId, unitId: null, unitGeneration: null,
        kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: scheduler.schedulerDigest({ unstarted: true }),
        expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
      stop(repo, acquired);
      assert.equal(legacy(repo).error?.code, 'SCHEDULER_ACTIVE');
      const resumed = start(repo, pins);
      scheduler.abandonPreparedEffect(resumed.lease, operationId); stop(repo, resumed);
      assert.equal(legacy(repo).ok, true);
      assert.equal(scheduler.readCheckpoint(repo, pins.runId).outbox[operationId].error.code, 'STOPPED_BEFORE_LAUNCH');
    });
    await check('a live legacy dispatch in a linked worktree refuses daemon admission after its launcher has ended', async () => {
      if (process.platform !== 'linux') { console.log('capability skip: legacy dispatch inventory requires /proc'); return; }
      const repo = repository(); const linked = join(scratch, randomUUID());
      git(repo.coordinatorRoot, ['worktree', 'add', '-q', '-b', 'legacy-worker', linked]);
      const entry = join(scratch, 'dispatch.mjs');
      // A real retained process with the recorded legacy command shape. This
      // instrumentation exercises process inventory, not an alternate gate.
      writeFileSync(entry, 'process.send("ready"); setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [entry, '--role', 'implement', '--issue', '1'], {
        cwd: linked, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, CLAUDE_PID: '2147483647' },
      });
      try {
        await new Promise((done) => child.once('message', done));
        assert.throws(() => start(repo), (error) => error.code === 'LEGACY_RUN_ACTIVE' && error.workerPid === child.pid);
      } finally {
        const closed = new Promise((done) => child.once('close', done)); child.kill('SIGTERM'); await closed;
      }
      stop(repo, start(repo));
    });
    await check('a dead daemon needs recovery and cannot be replaced by a legacy prime', () => {
      const repo = repository(); const pins = pinsOf(repo);
      const script = `import * as core from ${JSON.stringify(new URL('./scheduler-contract.mjs', import.meta.url).href)};
        const repo = core.resolveRepository(process.argv[1]); core.acquireScheduler(repo, JSON.parse(process.argv[2]),
          { kind: 'terminal', sessionId: null, process: core.readProcessIdentity() });`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, repo.coordinatorRoot, JSON.stringify(pins)], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(scheduler.readSchedulerOwner(repo).state, 'dead');
      assert.equal(legacy(repo).error?.code, 'SCHEDULER_ACTIVE');
    });
    await check('dead and reused legacy owners permit start; malformed and missing identities do not become dead', () => {
      for (const mode of ['dead', 'reused', 'malformed', 'unknown', 'missing']) {
        const repo = repository();
        const directory = join(repo.commonDir, 'autoloop', 'run'); mkdirSync(directory, { recursive: true });
        const owner = scheduler.readProcessIdentity();
        if (mode === 'dead') owner.pid = 2147483647;
        if (mode === 'reused') {
          // Keep the OS format: Linux ticks or macOS ps lstart in C/UTC.
          const oldStart = owner.bootId.startsWith('darwin:') ? 'Mon Jan 1 00:00:00 1990' : '0';
          assert.notEqual(oldStart, owner.start);
          owner.start = oldStart;
          assert.equal(scheduler.processIdentityState(owner), 'dead');
        }
        if (mode === 'malformed') owner.start = 'NaN';
        if (mode === 'unknown') owner.start = null;
        if (mode === 'missing') delete owner.start;
        writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ version: 1, pids: [owner.pid], starts: { [owner.pid]: owner.start }, owner, sessionId: randomUUID() }));
        if (['malformed', 'unknown', 'missing'].includes(mode)) {
          assert.throws(() => start(repo), (error) => error.code === 'OWNER_UNVERIFIED');
          assert.equal(scheduler.readCurrentCheckpoint(repo), null);
          assert.equal(scheduler.readSchedulerOwner(repo).state, 'absent');
        } else stop(repo, start(repo));
      }
    });
    await check('a contender cannot pass ownership checks while the other holds admission, in either direction', async () => {
      for (const first of ['legacy', 'daemon']) {
        const repo = repository(); const pins = pinsOf(repo);
        const release = join(scratch, randomUUID());
        const script = `import * as core from ${JSON.stringify(new URL('./scheduler-contract.mjs', import.meta.url).href)};
          import * as prime from ${JSON.stringify(new URL('./prime.mjs', import.meta.url).href)};
          import { existsSync } from 'node:fs';
          const repo = core.resolveRepository(process.argv[1]); const kind = process.argv[2];
          const observe = () => { process.send({ checked: true }); const until = Date.now() + 15000;
            while (!existsSync(process.argv[6])) { if (Date.now() > until) throw Error('Barrier timeout');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
          process.on('message', () => { try {
            const pause = process.argv[7] === 'hold' ? observe : () => {};
            const result = kind === 'daemon' ? core.acquireScheduler(repo, JSON.parse(process.argv[3]),
              { kind: 'terminal', sessionId: null, process: core.readProcessIdentity() }, { admissionObserve: pause })
              : prime.openLegacyRun({ root: repo.coordinatorRoot, owner: process.pid, sessionId: process.argv[4],
                baseBranch: 'main', latches: process.argv[5], observe: pause });
            process.send(kind === 'daemon' ? { ok: true, owner: core.readProcessIdentity() } : { ok: result.ok, error: result.error, owner: core.readProcessIdentity() });
          } catch (error) { process.send({ ok: false, error: { code: error.code, owner: error.owner } }); } });
          process.send({ ready: true });`;
        const children = [];
        const launch = async (kind, mode) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script, repo.coordinatorRoot, kind, JSON.stringify(pins),
            randomUUID(), join(scratch, randomUUID()), release, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
          children.push(child);
          await new Promise((done) => child.once('message', done)); return child;
        };
        try {
          const holder = await launch(first, 'hold');
          const checked = new Promise((done) => holder.once('message', done)); holder.send('start'); await checked;
          const contender = await launch(first === 'legacy' ? 'daemon' : 'legacy', 'normal');
          let early = null;
          const result = new Promise((done) => contender.once('message', (value) => { early = value; done(value); }));
          contender.send('start');
          await new Promise((done) => setTimeout(done, 250));
          assert.equal(early, null, 'The held gate must prevent ownership establishment.');
          const won = new Promise((done) => holder.once('message', done));
          writeFileSync(release, 'release');
          const winner = await won; const loser = await result;
          assert.equal(winner.ok, true); assert.equal(loser.ok, false);
          assert.deepEqual(loser.error.owner, winner.owner);
          if (first === 'daemon') {
            const pinPath = join(repo.commonDir, 'autoloop', 'scheduler', 'runs', pins.runId, 'pins.json');
            assert.deepEqual(JSON.parse(readFileSync(pinPath, 'utf8')), pins);
          }
        } finally {
          writeFileSync(release, 'release');
          for (const child of children) {
            const closed = new Promise((done) => child.once('close', done)); child.kill('SIGTERM'); await closed;
          }
        }
      }
    });
    await check('no-latch Bash entry rejects direct and known wrapped scheduler/helper operations but permits reads', () => {
      const repo = repository(); const tools = dirname(fileURLToPath(import.meta.url));
      const hook = (command) => spawnSync(process.execPath, [join(tools, 'command-guard.mjs')], {
        input: JSON.stringify({ session_id: randomUUID(), cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command } }),
        cwd: repo.coordinatorRoot, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOME: join(scratch, 'unowned-home'), CLAUDE_PROJECT_DIR: repo.coordinatorRoot },
      });
      const loop = join(tools, 'loop.mjs'); const status = join(tools, 'status.mjs'); const host = join(tools, 'loop-host.mjs');
      const installedTests = join(scratch, '.claude', 'plugins', 'cache', 'autoloop', 'autoloop', 'test-modes');
      mkdirSync(installedTests, { recursive: true });
      symlinkSync(tools, join(installedTests, 'tools'));
      const denied = [
        `node ${loop} start --root ${repo.coordinatorRoot} --operator-terminal --json`,
        `env -u HOME timeout -s TERM 5s node ${loop} run --foreground --operator-terminal --root ${repo.coordinatorRoot}`,
        `sudo -u fixture command node ${loop} pause --root ${repo.coordinatorRoot}`,
        `sh -c 'node ${loop} stop --root ${repo.coordinatorRoot}'`,
        `TOOL=${host}; node "$TOOL"`,
        `env -C ${dirname(tools)} node tools/loop-host.mjs`,
        `env --chdir=${dirname(tools)} node tools/loop-host.mjs`,
        `env --chdir=${repo.coordinatorRoot} node ${host}`,
        `${host}`,
        `node ${join(installedTests, 'tools', 'loop-viewer.mjs')} --fixtures`,
        `node ${join(installedTests, 'tools', 'loop-supervisor.mjs')} --self-test --require-supervision`,
        `node ${join(tools, 'loop-viewer.mjs')} --fixtures --root ${repo.coordinatorRoot}`,
        `node ${join(tools, 'loop-supervisor.mjs')} --self-test --require-supervision --json`,
        `node ${status} --attach --host-request --root ${repo.coordinatorRoot}`,
        `node ${status} --disconnect --host-request --root ${repo.coordinatorRoot}`,
        `node ${status} --control --run ${randomUUID()} --by ui --root ${repo.coordinatorRoot}`,
        `node ${status} --viewer-ended --root ${repo.coordinatorRoot}`,
        `systemctl --user stop autoloop-${repo.repositoryKey}.service`,
        `systemd-run --user --unit=autoloop-${repo.repositoryKey} node ${loop} run --supervised`,
        `echo corrupt > ${repo.commonDir}/autoloop/scheduler/current.json`,
        `cp source ${repo.commonDir}/autoloop/control/v2/requests/f.json`,
        `rm -rf ${repo.commonDir}/autoloop/viewers`,
        `printf forged > ${join(userInfo().homedir, '.claude', 'autoloop', 'host-invocations', 'f.json')}`,
      ];
      for (const command of denied) assert.equal(hook(command).status, 2, command);
      const allowed = [
        `node ${loop} status --root ${repo.coordinatorRoot} --json`,
        `node ${loop} request-status --root ${repo.coordinatorRoot} --run ${randomUUID()} --request ${randomUUID()} --json`,
        `node ${status} --discover --root ${repo.coordinatorRoot}`,
        `node ${status} --json --root ${repo.coordinatorRoot}`,
        `node ${host} --self-test`,
        `node ${join(tools, 'loop-viewer.mjs')} --fixtures`,
        `node ${join(tools, 'loop-supervisor.mjs')} --self-test --require-supervision`,
        `cat ${repo.commonDir}/autoloop/scheduler/current.json`,
        `git -C ${repo.coordinatorRoot} status`,
        `env -C ${repo.coordinatorRoot} git status`,
        `env --chdir=${repo.coordinatorRoot} cat README.md`,
        `systemctl --user status autoloop-${repo.repositoryKey}.service`,
        `node -e 'const x = "loop.mjs start"; console.log(x)'`,
        'rm "$UNKNOWN_UNRELATED_PATH"',
        `printf source > ${join(tools, 'loop-host.mjs')}`,
      ];
      for (const command of allowed) assert.equal(hook(command).status, 0, command);
    });
    await check('no-latch edit entry protects scheduler/control/viewer/host paths with aliases and permits ordinary source work', () => {
      const repo = repository(); const tools = dirname(fileURLToPath(import.meta.url));
      const alias = join(scratch, randomUUID()); symlinkSync(repo.commonDir, alias);
      const installed = join(scratch, '.claude', 'plugins', 'cache', 'autoloop', 'autoloop', 'fixture');
      mkdirSync(installed, { recursive: true }); symlinkSync(tools, join(installed, 'tools'));
      const entry = join(installed, 'tools', 'edit-guard.mjs');
      const hook = (tool_name, target) => spawnSync(process.execPath, [entry], {
        input: JSON.stringify({ session_id: randomUUID(), cwd: repo.coordinatorRoot, tool_name,
          tool_input: tool_name === 'NotebookEdit' ? { notebook_path: target } : { file_path: target } }),
        cwd: repo.coordinatorRoot, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOME: join(scratch, 'unowned-home'), CLAUDE_PROJECT_DIR: repo.coordinatorRoot },
      });
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        for (const target of [join(alias, 'autoloop', 'scheduler', 'runs', randomUUID(), 'checkpoint.json'),
          join(repo.commonDir, 'autoloop', 'control', 'v2', 'requests', 'f.json'),
          join(repo.commonDir, 'autoloop', 'viewers', 'f.json'),
          join(userInfo().homedir, '.claude', 'autoloop', 'host-invocations', 'f.json'),
          join(installed, 'tools', 'loop-host.mjs')]) {
          assert.equal(hook(tool, target).status, 2, `${tool} ${target}`);
        }
        for (const target of [join(tools, 'loop-host.mjs'), join(repo.coordinatorRoot, 'src', 'ordinary.ts'),
          join(repo.coordinatorRoot, '.claude', 'settings.json')]) assert.equal(hook(tool, target).status, 0, `${tool} ${target}`);
      }
    });
    await check('unowned guards resolve linked Git metadata without Git calls and retain denial on malformed metadata', () => {
      const root = join(scratch, 'metadata-repo'); mkdirSync(root);
      const admin = join(scratch, 'separate-admin');
      git(root, ['init', '-q', '-b', 'main', '--separate-git-dir', admin]);
      git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
      const linked = join(scratch, 'metadata-linked'); git(root, ['worktree', 'add', '-q', '-b', 'metadata-linked', linked]);
      const alias = join(scratch, 'metadata-alias'); symlinkSync(linked, alias);
      const observed = spawnSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(observed.status, 0); const linkedAdmin = realpathSync(observed.stdout.trim());
      const bin = join(scratch, 'metadata-bin'); mkdirSync(bin);
      const log = join(scratch, 'metadata-calls.log'); writeFileSync(log, '');
      const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'git\\n' >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o700 });
      const tools = dirname(fileURLToPath(import.meta.url));
      const invoke = (kind, cwd, tool_name, tool_input) => spawnSync(process.execPath, [join(tools, 'loop-execution-admission.mjs'), '--guard-entry', kind], {
        cwd, input: JSON.stringify({ session_id: randomUUID(), cwd, tool_name, tool_input }), encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOME: join(scratch, 'metadata-home'), CLAUDE_PROJECT_DIR: cwd, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      const state = join(admin, 'autoloop', 'scheduler', 'current.json');
      for (const cwd of [root, linked, alias]) {
        assert.equal(invoke('command', cwd, 'Bash', { command: 'git status --porcelain' }).status, 0);
        assert.equal(invoke('edit', cwd, 'Edit', { file_path: join(cwd, 'ordinary.ts') }).status, 0);
        assert.equal(invoke('command', cwd, 'Bash', { command: `printf corrupt > ${state}` }).status, 2);
        assert.equal(invoke('edit', cwd, 'Write', { file_path: state }).status, 2);
      }
      const commonFile = join(linkedAdmin, 'commondir'); const originalCommon = readFileSync(commonFile, 'utf8');
      const physicalHop = join(admin, 'physical', 'hop'); mkdirSync(physicalHop, { recursive: true });
      symlinkSync(physicalHop, join(linkedAdmin, 'metadata-hop'));
      writeFileSync(commonFile, 'metadata-hop/../..\n');
      assert(executionProtectedPaths({ projectRoot: linked, cwd: linked }).state.includes(join(admin, 'autoloop', 'scheduler')),
        'A symlink is resolved before its following parent components.');
      for (const damaged of ['not-a-directory\n', '']) {
        writeFileSync(commonFile, damaged);
        assert.equal(invoke('command', linked, 'Bash', { command: `printf corrupt > ${state}` }).status, 2);
        assert.equal(invoke('edit', linked, 'Write', { file_path: state }).status, 2);
        assert.equal(invoke('edit', linked, 'Write', { file_path: join(userInfo().homedir, '.claude', 'autoloop', 'host-invocations', 'f.json') }).status, 2);
        assert.equal(invoke('edit', linked, 'Edit', { file_path: join(linked, 'ordinary.ts') }).status, 0);
      }
      writeFileSync(commonFile, originalCommon);
      const savedCommon = `${commonFile}.saved-fixture`; renameSync(commonFile, savedCommon);
      assert.equal(spawnSync('mkfifo', [commonFile], { encoding: 'utf8', timeout: 5000 }).status, 0);
      const fifoAt = Date.now();
      assert.equal(invoke('edit', linked, 'Write', { file_path: state }).status, 2);
      assert.equal(invoke('command', linked, 'Bash', { command: 'git status' }).status, 0);
      assert(Date.now() - fifoAt < 8000, 'An unreadable nonregular Git pointer must not block the guard.');
      renameSync(commonFile, `${commonFile}.fifo-fixture`); renameSync(savedCommon, commonFile);
      const gitFile = join(linked, '.git'); const originalGitFile = readFileSync(gitFile, 'utf8');
      writeFileSync(gitFile, 'malformed Git pointer\n');
      assert.equal(invoke('edit', linked, 'Write', { file_path: state }).status, 2);
      assert.equal(invoke('command', linked, 'Bash', { command: `node ${join(tools, 'loop-host.mjs')}` }).status, 2);
      writeFileSync(gitFile, originalGitFile);
      assert.equal(readFileSync(log, 'utf8'), '', 'Unowned guard checks must not call Git.');
    });
    await check('Git diff/log/show output flags are writes, while ordinary unowned output stays allowed without probes', () => {
      const repo = repository(); const tools = dirname(fileURLToPath(import.meta.url));
      const bin = join(scratch, 'output-probe-bin'); mkdirSync(bin);
      const log = join(scratch, 'output-probes.log'); writeFileSync(log, '');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'git\\n' >> '${log}'\nexit 7\n`, { mode: 0o700 });
      const hook = (command) => spawnSync(process.execPath, [join(tools, 'loop-execution-admission.mjs'), '--guard-entry', 'command'], {
        cwd: repo.coordinatorRoot, input: JSON.stringify({ session_id: randomUUID(), cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(scratch, 'output-home'), CLAUDE_PROJECT_DIR: repo.coordinatorRoot,
          PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      for (const verb of ['diff', 'log', 'show']) {
        for (const target of [join(repo.commonDir, 'autoloop', 'scheduler', 'current.json'),
          join(repo.commonDir, 'autoloop', 'control', 'v2', 'requests', 'f.json')]) {
          for (const flag of [`--output=${target}`, `--output ${target}`]) {
            const result = hook(`git ${verb} ${flag}`); assert.equal(result.status, 2, `${verb} ${flag}: ${result.stderr}`);
          }
        }
        for (const flag of ['--output=ordinary.patch', '--output ordinary.patch', '']) {
          assert.equal(hook(`git ${verb} ${flag}`).status, 0, `${verb} ${flag}`);
        }
      }
      assert.equal(readFileSync(log, 'utf8'), '', 'Unowned output classification must not call Git.');
    });
    await check('primary guard syntax failure retains no-latch helper/state denials and permits an unrelated read', () => {
      const repo = repository(); const copied = join(scratch, 'failed-guard-plugin');
      cpSync(dirname(fileURLToPath(import.meta.url)), join(copied, 'tools'), { recursive: true });
      for (const kind of ['command', 'edit']) {
        const primary = join(copied, 'tools', `${kind}-guard.mjs`);
        writeFileSync(primary, `${readFileSync(primary, 'utf8')}\nThis is a deliberate primary guard syntax failure.\n`);
      }
      const invoke = (kind, tool_name, tool_input) => spawnSync(process.execPath,
        [join(copied, 'tools', 'loop-execution-admission.mjs'), '--guard-entry', kind], {
          cwd: repo.coordinatorRoot, input: JSON.stringify({ session_id: randomUUID(), cwd: repo.coordinatorRoot, tool_name, tool_input }),
          encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(scratch, 'bootstrap-home'), CLAUDE_PROJECT_DIR: repo.coordinatorRoot },
        });
      const host = join(copied, 'tools', 'loop-host.mjs');
      for (const command of [`node ${host}`, `env -u HOME timeout 5 node ${host}`, `sh -c 'node ${host}'`,
        `node ${join(copied, 'tools', 'loop.mjs')} start --operator-terminal --root ${repo.coordinatorRoot}`,
        `echo corrupt>${repo.commonDir}/autoloop/scheduler/current.json`]) {
        const result = invoke('command', 'Bash', { command }); assert.equal(result.status, 2, `${command}: ${result.stderr}`);
      }
      for (const command of ['git status --porcelain', 'cat README.md', `node ${join(copied, 'tools', 'loop.mjs')} status --root ${repo.coordinatorRoot}`,
        `node -e 'console.log("loop-host.mjs")'`]) assert.equal(invoke('command', 'Bash', { command }).status, 0, command);
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
        assert.equal(invoke('edit', tool, { [key]: join(repo.commonDir, 'autoloop', 'control', 'v2', 'requests', 'f.json') }).status, 2, tool);
        assert.equal(invoke('edit', tool, { [key]: join(repo.coordinatorRoot, 'ordinary.ts') }).status, 0, tool);
      }
      // The actual outer hook must also retain the payload if its bootstrap
      // cannot load at all. Input stays in memory and is never printed/exported.
      const bootstrapFile = join(copied, 'tools', 'loop-execution-admission.mjs');
      writeFileSync(bootstrapFile, `${readFileSync(bootstrapFile, 'utf8')}\nDeliberate bootstrap syntax failure.\n`);
      const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse;
      const recipe = (kind) => hooks.find((hook) => hook.matcher.includes(kind === 'command' ? 'Bash' : 'Edit')).hooks[0].command;
      const invokeRecipe = (kind, tool_name, tool_input) => spawnSync('sh', ['-c', recipe(kind)], {
        cwd: repo.coordinatorRoot, input: JSON.stringify({ session_id: randomUUID(), cwd: repo.coordinatorRoot, tool_name,
          tool_input: { ...tool_input, opaque: 'fixture-private-payload-value' } }), encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: copied, CLAUDE_PROJECT_DIR: repo.coordinatorRoot, HOME: join(scratch, 'outer-hook-home') },
      });
      for (const command of [`node ${host}`, `env -u HOME timeout 5 node ${host}`,
        `node ${join(copied, 'tools', 'loop.mjs')} start --operator-terminal --root ${repo.coordinatorRoot}`]) {
        const result = invokeRecipe('command', 'Bash', { command });
        assert.equal(result.status, 2, `${command}: ${result.stderr}`);
        assert(!result.stderr.includes('fixture-private-payload-value') && !result.stdout.includes('fixture-private-payload-value'));
      }
      assert.equal(invokeRecipe('command', 'Bash', { command: 'git status --porcelain' }).status, 0);
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
        assert.equal(invokeRecipe('edit', tool, { [key]: join(repo.commonDir, 'autoloop', 'scheduler', 'current.json') }).status, 2);
        assert.equal(invokeRecipe('edit', tool, { [key]: join(repo.coordinatorRoot, 'ordinary.ts') }).status, 0);
      }
    });
    await check('registered worker attempts remain guarded when the guard throws or its bootstrap cannot load', async () => {
      const workerHome = join(scratch, 'worker-account');
      const workerDirectory = join(workerHome, '.claude', 'autoloop', 'worker-bindings');
      const shim = join(scratch, 'worker-account-api.mjs');
      writeFileSync(shim, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
        const original = os.userInfo; os.userInfo = (...args) => ({ ...original(...args), homedir: ${JSON.stringify(workerHome)} });
        os.homedir = () => ${JSON.stringify(workerHome)}; syncBuiltinESMExports();`);
      const copied = join(scratch, 'worker-failed-bootstrap');
      cpSync(dirname(fileURLToPath(import.meta.url)), join(copied, 'tools'), { recursive: true });
      const bootstrapFile = join(copied, 'tools', 'loop-execution-admission.mjs');
      writeFileSync(bootstrapFile, `${readFileSync(bootstrapFile, 'utf8')}\nDeliberate worker bootstrap syntax failure.\n`);
      const wiring = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse;
      const recipeOf = (kind) => wiring.find((hook) => hook.matcher.includes(kind === 'edit' ? 'Edit' : 'Bash')).hooks[0].command;
      const fakeClaude = join(scratch, 'claude'); copyFileSync(realpathSync(process.execPath), fakeClaude);
      const entry = join(scratch, 'guard-entry.mjs');
      writeFileSync(entry, `const api = await import(process.argv[2]);
        const observe = () => { if (process.argv[5] === 'throw') throw new Error('OS guard failure fixture'); };
        if (process.argv[3] === 'edit') api.runEditGuard({ workerDirectory: process.argv[4], observe });
        else api.runCommandGuard({ workerDirectory: process.argv[4], argv: [], observe });`);
      const script = `import { spawnSync } from 'node:child_process';
        process.title = 'claude'; const core = await import(process.argv[1]); process.send(core.readProcessIdentity());
        process.on('message', ({ payload, entry, guard, kind, directory, fault, recipe, shim, copied }) => {
          const env = { ...process.env, CLAUDE_PROJECT_DIR: payload.cwd, HOME: process.argv[2], AUTOLOOP_WORKER: 'writer', CLAUDE_CODE_SESSION_ID: payload.session_id };
          const options = { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, env };
          const result = kind === 'recipe' ? spawnSync('sh', ['-c', recipe], { ...options,
            env: { ...env, NODE_OPTIONS: '--import=' + shim, CLAUDE_PLUGIN_ROOT: copied } })
            : spawnSync(process.execPath, [entry, guard, kind, directory, fault ? 'throw' : 'normal'], options);
          process.send({ status: result.status, stdout: result.stdout, stderr: result.stderr });
        });`;
      for (const posture of ['plan', 'read-only', 'writer']) {
        const repo = repository(); const acquired = start(repo); const sessionId = randomUUID(); const tools = dirname(fileURLToPath(import.meta.url));
        const child = spawn(fakeClaude, ['--input-type=module', '-e', script, new URL('./scheduler-contract.mjs', import.meta.url).href, join(scratch, 'worker-home')], {
          cwd: repo.coordinatorRoot, detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        try {
          const identity = await new Promise((done) => child.once('message', done));
          const attemptId = randomUUID();
          const binding = { schema: 'autoloop.worker-binding/1', runId: acquired.runId, generation: 1, unitId: randomUUID(), unitGeneration: 1,
            attemptId, sessionId, worktreeGitDir: repo.commonDir, process: identity, pgid: identity.pid, groupLeader: identity,
            role: posture === 'plan' ? 'plan' : posture === 'read-only' ? 'code-review' : 'implement', posture, actualModel: 'fixture-worker',
            liveFile: join(repo.commonDir, 'autoloop', 'scheduler', 'runs', acquired.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
          scheduler.registerWorker(acquired.lease, 1, binding, { guardDirectory: workerDirectory });
          const tool = (payload, kind = 'bash', fault = false) => new Promise((done) => {
            child.once('message', done);
            child.send({ payload, entry, guard: new URL(kind === 'edit' ? './edit-guard.mjs' : './command-guard.mjs', import.meta.url).href,
              kind, directory: workerDirectory, fault });
          });
          const recipeCall = (payload, kind) => new Promise((done) => {
            child.once('message', done); child.send({ payload, kind: 'recipe', recipe: recipeOf(kind), copied, shim });
          });
          const bash = (command, session = sessionId, cwd = repo.coordinatorRoot) => tool({ session_id: session, cwd, tool_name: 'Bash', tool_input: { command } });
          const read = await bash('git status --porcelain');
          assert.equal(read.status, 0, read.stderr);
          // Explicit OS-failure instrumentation: the real guard catches a throw,
          // without replacing the first-party ownership predicate.
          assert.equal((await tool({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command: 'git status' } }, 'bash', true)).status, 2);
          assert.equal((await tool({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Edit', tool_input: { file_path: 'source.ts' } }, 'edit', true)).status, 2);
          assert.equal((await recipeCall({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command: 'git status' } }, 'bash')).status, 2);
          assert.equal((await recipeCall({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Edit', tool_input: { file_path: 'ordinary.ts' } }, 'edit')).status, 2);
          const indexPath = join(workerDirectory, workerGuardProcessKey(identity), `${attemptId}.json`);
          const indexText = readFileSync(indexPath, 'utf8');
          writeFileSync(indexPath, '{corrupt');
          assert.equal((await bash('git status')).status, 2, 'A known corrupt worker locator must not become unowned.');
          writeFileSync(indexPath, indexText);
          for (const command of ['printf changed > source.ts', 'git add source.ts',
            ...['diff', 'log', 'show'].flatMap((verb) => [`git ${verb} --output=source.patch`, `git ${verb} --output source.patch`]),
            `node ${join(tools, 'loop-host.mjs')}`,
            `node ${join(tools, 'status.mjs')} --control --run ${acquired.runId} --by ui`,
            `echo forged > ${repo.commonDir}/autoloop/scheduler/current.json`]) {
            const result = await bash(command); assert.equal(result.status, 2, `${posture}: ${command}: ${result.stderr}`);
          }
          assert.equal((await bash('git status --porcelain', randomUUID())).status, 2, 'A copied session cannot replace the registered process session.');
          assert.equal((await bash('git status --porcelain', sessionId, scratch)).status, 2, 'A worker cannot escape its worktree by changing the payload cwd.');
          for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
            const result = await tool({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: name,
              tool_input: name === 'NotebookEdit' ? { notebook_path: join(repo.coordinatorRoot, 'source.ipynb') } : { file_path: join(repo.coordinatorRoot, 'source.ts') } }, 'edit');
            assert.equal(result.status, 2, `${posture} ${name}: ${result.stderr}`);
          }
          const missing = await tool({ cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command: 'git status' } });
          assert.equal(missing.status, 2);
          if (posture === 'writer') {
            const checkpoint = join(repo.commonDir, 'autoloop', 'scheduler', 'runs', acquired.runId, 'checkpoint.json');
            const saved = readFileSync(checkpoint, 'utf8'); writeFileSync(checkpoint, '{corrupt');
            assert.equal((await bash('git status')).status, 2, 'A known worker fails closed on an unreadable authoritative checkpoint.');
            const unrelated = spawnSync(process.execPath, [entry, new URL('./command-guard.mjs', import.meta.url).href, 'bash', workerDirectory], {
              input: JSON.stringify({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command: 'git status' } }),
              cwd: repo.coordinatorRoot, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(scratch, 'unrelated-home') },
            });
            assert.equal(unrelated.status, 0, 'The copied worker session alone does not guard an unrelated process.');
            const unrelatedRecipe = spawnSync('sh', ['-c', recipeOf('bash')], {
              input: JSON.stringify({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: 'Bash', tool_input: { command: 'git status' } }),
              cwd: repo.coordinatorRoot, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(scratch, 'unrelated-home'),
                NODE_OPTIONS: `--import=${shim}`, CLAUDE_PLUGIN_ROOT: copied, CLAUDE_PROJECT_DIR: repo.coordinatorRoot },
            });
            assert.equal(unrelatedRecipe.status, 0, 'The independent hook fallback does not turn a copied session into a worker.');
            for (const kind of ['bash', 'edit']) {
              const failed = spawnSync(process.execPath, [entry, new URL(kind === 'edit' ? './edit-guard.mjs' : './command-guard.mjs', import.meta.url).href, kind, workerDirectory, 'throw'], {
                input: JSON.stringify({ session_id: sessionId, cwd: repo.coordinatorRoot, tool_name: kind === 'edit' ? 'Edit' : 'Bash',
                  tool_input: kind === 'edit' ? { file_path: 'ordinary.ts' } : { command: 'git status' } }),
                cwd: repo.coordinatorRoot, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: join(scratch, 'unrelated-home') },
              });
              assert.equal(failed.status, 0, 'An unrelated process does not acquire guard ownership when the guard throws.');
            }
            writeFileSync(checkpoint, saved);
          }
        } finally {
          const closed = new Promise((done) => child.once('close', done)); child.kill('SIGTERM'); await closed;
        }
      }
    });
    await check('simultaneous daemon and legacy start use one election in both orders', async () => {
      for (const first of ['legacy', 'daemon']) {
        const repo = repository(); const pins = pinsOf(repo);
        const script = `import * as core from ${JSON.stringify(new URL('./scheduler-contract.mjs', import.meta.url).href)};
          import * as prime from ${JSON.stringify(new URL('./prime.mjs', import.meta.url).href)};
          const repo = core.resolveRepository(process.argv[1]); const kind = process.argv[2];
          process.on('message', (message) => {
            if (message !== 'start') return;
            try {
              const result = kind === 'daemon' ? core.acquireScheduler(repo, JSON.parse(process.argv[3]),
                { kind: 'terminal', sessionId: null, process: core.readProcessIdentity() })
                : prime.openLegacyRun({ root: repo.coordinatorRoot, owner: process.pid, sessionId: process.argv[4],
                  baseBranch: 'main', latches: process.argv[5] });
              process.send(kind === 'daemon' ? { ok: true, runId: result.runId, owner: core.readProcessIdentity() }
                : { ok: result.ok, error: result.error, owner: core.readProcessIdentity() });
            } catch (error) { process.send({ ok: false, error: { code: error.code, owner: error.owner, runId: error.runId } }); }
          }); process.send('ready');`;
        const children = [];
        const launch = async (kind) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script, repo.coordinatorRoot, kind,
            JSON.stringify(pins), randomUUID(), join(scratch, randomUUID())], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
          children.push(child);
          await new Promise((done, fail) => { child.once('message', done); child.once('error', fail); });
          return child;
        };
        try {
          const ordered = [await launch(first), await launch(first === 'legacy' ? 'daemon' : 'legacy')];
          const answers = ordered.map((child) => new Promise((done) => child.once('message', done)));
          // Both are ready before either admission begins. The election, not order, chooses the winner.
          for (const child of ordered) child.send('start');
          const results = await Promise.all(answers);
          assert.equal(results.filter((value) => value.ok).length, 1, JSON.stringify(results));
          const winner = results.find((value) => value.ok); const loser = results.find((value) => !value.ok);
          assert(['SCHEDULER_ACTIVE', 'LEGACY_RUN_ACTIVE'].includes(loser.error.code), JSON.stringify(results));
          assert.deepEqual(loser.error.owner, winner.owner);
        } finally {
          for (const child of children) {
            const closed = new Promise((done) => child.once('close', done)); child.kill('SIGTERM'); await closed;
          }
        }
      }
    });
  } finally {
    fixtureAccount.restore();
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch { console.error(`Retained test fixture: ${scratch}`); }
  }
  const failed = cases.filter(([, passed]) => !passed);
  console.log(failed.length ? `self-test FAILED (${failed.length}/${cases.length})` : `self-test OK (${cases.length} cases)`);
  return failed.length === 0;
}
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 4 && process.argv[2] === '--guard-entry' && ['command', 'edit'].includes(process.argv[3])) {
    runGuardEntry(process.argv[3]).catch(() => { console.error('autoloop guard — the bootstrap check failed.'); process.exit(1); });
  } else if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    process.exit(await selfTest() ? 0 : 1);
  } else {
    console.error('usage: loop-execution-admission.mjs --self-test | --guard-entry command|edit'); process.exit(2);
  }
}
