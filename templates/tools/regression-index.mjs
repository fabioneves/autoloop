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
    id: 'command-v-lookup-read-as-an-invocation',
    date: '2026-07-29',
    symptom: '`command -v php` was refused as inline interpreter source while a '
      + 'live setup checked whether its configured gate still resolves — the '
      + 'probe this plugin\'s own setup skill asks for.',
    cause: '`command` is a passthrough wrapper, so the name behind it read as '
      + 'an invocation with no script argument, which is the stdin shape. '
      + '`-v`/`-V` make it a lookup that runs nothing.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'function isLookupSegment(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['command -v php', 'feat/gh-1-x', false]",
      }),
    ]),
  }),
  Object.freeze({
    id: 'rebased-claim-branch-wedged-a-merged-unit',
    date: '2026-07-28',
    symptom: '#149 shipped and PR #238 merged, but every terminal backfill was '
      + 'refused ARTIFACT_IDENTITY_MISMATCH(local-claim), leaving a permanent '
      + '`draft-pr` marker on a closed unit that no hand edit may repair.',
    cause: 'The branch was rebased after the claim, rewriting every OID on it '
      + 'including the claim commit, so the marker held the original while the '
      + 'surviving local branch carried the rewrite. A merged unit\'s local '
      + 'branch is leftover history; the merge commit is the proof.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'a rebased local claim branch cannot wedge a merged unit',
      }),
    ]),
  }),
  Object.freeze({
    id: 'overlap-window-anchored-to-the-last-prime',
    date: '2026-07-28',
    symptom: 'A five-hour run reported `dispatches 8 · concurrent 0s` while '
      + 'its dispatch log held 57 entries and four concurrent pairs. The same '
      + 'log now reports `dispatches 57 · concurrent 93m`.',
    cause: 'Run markers accumulate, one per prime and never pruned (27 in the '
      + 'live checkout). The window boundary was Math.max over all their '
      + 'mtimes, so it anchored to the most recent PRIME rather than to the '
      + 'run being reported.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'overlap-report.mjs',
        anchor: 'the boundary is the marker for this run, never the newest one',
      }),
    ]),
  }),
  Object.freeze({
    id: 'flat-dispatch-ceiling-killed-a-working-writer',
    date: '2026-07-28',
    symptom: 'An implement dispatch grinding a Go slice was killed at the flat '
      + '30-minute ceiling mid-task. Its tokens were spent and unrecoverable; '
      + 'only the two commits it had already made survived.',
    cause: 'One ceiling served both postures. It was sized for "a run that '
      + 'needs more than half an hour has a different problem", which is true '
      + 'of a reviewer returning one verdict and false of a writer grinding '
      + 'against the slice caps.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'export function timeoutMsFor(' }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'the ceiling is per posture: a writer grinds, a reviewer should not',
      }),
    ]),
  }),
  Object.freeze({
    id: 'unresolved-tokens-named-as-a-comma-splice',
    date: '2026-07-28',
    symptom: 'A refusal read "`$p`, a command substitution cannot be resolved '
      + 'statically" — a comma splice that parses as one garbled subject and '
      + 'hides that two separate things need fixing.',
    cause: 'Named tokens were joined with `, ` and truncated at three with no '
      + 'remainder, so a long list also sent the reader back for a second '
      + 'refusal having fixed everything the first one mentioned.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function nameList(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'two unresolved tokens are joined, not comma-spliced',
      }),
    ]),
  }),
  Object.freeze({
    id: 'retired-artifact-absence-went-unreported',
    date: '2026-07-28',
    symptom: 'A live session probed `ls .autoloop/ci-policy.json` beside the '
      + 'reconcile audit, so a PASSING check printed `No such file or '
      + 'directory` and read as a failure.',
    cause: 'The reconcile report named the retired artifact only when it '
      + 'removed one. Silence about an absence cannot be told apart from an '
      + 'unperformed check, so a reader re-derives it with a shell probe.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'scaffold.mjs',
        anchor: 'a fresh scaffold never creates the retired CI policy, and says so',
      }),
    ]),
  }),
  Object.freeze({
    id: 'completed-step-rows-shipped-without-their-cost',
    date: '2026-07-28',
    symptom: 'Live panels showed bare completed rows (`∞ #123 — 02 PLAN '
      + '[OPUS]`) with no `[elapsed] [HH:MM]`, losing the per-step cost '
      + 'profile the panel is the only surviving record of.',
    cause: 'The rule shipped in v0.49.21 as prose only. Obeying it required '
      + 'millisecond arithmetic and a clock read in the same turn as '
      + 'collecting a result, disposing findings and swapping labels.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'step-subject.mjs', anchor: 'export function completedSubject(' }),
      Object.freeze({
        file: 'step-subject.mjs',
        anchor: 'The live defect: a bare completed row, now composed rather than recalled.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan-followed-the-review-engine-recording',
    date: '2026-07-28',
    symptom: 'A run configured to plan on `fable` and review on a proxied '
      + '`gpt-5.6-sol` planned on the review model instead: the recorded proxy '
      + 'URL and effort were injected into the plan dispatch, so the `--model '
      + 'fable` pin was resolved by the review proxy.',
    cause: 'The review-engine recording was keyed to the reviewer POSTURE, and '
      + '`plan` shares that posture for its read-only sandbox while being '
      + 'authored work. Keying on the verdict RESULT separates the two.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'function followsReviewChoice(' }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'codex refuses to author a plan, which is writing under a reading posture',
      }),
    ]),
  }),
  Object.freeze({
    id: 'interpreter-name-in-argument-position',
    date: '2026-07-28',
    symptom: '`git log --oneline | grep node` and `git log --grep xargs` were '
      + 'refused as inline interpreter source and inline command assembly — '
      + 'plain read-only history queries, denied for naming a tool.',
    cause: 'Interpreter and assembler detection searched the whole segment, so '
      + 'a search PATTERN read as an invocation. The git/gh rules already '
      + 'judged by position; these two did not.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'function invokedAt(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['git log --oneline | grep node', 'feat/gh-1-x', false]",
      }),
    ]),
  }),
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
    id: 'lessons-budget-orphaned-by-its-own-migration',
    date: '2026-07-28',
    symptom: 'LESSONS.md reached 8010 bytes with nothing reporting it, while '
      + 'ARCH had a working budget.',
    cause: 'The lessons budget was dev-skill prose naming "STATE Lessons" — a '
      + 'section the v0.49.14 diet had moved into its own file — so it pointed '
      + 'at nothing and silently never fired. A migration retargeted the '
      + 'document and left its maintenance rule behind.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'scaffold.mjs', anchor: 'const CURATED_DOCUMENTS' }),
      Object.freeze({
        file: 'scaffold.mjs',
        anchor: 'a curated document over its budget is reported with the curation rule',
      }),
    ]),
  }),
  Object.freeze({
    id: 'slice-budget-blocked-a-finished-unit',
    date: '2026-07-28',
    symptom: 'A unit with both suites green, committed and pushed was blocked '
      + 'at 722 lines against a 700-line budget, one decision short of '
      + 'shipping. The human raised the cap — the only answer that block can '
      + 'produce.',
    cause: 'STATE described all caps as blocking, so a run treated a SHAPING '
      + 'budget as a run-time gate. By the time lines are countable the work is '
      + 'done and the budget knows nothing it did not know at shaping time; a '
      + 'cap whose verdict is always the same is not a gate.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Slice budgets are the exception: they NOTE, they never block',
      }),
      Object.freeze({
        file: '../../templates/STATE.template.md',
        anchor: 'They never block a\n    unit at run time',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan-discarded-over-a-title-character',
    date: '2026-07-28',
    symptom: 'A live run spent ~40 minutes of opus re-planning because an '
      + 'em-dash in the plan TITLE discarded the entire plan, and the refusal '
      + '("structured output is not a valid plan") named neither the field nor '
      + 'the reason.',
    cause: 'A boolean validator behind a categorical message, plus a policy '
      + 'inversion: the ASCII rule exists because the ORCHESTRATOR composes '
      + 'titles from a safe allowlist, so throwing away the model-authored body '
      + 'over a title character discards the expensive artifact to protect a '
      + 'field the caller was going to author anyway.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'a rejected plan names the field, the reason, and the offending character',
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'only a non-ASCII title is salvageable by retitling, and it keeps the body',
      }),
    ]),
  }),
  Object.freeze({
    id: 'expansion-refusal-warned-of-the-wrong-hazard',
    date: '2026-07-28',
    symptom: 'A read-only `for s in …; do sed …; done` byte count was refused '
      + 'with "can hide a mutation … split discovery and mutation into separate '
      + 'tool calls" — a hazard not present — while never mentioning the loop '
      + 'variable that actually defeated resolution.',
    cause: 'One generic message served every expansion shape. Wrong advice is '
      + 'worse than none: the reader fixes the half the message names.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'a loop refusal names the loop variable and the loop remedy',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'an exit-status refusal points at the report, not at assignment',
      }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function unresolvedExpansionReason' }),
    ]),
  }),
  Object.freeze({
    id: 'proxy-probe-had-no-executable-command',
    date: '2026-07-28',
    symptom: 'A run lost a round recording the proxy engine: it read the URL '
      + 'back out of `review-engine` to probe it, and the command substitution '
      + 'was refused.',
    cause: 'The skill said to probe "the recorded URL" without giving the '
      + 'command, so a session composed one from the file it had just written. '
      + 'Same shape as the exit-3 merge contract: an outcome described without '
      + 'an executable command is an invitation to improvise into a refusal.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Write the URL as a literal',
      }),
    ]),
  }),
  Object.freeze({
    id: 'sort-versions-dropped-path-lines',
    date: '2026-07-28',
    symptom: 'Two live setups lost their first command to `ls -d <cache>/*/ | '
      + 'xargs -n1 basename` — refused for the xargs — while the skill insisted '
      + 'there was "nothing to pre-clean".',
    cause: 'The skill showed only half the pipeline (the ls half was left to '
      + 'the model), and `--sort-versions` silently dropped full-path lines, so '
      + 'the basename instinct was answering a REAL hazard with the one vehicle '
      + 'the guard refuses. The tool now takes basenames itself and the skill '
      + 'shows the complete pipeline.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'release-verify.mjs',
        anchor: 'takes the basename of path lines instead of dropping them',
      }),
      Object.freeze({
        file: '../../skills/setup/SKILL.md',
        anchor: 'ONE\n   complete pipeline',
      }),
    ]),
  }),
  Object.freeze({
    id: 'label-refusal-named-no-command',
    date: '2026-07-28',
    symptom: 'Seventeen loop runs in one day applied `human:authorize` via '
      + '`gh pr edit` (which dies on gh that still queries Projects-classic '
      + 'cards), fell back to raw `gh api …/issues/<n>/labels`, and ate the '
      + 'deny with no vehicle to retry.',
    cause: 'The refusal said "use a canonical gh issue command" without '
      + 'naming one, so every run re-derived `gh issue edit <n> --add-label` '
      + '— which works on PRs and never touches project cards. The refusal '
      + 'now names the vehicle, and the dev skill and STATE template '
      + 'prescribe it where the label self-apply is described.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'avoids the Projects-classic GraphQL failure',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'gh issue edit <pr-number> --add-label human:authorize',
      }),
      Object.freeze({
        file: '../STATE.template.md',
        anchor: 'gh issue edit <pr-number> --add-label human:authorize',
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
