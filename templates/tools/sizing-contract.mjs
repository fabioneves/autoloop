#!/usr/bin/env node
// autoloop — sizing-contract.mjs
//
// The two halves of the sizing measurement, typed.
//
// `autoloop-shape-v1` records what shaping PREDICTED about a unit: how many
// cases its invariant enumerates, how many hard invariants it carries. It rides
// in the issue body, written by `autoloop:shape`.
//
// `autoloop-outcome-v1` records what the unit actually COST: review rounds,
// whether it tripped the same-predicate escalation, how it ended. It rides in
// the run record, written by `autoloop:dev`.
//
// Only the PAIR is useful. Either alone answers nothing: a prediction with no
// outcome is an opinion, and an outcome with no prediction cannot say which
// shaping choice produced it. The sizing rule in `autoloop:shape` — one
// invariant, about five cases — is currently an argument from two runs; these
// records are what could eventually make it a measurement.
//
// Both are composed HERE rather than hand-written into a body, for the reason
// `step-subject.mjs` exists: a format recalled under load decays, and a field
// that drifts across runs makes the whole series unqueryable. A marker nobody
// validates is worse than no marker, because it looks like data.
//
// Usage:
//   node sizing-contract.mjs --shape --cases 5 --invariants 1 [--files 3] [--lines 260]
//   node sizing-contract.mjs --outcome --issue 219 --plan-rounds 1 --code-rounds 3 \
//     --result blocked [--escalated] [--prod-lines 858] [--files 14]
//   node sizing-contract.mjs --self-test

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHAPE_TAG = 'autoloop-shape-v1';
const OUTCOME_TAG = 'autoloop-outcome-v1';
const RESULTS = new Set(['shipped', 'blocked', 'deferred']);
// Generous, but bounded: a unit claiming 10000 cases is a typo or a unit that
// should never have been filed, and either way the record must not carry it.
const MAX_COUNT = 9999;

// The split rule, made binding at the moment the judgement is written. It was
// prose in `autoloop:shape` and enforced nowhere: the tool composed whatever
// count it was handed, shape filed it, and dev deliberately does not re-size.
// A live queue of 21 shaped units had 16 over the case threshold, none under
// it, and every single one claiming exactly one invariant — including one whose
// escalation later PROVED two predicates. A rule that records its own breach and
// proceeds is not a rule, and the marker was built to make this judgement
// checkable. Refusing here is the only point where splitting is still cheap.
const SPLIT_MAX_CASES = 5;
const SPLIT_MAX_INVARIANTS = 1;
const MAX_EXEMPT_REASON = 500;

// Deliberately NOT part of validateShapeRecord: that validator also parses
// markers already living in issue bodies, and every breaching record filed
// before this rule existed must keep parsing. Enforcement belongs at write
// time, where a split is still possible; reading history must never fail.
export function splitBreaches(record) {
  const breaches = [];
  if (Number.isSafeInteger(record?.cases) && record.cases > SPLIT_MAX_CASES) {
    breaches.push(
      `${record.cases} cases exceeds the ~${SPLIT_MAX_CASES} split threshold — one unit is one `
      + 'invariant whose complete case enumeration fits in about five cases',
    );
  }
  if (Number.isSafeInteger(record?.invariants) && record.invariants > SPLIT_MAX_INVARIANTS) {
    breaches.push(
      `${record.invariants} hard invariants in one unit — each is an independent chance to trip `
      + 'the same-predicate escalation, so the cost is multiplicative rather than additive',
    );
  }
  return breaches;
}

function countProblem(label, value, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value)) return `${label}: must be an integer`;
  if (value < min) return `${label}: must be >= ${min}`;
  if (value > MAX_COUNT) return `${label}: must be <= ${MAX_COUNT}`;
  return null;
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function validateShapeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record: must be an object'];
  }
  const errors = [];
  if (record.v !== 1) errors.push('v: must be 1');
  // Required, because they ARE the sizing rule. An optional case count would be
  // omitted exactly when it is inconvenient, which is when it matters.
  for (const [key, min] of [['cases', 1], ['invariants', 1]]) {
    const problem = countProblem(key, record[key], { min });
    if (problem !== null) errors.push(problem);
  }
  for (const key of ['filesEstimate', 'linesEstimate']) {
    if (record[key] === undefined) continue;
    const problem = countProblem(key, record[key], { min: 0 });
    if (problem !== null) errors.push(problem);
  }
  if (record.splitExempt !== undefined) {
    if (typeof record.splitExempt !== 'string' || record.splitExempt.trim() === '') {
      errors.push('splitExempt: must be a non-empty reason');
    } else if (record.splitExempt.length > MAX_EXEMPT_REASON) {
      errors.push(`splitExempt: must be <= ${MAX_EXEMPT_REASON} characters`);
    }
  }
  const known = new Set([
    'v', 'cases', 'invariants', 'filesEstimate', 'linesEstimate', 'splitExempt',
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`${key}: unknown field`);
  }
  return errors;
}

