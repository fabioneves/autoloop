#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { processAlive, processStart } from './run-markers.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function newAssociationId() {
  return randomUUID();
}

export function validReceipt(result, issue) {
  const receipt = result?.receipt;
  return (result?.ok === true || result?.ok === false)
    && Number.isSafeInteger(issue) && issue > 0
    && receipt?.issue === issue && ID.test(receipt.stepId ?? '')
    && ID.test(receipt.dispatchId ?? '') && typeof receipt.role === 'string'
    && receipt.role.length > 0 && receipt.role === result.role
    ? receipt : null;
}

export function readStepBinding(path, issue) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const last = Array.isArray(record?.steps) ? record.steps.at(-1) : null;
  if (record?.issue !== issue || record.closed || !last || (last.stepId && !ID.test(last.stepId))) return null;
  return {
    stepId: last.stepId ?? null,
    index: record.steps.length - 1,
    startedAtMs: last.startedAtMs,
    dispatchId: last.dispatchId ?? null,
  };
}

// A dead writer's lock can be reclaimed. Each acquisition attempt publishes
// a unique intent before it can read or remove an older lock. A new holder
// drains those intents and checks its nonce before it calls change. Thus a
// delayed stale read can remove a new lock only before its callback starts.
// A failed acquisition removes its intent before waiting; a displaced holder
// stops draining as soon as its nonce is gone. Neither can form a wait cycle.
// Dead intents have unique paths and are removed by pid/start identity, not
// age. Unreadable intents block. Legacy locks without a holder retain a grace
// period. The final nonce check also fences uncoordinated lock removal.
const LOCK_GRACE_MS = 5_000;
const MAX_RECLAIMS = 3;

function lockHolder(lock) {
  try {
    return readFileSync(lock, 'utf8');
  } catch {
    return null;
  }
}

