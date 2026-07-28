#!/usr/bin/env node
// autoloop — regression-index.mjs
//
// One executable check per incident this plugin has actually suffered.
//
// `guard-corpus.json` already established the pattern: every case carries a
// `why` naming the run that earned it, so a rule can never be deleted without
// someone reading what it cost. This file extends that discipline past the
// guard, to defects whose enforcer is a self-test case somewhere else in the
// tree.
//
// It does NOT re-test the defects. It asserts that the test which pins each one
// still exists — because the failure mode of a regression suite is not a bad
// assertion, it is a case quietly deleted during a refactor, after which the
// bug is free to return and nothing says so. Every entry names the file and the
// exact text that must survive.
//
// Adding an incident with no enforcer fails. Renaming an enforcing case without
// updating its incident fails. Both are the point.
//
// Usage:
//   node regression-index.mjs [--json]
//   node regression-index.mjs --self-test

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// `anchor` is verbatim source text from `file`. Keep it short enough to survive
// reformatting and specific enough that its presence really means the case is
// still there.
export const INCIDENTS = Object.freeze([
  Object.freeze({
    id: 'merge-commit-sha-removed-from-rest',
    date: '2026-07-28',
    symptom: 'Every human-merged unit refused its terminal backfill with '
      + 'ARTIFACT_IDENTITY_MISMATCH(merge); four shipped units wedged.',
    cause: 'REST API version 2026-03-10 removed `merge_commit_sha` from both '
      + 'pull-request representations, so the driver read undefined.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'api-shape.mjs',
        anchor: 'the 2026-07-28 incident is caught: mergeCommit.oid absent',
      }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'function mergeCommitOid(' }),
    ]),
  }),
  Object.freeze({
    id: 'blocking-stripped-loop-ready',
    date: '2026-07-27',
    symptom: 'A blocked unit could never be resumed: the block flow removed '
      + '`loop-ready`, and the loop is forbidden from reapplying it.',
    cause: '`loop-ready` was treated as redundant with `loop-blocked` rather '
      + 'than as the authorization token it is.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'label-swap-reminder.mjs', anchor: 'KEEP `loop-ready`' }),
    ]),
  }),
  Object.freeze({
    id: 'unnamed-artifact-mismatch',
    date: '2026-07-28',
    symptom: 'A refusal naming only its category ("merge") sent two sessions '
      + 'an hour each proving state that was already consistent.',
    cause: 'Typed refusals carried a category but not the predicate that '
      + 'failed or the values it compared.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'merge commit is not a commit OID',
      }),
    ]),
  }),
  Object.freeze({
    id: 'delivery-floor-ignored-untriggered-checks',
    date: '2026-07-26',
    symptom: 'Delivery could pass while the exact head carried no green '
      + 'evidence at all.',
    cause: 'The floor asked whether checks failed, not whether any ran.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'delivery-contract.mjs',
        anchor: 'no triggered checks delivers on the floor alone',
      }),
    ]),
  }),
  Object.freeze({
    id: 'effort-dropped-at-cli-seam',
    date: '2026-07-27',
    symptom: 'Reviews requested at xhigh silently ran at the engine default.',
    cause: 'The flag validated but never reached the spawned argv.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: "'--effort', 'nope'" }),
    ]),
  }),
  Object.freeze({
    id: 'release-literals-counted-file-wide',
    date: '2026-07-28',
    symptom: 'Adding a second workflow step that needs the repository name '
      + 'failed a release gate that had nothing to say about it.',
    cause: 'Requirements describing the release-verify invocation were counted '
      + 'across the whole workflow, so the literal became reserved file-wide. '
      + 'The tempting fix was to spell the flag differently and dodge it.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'release-verify.mjs',
        anchor: 'another step may bind the repository without tripping the gate',
      }),
    ]),
  }),
  Object.freeze({
    id: 'exit-code-contract-unreadable-under-the-guard',
    date: '2026-07-28',
    symptom: 'Every setup lost a round to a guard refusal: the merge step '
      + 'documents its outcome as "exit 3", so sessions reached for `$?`, '
      + 'which the guard blocks as an active shell expansion.',
    cause: 'A tool contract expressed only as an exit code, under a guard that '
      + 'forbids the idiom for reading exit codes. The same fact was in the '
      + 'report all along as `ok: false`, but nothing said so.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/setup/SKILL.md',
        anchor: 'Read that from the report, never from `$?`',
      }),
      Object.freeze({ file: 'scaffold.mjs', anchor: 'return report.ok ? 0 : 3;' }),
    ]),
  }),
  Object.freeze({
    id: 'guard-refusals-named-no-alternative',
    date: '2026-07-28',
    symptom: 'A session lost a round to `ls -d … | xargs -n1 basename` — a '
      + 'plain listing — then ran the plain listing anyway. The refusal said '
      + '"use literal canonical commands" without naming which one.',
    cause: 'The refusal named its category, not its remedy. The message policy '
      + 'required a closing sentence naming the sanctioned alternative, and '
      + 'generic prose satisfied it on shape while naming nothing.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'fanout refusal names the listing command to use instead',
      }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'const ASSEMBLER_REMEDY' }),
    ]),
  }),
  Object.freeze({
    id: 'gh-json-merged-field-does-not-exist',
    date: '2026-07-28',
    symptom: 'A session lost a round to `gh pr view --json merged`, which is '
      + 'not a field, while hand-querying merge state the driver already '
      + 'reports.',
    cause: '`merged` is a real field in the REST representation and in GraphQL '
      + 'but not in `gh pr view --json`, which spells it `mergedAt`. Nothing '
      + 'said to ask the driver instead of improvising a gh call.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Never hand-query a unit',
      }),
    ]),
  }),
  Object.freeze({
    id: 'state-sections-never-migrated',
    date: '2026-07-27',
    symptom: 'Existing repos kept a 29 KB STATE.md injected into every '
      + 'session; a template change alone could not reach them.',
    cause: 'Setup merged documents but had no way to relocate a section, so '
      + 'template restructuring stranded every installed repo.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'scaffold.mjs', anchor: 'lessons-out-of-state' }),
    ]),
  }),
]);