export function validateOutcomeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record: must be an object'];
  }
  const errors = [];
  if (record.v !== 1) errors.push('v: must be 1');
  const issueProblem = countProblem('issue', record.issue, { min: 1 });
  if (issueProblem !== null) errors.push(issueProblem);
  for (const key of ['planRounds', 'codeRounds']) {
    const problem = countProblem(key, record[key], { min: 0 });
    if (problem !== null) errors.push(problem);
  }
  if (typeof record.escalated !== 'boolean') errors.push('escalated: must be a boolean');
  if (!RESULTS.has(record.result)) {
    errors.push(`result: must be one of ${[...RESULTS].join(', ')}`);
  }
  for (const key of ['prodLines', 'files']) {
    if (record[key] === undefined) continue;
    const problem = countProblem(key, record[key], { min: 0 });
    if (problem !== null) errors.push(problem);
  }
  const known = new Set([
    'v', 'issue', 'planRounds', 'codeRounds', 'escalated', 'result', 'prodLines', 'files',
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`${key}: unknown field`);
  }
  return errors;
}

function serialize(tag, record, errors) {
  if (errors.length > 0) throw new Error(`invalid ${tag} record: ${errors.join('; ')}`);
  return `<!-- ${tag}\n${stableJson(record)}\n-->`;
}

export function serializeShapeRecord(record) {
  return serialize(SHAPE_TAG, record, validateShapeRecord(record));
}

export function serializeOutcomeRecord(record) {
  return serialize(OUTCOME_TAG, record, validateOutcomeRecord(record));
}

function parse(tag, text, validate) {
  if (typeof text !== 'string' || text.length > 1_048_576) {
    return { ok: false, error: `${tag} text is missing or too large` };
  }
  const matches = [...text.matchAll(
    new RegExp(`<!-- ${tag}\\r?\\n([\\s\\S]*?)\\r?\\n-->`, 'g'),
  )];
  // Zero is "not recorded", which a reader must tell apart from "recorded
  // twice" — a body edited by two runs is a conflict, not a later value winning.
  if (matches.length === 0) return { ok: false, error: `no ${tag} record found` };
  if (matches.length > 1) {
    return { ok: false, error: `expected exactly one ${tag} record, found ${matches.length}` };
  }
  let record;
  try {
    record = JSON.parse(matches[0][1]);
  } catch {
    return { ok: false, error: `${tag} JSON is invalid` };
  }
  const errors = validate(record);
  return errors.length === 0
    ? { ok: true, record }
    : { ok: false, error: `invalid ${tag} record: ${errors.join('; ')}` };
}

export function parseShapeRecord(text) {
  return parse(SHAPE_TAG, text, validateShapeRecord);
}

export function parseOutcomeRecord(text) {
  return parse(OUTCOME_TAG, text, validateOutcomeRecord);
}

export function parseArgs(argv) {
  const out = { mode: null, values: {}, flags: new Set(), error: null };
  const numeric = new Map([
    ['--cases', 'cases'], ['--invariants', 'invariants'],
    ['--files', 'files'], ['--lines', 'lines'],
    ['--issue', 'issue'], ['--plan-rounds', 'planRounds'],
    ['--code-rounds', 'codeRounds'], ['--prod-lines', 'prodLines'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--shape' || flag === '--outcome') {
      if (out.mode !== null) {
        out.error = 'choose exactly one of --shape or --outcome';
        return out;
      }
      out.mode = flag.slice(2);
      continue;
    }
    if (flag === '--escalated') { out.flags.add('escalated'); continue; }
    if (flag === '--split-exempt') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        out.error = '--split-exempt needs a reason';
        return out;
      }
      out.values.splitExempt = value;
      index += 1;
      continue;
    }
    if (flag === '--result') {
      const value = argv[index + 1];
      if (!RESULTS.has(value)) {
        out.error = `--result must be one of ${[...RESULTS].join(', ')}`;
        return out;
      }
      out.values.result = value;
      index += 1;
      continue;
    }
    if (numeric.has(flag)) {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value)) {
        out.error = `${flag} needs an integer`;
        return out;
      }
      out.values[numeric.get(flag)] = value;
      index += 1;
      continue;
    }
    out.error = `unknown argument ${flag}`;
    return out;
  }
  if (out.mode === null) out.error = 'choose exactly one of --shape or --outcome';
  return out;
}

