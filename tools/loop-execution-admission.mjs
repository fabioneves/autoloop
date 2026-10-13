#!/usr/bin/env node
// Shared execution admission and registered worker tool entry tests.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as scheduler from './scheduler-contract.mjs';
import * as prime from './prime.mjs';
import { CONFIG_VERSION, resolveConfigText } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels } from './models-config.mjs';

async function selfTest() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-execution-admission-')));
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
    await check('dead and reused legacy owners permit start; missing identity does not become dead', () => {
      for (const mode of ['dead', 'reused', 'unknown']) {
        const repo = repository();
        const directory = join(repo.commonDir, 'autoloop', 'run'); mkdirSync(directory, { recursive: true });
        const owner = scheduler.readProcessIdentity();
        if (mode === 'dead') owner.pid = 2147483647;
        if (mode === 'reused') owner.start = String(Number(owner.start) + 1);
        if (mode === 'unknown') owner.start = null;
        writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ version: 1, pids: [owner.pid], starts: { [owner.pid]: owner.start }, owner, sessionId: randomUUID() }));
        if (mode === 'unknown') assert.throws(() => start(repo), (error) => error.code === 'OWNER_UNVERIFIED');
        else stop(repo, start(repo));
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
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch { console.error(`Retained test fixture: ${scratch}`); }
  }
  const failed = cases.filter(([, passed]) => !passed);
  console.log(failed.length ? `self-test FAILED (${failed.length}/${cases.length})` : `self-test OK (${cases.length} cases)`);
  return failed.length === 0;
}
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  console.error('usage: loop-execution-admission.mjs --self-test'); process.exit(2);
}