export function auditIncidents(incidents = INCIDENTS, read = (file) =>
  readFileSync(join(HERE, file), 'utf8')) {
  return incidents.map((incident) => {
    const failures = [];
    for (const enforcer of incident.enforcedBy) {
      let source;
      try {
        source = read(enforcer.file);
      } catch {
        failures.push(`${enforcer.file} is missing`);
        continue;
      }
      if (!source.includes(enforcer.anchor)) {
        failures.push(`${enforcer.file} no longer contains "${enforcer.anchor}"`);
      }
    }
    return { id: incident.id, date: incident.date, ok: failures.length === 0, failures };
  });
}

// Every guard case must say what it cost. A rule with no incident behind it is
// an opinion, and opinions get deleted by the next person who finds them
// inconvenient.
export function auditGuardCorpus(corpus) {
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : null;
  if (cases === null) return ['guard-corpus.json has no cases array'];
  return cases.flatMap((entry, index) => {
    const label = entry?.cmd ? JSON.stringify(entry.cmd.split('\n')[0].slice(0, 40)) : `#${index}`;
    if (typeof entry?.why !== 'string' || entry.why.trim() === '') {
      return [`guard case ${label} records no incident in \`why\``];
    }
    if (entry.expect !== 'allow' && entry.expect !== 'block') {
      return [`guard case ${label} has no allow/block expectation`];
    }
    return [];
  });
}

function selfTest() {
  const reads = { 'a.mjs': 'contains THE ANCHOR here' };
  const read = (file) => {
    if (!(file in reads)) throw new Error('missing');
    return reads[file];
  };
  const incident = (enforcedBy) => [{ id: 'x', date: '2026-01-01', enforcedBy }];
  const cases = [
    ['every registered incident still has its enforcing case', (() => {
      const failed = auditIncidents().filter((row) => !row.ok);
      for (const row of failed) console.error(`  ${row.id}: ${row.failures.join('; ')}`);
      return failed.length === 0;
    })()],
    ['every guard case names the incident that earned it', (() => {
      const corpus = JSON.parse(readFileSync(join(HERE, 'guard-corpus.json'), 'utf8'));
      const failures = auditGuardCorpus(corpus);
      for (const failure of failures) console.error(`  ${failure}`);
      return failures.length === 0;
    })()],
    ['a present anchor passes', auditIncidents(
      incident([{ file: 'a.mjs', anchor: 'THE ANCHOR' }]), read,
    )[0].ok],
    ['a deleted case fails, and the failure quotes the anchor', (() => {
      const [row] = auditIncidents(incident([{ file: 'a.mjs', anchor: 'GONE' }]), read);
      return !row.ok && row.failures[0].includes('"GONE"');
    })()],
    ['a missing enforcer file fails rather than throwing', (() => {
      const [row] = auditIncidents(incident([{ file: 'nope.mjs', anchor: 'x' }]), read);
      return !row.ok && row.failures[0].includes('missing');
    })()],
    ['one broken enforcer fails the incident even when others hold', (() => {
      const [row] = auditIncidents(incident([
        { file: 'a.mjs', anchor: 'THE ANCHOR' },
        { file: 'a.mjs', anchor: 'GONE' },
      ]), read);
      return !row.ok && row.failures.length === 1;
    })()],
    ['a guard case with no `why` is rejected', auditGuardCorpus({
      cases: [{ cmd: 'ls', expect: 'allow' }],
    }).length === 1],
    ['every incident states a symptom and a cause', INCIDENTS.every((entry) =>
      entry.symptom.length > 20 && entry.cause.length > 20)],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const rows = auditIncidents();
  const guard = auditGuardCorpus(
    JSON.parse(readFileSync(join(HERE, 'guard-corpus.json'), 'utf8')),
  );
  const broken = rows.filter((row) => !row.ok).length + (guard.length > 0 ? 1 : 0);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: broken === 0, incidents: rows, guard }, null, 1));
  } else {
    for (const row of rows) {
      console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.date} ${row.id}`);
      for (const failure of row.failures) console.log(`     ${failure}`);
    }
    console.log(`${guard.length === 0 ? 'PASS' : 'FAIL'} guard corpus provenance`);
    for (const failure of guard) console.log(`     ${failure}`);
    console.log(broken === 0
      ? `every incident is pinned (${rows.length} incidents)`
      : `${broken} incident(s) lost their enforcer`);
  }
  process.exit(broken === 0 ? 0 : 1);
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