export function recordFromArgs(parsed) {
  if (parsed.mode === 'shape') {
    const record = { v: 1, cases: parsed.values.cases, invariants: parsed.values.invariants };
    if (parsed.values.files !== undefined) record.filesEstimate = parsed.values.files;
    if (parsed.values.lines !== undefined) record.linesEstimate = parsed.values.lines;
    if (parsed.values.splitExempt !== undefined) record.splitExempt = parsed.values.splitExempt;
    return { serialize: serializeShapeRecord, record };
  }
  const record = {
    v: 1,
    issue: parsed.values.issue,
    planRounds: parsed.values.planRounds,
    codeRounds: parsed.values.codeRounds,
    escalated: parsed.flags.has('escalated'),
    result: parsed.values.result,
  };
  if (parsed.values.prodLines !== undefined) record.prodLines = parsed.values.prodLines;
  if (parsed.values.files !== undefined) record.files = parsed.values.files;
  return { serialize: serializeOutcomeRecord, record };
}

function selfTest() {
  let fail = 0;
  const check = (name, passed) => {
    if (!passed) { fail += 1; console.error(`FAIL ${name}`); }
  };

  const shape = { v: 1, cases: 5, invariants: 1, filesEstimate: 3, linesEstimate: 260 };
  const shapeText = serializeShapeRecord(shape);
  check('a shape record round-trips', parseShapeRecord(shapeText).record.cases === 5);
  check(
    'a shape record survives surrounding body prose',
    parseShapeRecord(`## Context\n\nwords\n\n${shapeText}\n`).ok === true,
  );
  check('cases are required', validateShapeRecord({ v: 1, invariants: 1 }).length > 0);
  check('invariants are required', validateShapeRecord({ v: 1, cases: 2 }).length > 0);
  check('zero cases is refused', validateShapeRecord({ v: 1, cases: 0, invariants: 1 }).length > 0);
  check(
    'an unknown field is refused, so drift is caught at write time',
    validateShapeRecord({ v: 1, cases: 2, invariants: 1, guess: 4 }).length > 0,
  );

  const outcome = {
    v: 1, issue: 219, planRounds: 1, codeRounds: 3, escalated: true, result: 'blocked',
    prodLines: 858, files: 14,
  };
  const outcomeText = serializeOutcomeRecord(outcome);
  check('an outcome record round-trips', parseOutcomeRecord(outcomeText).record.issue === 219);
  check(
    'a blocked outcome is recordable — the most informative row there is',
    parseOutcomeRecord(outcomeText).record.result === 'blocked',
  );
  check(
    'escalated must be explicit, never inferred from absence',
    validateOutcomeRecord({ ...outcome, escalated: undefined }).length > 0,
  );
  check(
    'an unknown result is refused',
    validateOutcomeRecord({ ...outcome, result: 'converged' }).length > 0,
  );
  check('zero rounds is legitimate', validateOutcomeRecord({ ...outcome, codeRounds: 0 }).length === 0);

  // Two markers in one body is a conflict between runs, not a later value
  // winning: a reader that took the last one would silently prefer whichever
  // edit happened to land second.
  check(
    'two records in one body are a conflict, not a last-write-wins',
    parseShapeRecord(`${shapeText}\n${shapeText}`).ok === false,
  );
  check('an absent record is reported as absent', parseShapeRecord('## Context').ok === false);
  check('malformed JSON is refused', parseShapeRecord(`<!-- ${SHAPE_TAG}\n{nope}\n-->`).ok === false);
  check(
    'the two tags never match each other',
    parseOutcomeRecord(shapeText).ok === false && parseShapeRecord(outcomeText).ok === false,
  );
  check(
    'serializing an invalid record throws rather than emitting it',
    (() => {
      try {
        serializeShapeRecord({ v: 1, cases: 0, invariants: 1 });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    'keys are stable, so a diff shows a changed VALUE and never a reordering',
    serializeShapeRecord({ invariants: 1, cases: 5, v: 1 })
      === serializeShapeRecord({ v: 1, cases: 5, invariants: 1 }),
  );

  check('args require a mode', parseArgs(['--cases', '5']).error !== null);
  check('args refuse both modes', parseArgs(['--shape', '--outcome']).error !== null);
  check('args refuse a non-integer count', parseArgs(['--shape', '--cases', 'many']).error !== null);
  check('args refuse an unknown result', parseArgs(['--outcome', '--result', 'ok']).error !== null);
  check(
    'a composed shape record matches the hand-built one',
    recordFromArgs(parseArgs(['--shape', '--cases', '5', '--invariants', '1']))
      .record.cases === 5,
  );
  check(
    'escalated defaults to false when the flag is absent',
    recordFromArgs(parseArgs([
      '--outcome', '--issue', '7', '--plan-rounds', '1', '--code-rounds', '2',
      '--result', 'shipped',
    ])).record.escalated === false,
  );

  // The breach rule. A live queue of 21 shaped units had 16 over the case
  // threshold and 0 under it, so these assertions pin the exact shapes that
  // queue produced.
  check('five cases is within the rule', splitBreaches({ cases: 5, invariants: 1 }).length === 0);
  check('six cases breaches', splitBreaches({ cases: 6, invariants: 1 }).length === 1);
  check('fifteen cases breaches', splitBreaches({ cases: 15, invariants: 1 }).length === 1);
  check('two invariants breaches', splitBreaches({ cases: 3, invariants: 2 }).length === 1);
  check(
    'both signals are reported together, never one at a time',
    splitBreaches({ cases: 9, invariants: 2 }).length === 2,
  );
  check(
    'a breaching record still PARSES — history filed before the rule must stay readable',
    parseShapeRecord(
      '<!-- autoloop-shape-v1\n{"cases":7,"filesEstimate":5,"invariants":1,"linesEstimate":210,"v":1}\n-->',
    ).ok === true,
  );
  check(
    'an exemption reason round-trips in the marker',
    parseShapeRecord(serializeShapeRecord({
      v: 1, cases: 7, invariants: 1, splitExempt: 'AST grammar cases are irreducible',
    })).record.splitExempt === 'AST grammar cases are irreducible',
  );
  check(
    'an empty exemption is refused, so the flag cannot be used as a silent override',
    validateShapeRecord({ v: 1, cases: 7, invariants: 1, splitExempt: '  ' }).length > 0,
  );
  check(
    'args refuse a bare --split-exempt with no reason',
    parseArgs(['--shape', '--cases', '7', '--invariants', '1', '--split-exempt']).error !== null,
  );
  check(
    'args refuse --split-exempt swallowing the next flag as its reason',
    parseArgs(['--shape', '--split-exempt', '--cases', '7']).error !== null,
  );
  check(
    'a composed exempt record carries the reason',
    recordFromArgs(parseArgs([
      '--shape', '--cases', '7', '--invariants', '1', '--split-exempt', 'irreducible',
    ])).record.splitExempt === 'irreducible',
  );

  const total = 32;
  console.log(fail === 0 ? `self-test OK (${total} cases)` : `self-test: ${fail} FAILED`);
  return fail === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== null) {
    console.error(`sizing-contract: ${parsed.error}`);
    process.exit(1);
  }
  let output;
  try {
    const { serialize: emit, record } = recordFromArgs(parsed);
    if (parsed.mode === 'shape' && record.splitExempt === undefined) {
      const breaches = splitBreaches(record);
      if (breaches.length > 0) {
        console.error(`sizing-contract: refused — ${breaches.join('; and ')}.`);
        console.error(
          'Split at the invariant boundary and chain the halves with `## Blocked by`. A slice that '
          + 'reads as trivially small is the correct size, not a reason to bundle it.',
        );
        console.error(
          'If this unit genuinely cannot be split, record why and it will be emitted: '
          + '--split-exempt "<reason>". The reason rides in the marker, so an exception is a '
          + 'decision someone made rather than a threshold nobody applied.',
        );
        process.exit(2);
      }
    }
    output = emit(record);
  } catch (error) {
    console.error(`sizing-contract: ${error.message}`);
    process.exit(1);
  }
  console.log(output);
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