function staleLock(lock, holder) {
  let owner = null;
  try {
    owner = JSON.parse(holder);
  } catch { /* a legacy lock, or no holder */ }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) {
    try {
      return Date.now() - statSync(lock).mtimeMs > LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (!processAlive(owner.pid)) return true;
  const start = processStart(owner.pid);
  return typeof owner.start === 'string' && start !== null && start !== owner.start;
}

export function reclaimStaleLock(lock) {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

function takeLock(lock, holder) {
  const prepared = `${lock}.${randomUUID()}.new`;
  writeFileSync(prepared, holder, { flag: 'wx' });
  try {
    linkSync(prepared, lock);
  } finally {
    unlinkSync(prepared);
  }
}

function reclaimInProgress(lock, ownIntent) {
  const prefix = `${basename(lock)}.`;
  for (const name of readdirSync(dirname(lock))) {
    if (!name.startsWith(prefix) || !name.endsWith('.reclaim')) continue;
    // Preserve kernel path resolution: join() would collapse a symlink/..
    // pair lexically and read a different directory from the one listed.
    const intent = `${dirname(lock)}/${name}`;
    if (name === basename(ownIntent)) continue;
    const holder = lockHolder(intent);
    if (holder === null) {
      if (existsSync(intent)) return true;
      continue;
    }
    let owner;
    try { owner = JSON.parse(holder); } catch { return true; }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return true;
    if (!staleLock(intent, holder)) return true;
    // This generation's path is never reused, so unlink cannot remove a new
    // intent published after the dead holder was read.
    try { unlinkSync(intent); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

export function updateStepRecord(path, change, { waitMs = 300 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const mine = JSON.stringify({ pid: process.pid, start: processStart(process.pid), nonce: randomUUID() });
  const deadline = Date.now() + waitMs;
  let reclaims = 0;
  const busy = () => Object.assign(new Error(`the step record lock is busy; ${path} is not written`), { code: 'EEXIST' });
  for (;;) {
    const intent = `${lock}.${randomUUID()}.reclaim`;
    takeLock(intent, mine);
    let acquired = false;
    let secured = false;
    try {
      try {
        takeLock(lock, mine);
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = lockHolder(lock);
        if (reclaims < MAX_RECLAIMS && staleLock(lock, holder)) {
          reclaims += 1;
          reclaimStaleLock(lock);
          continue;
        }
        if (Date.now() >= deadline) throw error;
      }
      if (acquired) {
        while (lockHolder(lock) === mine && reclaimInProgress(lock, intent)) {
          if (Date.now() >= deadline) throw busy();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        // An intent published after the drain reads this live holder and
        // cannot reclaim it. No callback has run if ownership was lost here.
        secured = lockHolder(lock) === mine;
        if (secured) break;
      }
    } finally {
      // Keep the intent through pre-callback cleanup. If another reclaimer
      // swaps this lock during cleanup, its new holder must still drain us.
      try {
        if (acquired && !secured && lockHolder(lock) === mine) unlinkSync(lock);
      } finally {
        unlinkSync(intent);
      }
    }
    if (Date.now() >= deadline) throw busy();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    let record = null;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const outcome = change(record);
    if (outcome?.changed) {
      const staged = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(staged, `${JSON.stringify(outcome.record, null, 1)}\n`);
        if (lockHolder(lock) !== mine) throw new Error(`the step record lock was taken over; ${path} is not written`);
        renameSync(staged, path);
      } catch (error) {
        try { unlinkSync(staged); } catch { /* No staged file to remove. */ }
        throw error;
      }
    }
    return outcome;
  } finally {
    if (lockHolder(lock) === mine) unlinkSync(lock);
  }
}

async function selfTest() {
  if (process.env[WORKER_ENV]) throw new Error('the self-test never runs inside its own worker');
  const tally = { launched: 0, settled: 0, timedOut: 0, cancelled: 0, uncleaned: 0 };
  const worker = boundedWorker(tally);
  const self = fileURLToPath(import.meta.url);
  const root = mkdtempSync(join(tmpdir(), 'dispatch-return-'));
  const path = join(root, 'steps', '7.json');
  const checks = [];
  try {
    checks.push(['a path containing a dot segment never waits on its own reclaim intent', (() => {
      const dotted = `${root}/./steps/13.json`;
      try {
        const result = updateStepRecord(dotted, () => ({ changed: true, record: { counter: 1 } }), { waitMs: 0 });
        return result.changed && JSON.parse(readFileSync(dotted, 'utf8')).counter === 1;
      } catch {
        return false;
      }
    })()]);
    checks.push(['a symlink followed by a parent segment retains the physical intent directory', (() => {
      mkdirSync(join(root, 'target', 'child'), { recursive: true });
      mkdirSync(join(root, 'target', 'steps'));
      symlinkSync(join(root, 'target', 'child'), join(root, 'link'));
      const target = `${root}/link/../steps/14.json`;
      const intent = `${target}.lock.${randomUUID()}.reclaim`;
      writeFileSync(intent, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { flag: 'wx' });
      let called = false;
      let blocked = false;
      try {
        updateStepRecord(target, () => { called = true; return { changed: true, record: {} }; }, { waitMs: 0 });
      } catch (error) {
        blocked = error.code === 'EEXIST';
      }
      const kept = existsSync(intent);
      unlinkSync(intent);
      return blocked && !called && kept && !existsSync(target);
    })()]);
    const stepId = newAssociationId();
    const dispatchId = newAssociationId();
    const result = { ok: false, role: 'fix', receipt: { issue: 7, stepId, dispatchId, role: 'fix' } };
    checks.push(['the receipt needs exact issue, role, and opaque ids', validReceipt(result, 7) === result.receipt
      && validReceipt(result, 8) === null && validReceipt({ ...result, role: 'plan' }, 7) === null
      && validReceipt({ ...result, receipt: { ...result.receipt, dispatchId: 'old' } }, 7) === null
      && validReceipt({ ...result, ok: 'true' }, 7) === null]);
    updateStepRecord(path, (record) => ({ changed: true, record: { issue: 7, steps: [{ stepId, startedAtMs: 1 }] } }));
    const binding = readStepBinding(path, 7);
    checks.push(['the binding names the last step and its attempt', binding.stepId === stepId
      && binding.index === 0 && binding.dispatchId === null]);
    const earlier = JSON.parse(readFileSync(path, 'utf8'));
    updateStepRecord(path, (record) => ({ changed: true,
      record: { ...record, steps: [...record.steps, { stepId: newAssociationId(), startedAtMs: 2 }] } }));
    updateStepRecord(path, (record) => ({ changed: true,
      record: { ...record, steps: record.steps.map((step, index) => index === 1 ? { ...step, waiting: 'newer' } : step) } }));
    const current = JSON.parse(readFileSync(path, 'utf8'));
    checks.push(['a later writer preserves earlier data', current.steps.length === 2
      && current.steps[0].stepId === earlier.steps[0].stepId && current.steps[1].waiting === 'newer']);
    const before = readFileSync(path, 'utf8');
    const plantLock = (target, owner) => writeFileSync(`${target}.lock`, JSON.stringify(owner), { flag: 'wx' });
    plantLock(path, { pid: process.pid, start: processStart(process.pid) });
    try {
      let blocked = false;
      try { updateStepRecord(path, () => ({ changed: true, record: {} }), { waitMs: 0 }); }
      catch (error) { blocked = error.code === 'EEXIST'; }
      checks.push(['an owned lock blocks a second writer without being reclaimed', blocked
        && readFileSync(path, 'utf8') === before]);
    } finally {
      rmSync(`${path}.lock`, { force: true });
    }
    // Review R1/L5: a lock whose holder died wedged every later step write.
    const dead = await worker(['-e', '0']);
    const reclaimable = [{ pid: dead.pid, start: null }, { pid: process.pid, start: 'an-earlier-process' }];
    const reclaimed = reclaimable.map((owner) => {
      plantLock(path, owner);
      try {
        return updateStepRecord(path, (record) => ({ changed: true, record: { ...record, reclaimed: owner.pid } }), { waitMs: 0 }).changed
          && JSON.parse(readFileSync(path, 'utf8')).reclaimed === owner.pid;
      } catch {
        rmSync(`${path}.lock`, { force: true });
        return false;
      }
    });
    checks.push(['a lock whose holder is dead, or whose pid now names another process, is reclaimed',
      reclaimed.every(Boolean) && !existsSync(`${path}.lock`)]);
    const intentTarget = join(root, 'steps', '12.json');
    updateStepRecord(intentTarget, () => ({ changed: true, record: { counter: 0 } }));
    const deadIntents = reclaimable.map((owner) => {
      const intent = `${intentTarget}.lock.${randomUUID()}.reclaim`;
      writeFileSync(intent, JSON.stringify(owner), { flag: 'wx' });
      updateStepRecord(intentTarget, (record) => ({ changed: true, record: { counter: record.counter + 1 } }), { waitMs: 0 });
      return !existsSync(intent);
    });
    checks.push(['dead and reused-process reclaim intents do not block a writer', deadIntents.every(Boolean)
      && JSON.parse(readFileSync(intentTarget, 'utf8')).counter === 2]);
    for (const [name, holder] of [
      ['a live', JSON.stringify({ pid: process.pid, start: processStart(process.pid) })],
      ['an unreadable', 'not JSON'],
    ]) {
      const intent = `${intentTarget}.lock.${randomUUID()}.reclaim`;
      writeFileSync(intent, holder, { flag: 'wx' });
      const saved = readFileSync(intentTarget, 'utf8');
      let called = false;
      let blocked = false;
      try {
        updateStepRecord(intentTarget, () => { called = true; return { changed: true, record: {} }; }, { waitMs: 0 });
      } catch (error) {
        blocked = error.code === 'EEXIST';
      }
      checks.push([`${name} reclaim intent blocks before callback effects and is not removed`, blocked && !called
        && readFileSync(intentTarget, 'utf8') === saved && existsSync(intent) && !existsSync(`${intentTarget}.lock`),
        JSON.stringify({ blocked, called, intentPresent: existsSync(intent), lockPresent: existsSync(`${intentTarget}.lock`) })]);
      rmSync(intent, { force: true });
    }
    const ready = join(root, 'holding');
    const killAbort = new AbortController();
    const holding = worker([...MODULE_EVAL, `const { writeFileSync } = await import('node:fs');
      const { updateStepRecord } = await import(process.argv[1]);
      updateStepRecord(process.argv[2], () => {
        writeFileSync(process.argv[3], '');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
        return { changed: false };
      });`, self, path, ready], { signal: killAbort.signal });
    const readyBy = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < readyBy) await new Promise((done) => setTimeout(done, 20));
    const heldRecord = readFileSync(path, 'utf8');
    let peerCalled = false;
    let peerBlocked = false;
    try {
      updateStepRecord(path, () => { peerCalled = true; return { changed: true, record: {} }; }, { waitMs: 0 });
    } catch (error) {
      peerBlocked = error.code === 'EEXIST';
    }
    checks.push(['an intent published after callback entry cannot reclaim the live holder', existsSync(ready)
      && peerBlocked && !peerCalled && readFileSync(path, 'utf8') === heldRecord]);
    killAbort.abort();
    const killed = await holding;
    let afterKill = false;
    try {
      afterKill = updateStepRecord(path, (record) => ({ changed: true, record: { ...record, afterKill: true } }), { waitMs: 0 }).changed;
    } catch { /* still wedged */ }
    checks.push(['a lock left by a SIGKILLed writer no longer wedges the next one', killed.cancelled && killed.closed
      && afterKill && JSON.parse(readFileSync(path, 'utf8')).afterKill === true]);
    const raced = join(root, 'steps', '10.json');
    updateStepRecord(raced, () => ({ changed: true, record: { issue: 10, steps: [], counter: 0 } }));
    plantLock(raced, { pid: dead.pid, start: null });
    const randomRacers = await Promise.all([worker([...MODULE_EVAL, RACER, self, raced]), worker([...MODULE_EVAL, RACER, self, raced])]);
    const randomCounter = JSON.parse(readFileSync(raced, 'utf8')).counter;
    checks.push(['two writers reclaiming one stale lock both land, one at a time', randomRacers.every(({ code }) => code === 0)
      && randomCounter === 2, JSON.stringify({ counter: randomCounter, racers: randomRacers })]);
    updateStepRecord(raced, (record) => ({ changed: true, record: { ...record, counter: 0 } }));
    plantLock(raced, { pid: dead.pid, start: null });
    // Pause the real rename after B reads the stale holder. A then takes a
    // live lock before B completes that rename. No scheduling delay is assumed.
    const staleRead = join(root, 'stale-read');
    const liveTaken = join(root, 'live-taken');
    const phaseReady = join(root, 'phase-ready');
    const releaseReclaim = join(root, 'release-reclaim');
    const moved = join(root, 'live-moved');
    const effects = [join(root, 'b-effect'), join(root, 'a-effect')];
    const lateReclaimer = worker([...MODULE_EVAL, `${RACE_BARRIER}
      const rename = fs.renameSync;
      let paused = false;
      fs.renameSync = (from, to) => {
        if (!paused && from === process.argv[2] + '.lock' && to.endsWith('.stale')) {
          paused = true;
          fs.writeFileSync(process.argv[3], '');
          waitForBarrier(process.argv[4]);
          rename(from, to);
          fs.writeFileSync(process.argv[5], '');
          return;
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      ${RACER}`, self, raced, staleRead, releaseReclaim, moved, effects[0]]);
    const readSeen = await waitForFile(staleRead);
    const liveWriter = worker([...MODULE_EVAL, `${RACE_BARRIER}
      const link = fs.linkSync;
      const readDirectory = fs.readdirSync;
      const append = fs.appendFileSync;
      let taken = false;
      let paused = false;
      function pauseAt(phase) {
        paused = true;
        fs.writeFileSync(process.argv[4], phase);
        waitForBarrier(process.argv[5]);
      }
      fs.linkSync = (from, to) => {
        link(from, to);
        if (!taken && to === process.argv[2] + '.lock') {
          taken = true;
          fs.writeFileSync(process.argv[3], '');
        }
      };
      fs.readdirSync = (...args) => {
        const names = readDirectory(...args);
        if (taken && !paused) pauseAt('drain');
        return names;
      };
      fs.appendFileSync = (...args) => {
        append(...args);
        if (taken && !paused && args[0] === process.argv[6]) pauseAt('callback');
      };
      syncBuiltinESMExports();
      ${RACER}`, self, raced, liveTaken, phaseReady, moved, effects[1]]);
    const takenSeen = await waitForFile(liveTaken);
    const phaseSeen = await waitForFile(phaseReady);
    writeFileSync(releaseReclaim, '');
    const racers = await Promise.all([lateReclaimer, liveWriter]);
    const racedCounter = JSON.parse(readFileSync(raced, 'utf8')).counter;
    const once = effects.every((effect) => existsSync(effect) && readFileSync(effect, 'utf8') === 'effect\n');
    checks.push(['a delayed stale reclaim does not lose an update or repeat a callback effect', readSeen && takenSeen && phaseSeen
      && existsSync(moved) && racers.every(({ code }) => code === 0) && racedCounter === 2 && once,
      JSON.stringify({ readSeen, takenSeen, phaseSeen, phase: phaseSeen ? readFileSync(phaseReady, 'utf8') : null,
        moved: existsSync(moved), counter: racedCounter, once, racers })]);
    // Re-audit N2: B read a stale holder, C reclaimed it and took the lock,
    // then B moved C's live lock aside and renamed it back over D's. Here B's
    // late move lands while C holds the lock, D then writes, and E holds the
    // lock when C finishes: C must not overwrite D, nor remove E's lock.
    const fenced = join(root, 'steps', '11.json');
    updateStepRecord(fenced, () => ({ changed: true, record: { issue: 11, steps: [] } }));
    const staleHolder = JSON.stringify({ pid: dead.pid, start: null, nonce: 'stale' });
    plantLock(fenced, JSON.parse(staleHolder));
    const eHolder = JSON.stringify({ pid: process.pid, start: processStart(process.pid), nonce: 'e' });
    let cOutcome = 'returned';
    let dLanded = false;
    try {
      updateStepRecord(fenced, (record) => {
        reclaimStaleLock(`${fenced}.lock`);
        dLanded = updateStepRecord(fenced, (latest) => ({ changed: true, record: { ...latest, d: true } }), { waitMs: 0 }).changed;
        writeFileSync(`${fenced}.lock`, eHolder, { flag: 'wx' });
        return { changed: true, record: { ...record, c: true } };
      }, { waitMs: 0 });
    } catch (error) {
      cOutcome = error.message;
    }
    const fencedRecord = JSON.parse(readFileSync(fenced, 'utf8'));
    let eKept = false;
    try { eKept = readFileSync(`${fenced}.lock`, 'utf8') === eHolder; } catch { /* removed */ }
    checks.push(['a writer whose live lock was moved aside writes nothing over the next writer and removes no other lock',
      dLanded && fencedRecord.d === true && fencedRecord.c === undefined && /lock was taken over/u.test(cOutcome) && eKept]);
    rmSync(`${fenced}.lock`, { force: true });
    let invalid = false;
    writeFileSync(join(root, 'steps', '8.json'), 'not JSON');
    try { updateStepRecord(join(root, 'steps', '8.json'), () => ({ changed: true, record: {} })); }
    catch (error) { invalid = error instanceof SyntaxError; }
    checks.push(['unreadable state is not replaced', invalid
      && readFileSync(join(root, 'steps', '8.json'), 'utf8') === 'not JSON']);
    const concurrent = join(root, 'steps', '9.json');
    updateStepRecord(concurrent, () => ({ changed: true, record: { issue: 9, steps: [], counter: 0 } }));
    const writers = await Promise.all([worker([...MODULE_EVAL, RACER, self, concurrent]), worker([...MODULE_EVAL, RACER, self, concurrent])]);
    checks.push(['concurrent writers retain both updates', writers.every(({ code }) => code === 0)
      && JSON.parse(readFileSync(concurrent, 'utf8')).counter === 2]);
    // An importer whose argv[1] is this module once re-entered the self-test,
    // and each worker spawned two more until the cgroup ran out of memory.
    const imported = await worker([...MODULE_EVAL, 'await import(process.argv[1]); process.stdout.write("imported")', self],
      { nested: false });
    checks.push(['importing with this module as argv[1] never starts the self-test', imported.code === 0
      && imported.stdout === 'imported']);
    const refused = await worker([self, '--self-test']);
    checks.push(['the self-test refuses to run inside its own worker', refused.code === 2
      && refused.stdout === '' && /own worker/u.test(refused.stderr)]);
    const hung = await worker(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
    checks.push(['a timed-out worker is killed and confirmed gone', hung.timedOut && hung.closed && gone(hung.pid)]);
    const abort = new AbortController();
    const cancelling = worker(['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const cancelled = await cancelling;
    checks.push(['a cancelled worker is killed and confirmed gone', cancelled.cancelled && cancelled.closed
      && gone(cancelled.pid)]);
    const failed = await worker(['-e', 'process.exit(3)']);
    const unlaunched = await worker([], { executable: join(root, 'missing-node') });
    checks.push(['a failing or unlaunchable worker is reported, not replaced', failed.code === 3 && failed.closed
      && unlaunched.error === 'ENOENT' && unlaunched.closed && tally.launched === tally.settled]);
    checks.push(['acquisition, timeout, and callback exit leave no reclaim intent behind',
      readdirSync(join(root, 'steps')).every((name) => !name.endsWith('.reclaim'))]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  checks.push(['every worker was accounted for and none needed cleanup it could not confirm',
    tally.launched === WORKER_BUDGET && tally.settled === tally.launched && tally.uncleaned === 0]);
  for (const [name, passed, detail] of checks) if (!passed) {
    console.error(`FAIL ${name}`);
    if (detail) console.error(detail);
  }
  const failures = checks.filter(([, passed]) => !passed).length;
  const workers = `workers launched ${tally.launched}, settled ${tally.settled}, timed out ${tally.timedOut}, `
    + `cancelled ${tally.cancelled}, uncleaned ${tally.uncleaned}`;
  console.log(failures ? `self-test FAILED (${failures}/${checks.length}; ${workers})`
    : `self-test OK (${checks.length} cases; ${workers})`);
  return failures === 0;
}

const WORKER_ENV = 'AUTOLOOP_ASSOCIATION_WORKER';
const WORKER_BUDGET = 14;
// The barriers observe and delay real filesystem operations only in workers.
const RACE_BARRIER = `const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  function waitForBarrier(path) {
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(path)) {
      if (Date.now() >= deadline) throw new Error('race barrier timed out: ' + path);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }`;
async function waitForFile(path) {
  const deadline = Date.now() + 2000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  return existsSync(path);
}
// A writer that reads, waits, then increments: two of them lose an update
// unless the lock serialises them.
const RACER = `const { updateStepRecord } = await import(process.argv[1]);
  const { appendFileSync } = await import('node:fs');
  updateStepRecord(process.argv[2], (record) => {
    if (process.argv[6]) appendFileSync(process.argv[6], 'effect\\n');
    const counter = record.counter;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    return { changed: true, record: { ...record, counter: counter + 1 } };
  }, { waitMs: 2000 });`;
const MODULE_EVAL = Object.freeze(['--input-type=module', '-e']);

function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// One bounded child of the self-test: a fixed budget, a deadline, SIGKILL on
// timeout or cancellation, and a bounded wait for the exit that proves it.
function boundedWorker(tally) {
  return (args, { timeoutMs = 10_000, signal = null, nested = true, executable = process.execPath, closeWaitMs = 2_000 } = {}) =>
    new Promise((resolve) => {
      const outcome = { pid: null, code: null, signal: null, stdout: '', stderr: '', timedOut: false,
        cancelled: false, closed: false, error: null };
      if (tally.launched >= WORKER_BUDGET) {
        resolve({ ...outcome, error: 'WORKER_BUDGET_EXHAUSTED' });
        return;
      }
      tally.launched += 1;
      let settled = false;
      let deadline = null;
      let closeWait = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(closeWait);
        signal?.removeEventListener('abort', cancel);
        tally.settled += 1;
        if (!outcome.closed) tally.uncleaned += 1;
        resolve(outcome);
      };
      const child = spawn(executable, args, {
        env: { ...process.env, ...(nested ? { [WORKER_ENV]: '1' } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      outcome.pid = child.pid ?? null;
      const stop = (reason) => {
        if (outcome.closed) return;
        outcome[reason] = true;
        tally[reason] += 1;
        child.kill('SIGKILL');
        closeWait = setTimeout(settle, closeWaitMs);
      };
      const cancel = () => stop('cancelled');
      child.stdout.on('data', (chunk) => { outcome.stdout += chunk; });
      child.stderr.on('data', (chunk) => { outcome.stderr += chunk; });
      child.on('error', (error) => {
        outcome.error = error.code ?? error.message;
        if (outcome.pid === null) {
          outcome.closed = true;
          settle();
        }
      });
      child.on('close', (code, exitSignal) => {
        Object.assign(outcome, { code, signal: exitSignal, closed: true });
        settle();
      });
      deadline = setTimeout(() => stop('timedOut'), timeoutMs);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain && process.argv.length === 3 && process.argv[2] === '--self-test') {
  if (process.env[WORKER_ENV]) {
    console.error('dispatch-return-association: the self-test never runs inside its own worker');
    process.exit(2);
  }
  process.exit(await selfTest() ? 0 : 1);
}
