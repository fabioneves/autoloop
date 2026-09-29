#!/usr/bin/env node
// autoloop — run-state-guard.mjs
//
// The run's own state is off limits to the run. The command guard enforces
// only while a run is open, and "open" is evidenced by files — the run markers
// under <git-common-dir>/autoloop/run and the session latch under
// ~/.claude/autoloop/run-latches — so a run that could delete or forge them
// could switch its own guard off (security audit after 0.60.0). This module
// judges one Bash command against those directories:
//
//   - a redirection into one is a write, whatever the command;
//   - a command that is not read-only may not name a path inside one;
//   - a recursive or relocating command (rm -r, find -delete, mv, rsync,
//     chmod -R, a copy that lands the same name) may not name an ancestor —
//     `rm -rf .git` deletes the markers without naming them.
//
// Globs are matched segment by segment, literal cd/pushd steps (and subshell
// scope) are followed, and `~`/$HOME are expanded. Reading the state (cat, jq,
// ls) stays allowed. The guard runs as the session's own user, so a script
// file the run writes and then executes can still reach both records; inline
// interpreter source is refused elsewhere, and the enforcement boundary stays
// the repository's server-side rules.
//
//   node <plugin-tools>/run-state-guard.mjs --self-test

import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const READ_ONLY = new Set([
  '[', 'basename', 'cat', 'cmp', 'diff', 'dirname', 'du', 'echo', 'egrep', 'false', 'fgrep', 'file',
  'gh', 'git', 'grep', 'head', 'jq', 'less', 'ls', 'md5sum', 'more', 'printf', 'pwd', 'readlink',
  'realpath', 'rg', 'sha1sum', 'sha256sum', 'stat', 'tail', 'test', 'tree', 'true', 'wc',
]);
const WRAPPERS = new Set([
  'command', 'doas', 'env', 'exec', 'ionice', 'nice', 'nohup', 'setsid', 'stdbuf', 'sudo', 'time', 'timeout',
  // Shell keywords that put a command after them: `do rm "$f"` runs rm.
  '!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while',
]);
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const PLACING = new Set(['cp', 'install', 'ln', 'mv', 'rsync']);
// Expansion syntax — a `$` in a regex argument (`'^\.ddev$|x'`) is not one.
const EXPANSION = /\$(?:[A-Za-z_{(]|\d)|`/u;
const RECURSIVE_FLAG = /^-[A-Za-z]*[rR]/u;
const REDIRECT = /^(?:\d*|&)(?:>>?|>\||<>)(.*)$/u;
// Input redirections, here-docs and here-strings read: `< file` is no operand.
const INPUT = /^\d*<(?!>)(?:<<|<-?)?(.*)$/u;

export const MAX_TRACKED_WORDS = 20_000;

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

// The executable's index, behind wrappers, their options and assignments.
function headIndex(words) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (isAssignment(word) || WRAPPERS.has(basename(word)) || /^\d+[smhd]?$/u.test(word)) continue;
    if (word.startsWith('-') && index > 0 && WRAPPERS.has(basename(words[0]))) continue;
    return index;
  }
  return -1;
}

// `~`, $HOME and the command's own literal assignments (`S=/tmp/x; rm -rf $S/y`).
function expand(word, home, vars = new Map()) {
  const text = word.replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/u, home)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);
  if (text === '~') return home;
  return text.startsWith('~/') ? `${home}${text.slice(1)}` : text;
}

// An absolute path for a word, or null when it cannot be known (an
// unresolved expansion, or a relative path after an unknown cd).
function pathOf(word, dir, home, vars) {
  const text = expand(word, home, vars);
  if (text === '' || EXPANSION.test(text)) return null;
  if (isAbsolute(text)) return resolve(text);
  return dir === null ? null : resolve(dir, text);
}

// A glob segment against one name. Runs of `*` collapse, and a segment with
// more wildcards than a protected name could need counts as matching: many
// `.*` in one pattern backtrack exponentially.
function segmentMatches(pattern, name) {
  if (pattern === '**') return true;
  if (!/[*?[]/u.test(pattern)) return pattern === name;
  const collapsed = pattern.replace(/\*+/gu, '*');
  if ((collapsed.match(/[*?]/gu) ?? []).length > 8) return true;
  const source = collapsed.replace(/[.+^${}()|\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.');
  try {
    return new RegExp(`^${source}$`, 'u').test(name);
  } catch {
    return pattern === name; // not a glob the shell could expand either
  }
}

// How a path (possibly a glob) relates to a protected directory: 'inside'
// (it or below), 'ancestor' (above), or null.
export function relation(path, protectedDir) {
  const left = path.split('/').filter(Boolean);
  const right = protectedDir.split('/').filter(Boolean);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] === '**') return 'inside';
    if (!segmentMatches(left[index], right[index])) return null;
  }
  return left.length >= right.length ? 'inside' : 'ancestor';
}

// The component of a protected directory just below an ancestor path.
function childBelow(ancestor, protectedDir) {
  const depth = ancestor.split('/').filter(Boolean).length;
  return protectedDir.split('/').filter(Boolean)[depth] ?? null;
}

function operands(words, from) {
  const result = [];
  let options = true;
  for (let index = from; index < words.length; index += 1) {
    const word = words[index];
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-')) {
      const equals = word.indexOf('=');
      if (equals !== -1) result.push(word.slice(equals + 1));
      continue;
    }
    result.push(word);
    // key=value operands (dd's of=, make's DESTDIR=) name paths too.
    const assigned = /^[A-Za-z_][A-Za-z0-9_-]*=(.+)$/u.exec(word);
    if (assigned !== null) result.push(assigned[1]);
  }
  return result;
}

function findStarts(words, from) {
  const starts = [];
  for (let index = from; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith('-') || word === '(' || word === '!' || word === '\\(') break;
    starts.push(word);
  }
  return starts.length === 0 ? ['.'] : starts;
}

// How one command treats its operands: 'read', 'write' (inside only),
// 'recursive' (inside or ancestor), or 'placing' (inside, an ancestor source,
// or a destination whose landing name is the protected one).
function kind(words, head) {
  const name = basename(words[head] ?? '');
  const rest = words.slice(head + 1);
  if (name === 'find') return rest.some((word) => FIND_ACTIONS.has(word)) ? 'recursive' : 'read';
  if (name === 'sed' || name === 'perl') return rest.some((word) => /^-[A-Za-z]*i/u.test(word) || word.startsWith('--in-place')) ? 'write' : 'read';
  if (READ_ONLY.has(name)) return 'read';
  if (name === 'rm' || name === 'chmod' || name === 'chown' || name === 'chgrp') {
    return rest.some((word) => RECURSIVE_FLAG.test(word) || word === '--recursive') ? 'recursive' : 'write';
  }
  if (name === 'rsync' && rest.some((word) => word.startsWith('--delete'))) return 'recursive';
  if (PLACING.has(name)) return 'placing';
  if (name === 'tar' || name === 'unzip') return 'recursive';
  if (name === 'xargs' || name === 'parallel') {
    // Judged by the command it runs: past its options (and their values).
    let index = head + 1;
    while (index < words.length && words[index].startsWith('-')) {
      index += /^-[IndPLEs]$/u.test(words[index]) ? 2 : 1;
    }
    return index < words.length ? kind(words, index) : 'write';
  }
  return 'write';
}

function refusal(path, protectedDir) {
  return `autoloop guard — this command would change ${path}, which holds (or contains) this run's `
    + `own state (${protectedDir}): the run markers and the session latch are how the guard knows a `
    + 'run is open, so a run never writes, moves or deletes them. Reading them is fine (cat, jq, ls). '
    + 'A run that is finished closes with `prime.mjs --close-run`.';
}

// segments: [{ words, opens, closes }] in order — the words of each shell
// segment, and how many subshell parentheses open before it and close after.
export function runStateProblem(segments, { cwd, protectedDirs, home = homedir() }) {
  const dirs = [...new Set(protectedDirs.filter((dir) => typeof dir === 'string' && isAbsolute(dir)))];
  if (dirs.length === 0) return null;
  if (segments.reduce((total, segment) => total + segment.words.length, 0) > MAX_TRACKED_WORDS) {
    return 'autoloop guard — this command is too large to check for changes to the run\'s own '
      + 'state, so it cannot be proven safe. Split it into smaller commands.';
  }
  const placed = placeSegments(segments, typeof cwd === 'string' && isAbsolute(cwd) ? cwd : null, home);
  const judge = (word, at, allowed) => {
    const path = pathOf(word, at.dir, home, at.vars);
    if (path === null) return null;
    for (const protectedDir of dirs) {
      const found = relation(path, protectedDir);
      if (found !== null && allowed.includes(found)) return { path, protectedDir, found };
    }
    return null;
  };
  let piped = false;
  for (const at of placed) {
    // Redirections write, whatever the command.
    for (const target of at.writes) {
      const hit = judge(target, at, ['inside']);
      if (hit !== null) return refusal(hit.path, hit.protectedDir);
    }
    const { argv, head } = at;
    const name = head === -1 ? '' : basename(argv[head] ?? '');
    if (head === -1 || ['cd', 'pushd', 'popd'].includes(name)) continue;
    const treatment = kind(argv, head);
    if (treatment === 'read') continue;
    const list = name === 'find' ? findStarts(argv, head + 1) : operands(argv, head + 1);
    const allowed = treatment === 'write' ? ['inside'] : ['inside', 'ancestor'];
    const candidates = treatment === 'placing' ? list.slice(0, -1) : list;
    // A copy or link only reads its sources; a move relocates them.
    const sourceAllowed = treatment !== 'placing' ? allowed
      : name === 'mv' || argv.includes('--remove-source-files') ? ['inside', 'ancestor'] : [];
    for (const word of candidates) {
      const hit = judge(word, at, sourceAllowed);
      if (hit !== null) return refusal(hit.path, hit.protectedDir);
    }
    if (treatment === 'placing' && list.length > 0) {
      const destination = list.at(-1);
      const inside = judge(destination, at, ['inside']);
      if (inside !== null) return refusal(inside.path, inside.protectedDir);
      const above = judge(destination, at, ['ancestor']);
      if (above !== null) {
        const landing = childBelow(above.path, above.protectedDir);
        const lands = candidates.some((source) => {
          const leaf = basename(source);
          return source.endsWith('/') || leaf === '.' || /[*?[]/u.test(leaf) || leaf === landing;
        });
        if (lands) return refusal(above.path, above.protectedDir);
      }
    }
    // xargs/parallel take their operands from the pipe, and an operand that is
    // an unresolved expansion (`rm "$f"` in a read loop) comes from elsewhere
    // in the command, so what the other segments name — each resolved where
    // it runs — is a candidate: a path inside the run state; any ancestor a
    // `find` walks from; and, for a recursive consumer (`xargs rm -rf`), the
    // state's near parents (`.git`, `~/.claude`). Never the repository root
    // in general — nearly every command names it.
    const inner = name === 'xargs' || name === 'parallel';
    const unresolved = candidates.some((word) => EXPANSION.test(expand(word, home, at.vars)));
    if (!(inner || unresolved) || piped) continue;
    piped = true;
    for (const other of placed) {
      const otherName = basename(other.argv[other.head] ?? '');
      if (other.head === -1 || otherName === 'cd' || otherName === 'pushd') continue;
      const starts = otherName === 'find' ? new Set(findStarts(other.argv, other.head + 1)) : new Set();
      for (const word of other.argv.slice(other.head + 1)) {
        const hit = judge(word, other, ['inside', 'ancestor']);
        if (hit === null) continue;
        const depth = hit.protectedDir.split('/').filter(Boolean).length - hit.path.split('/').filter(Boolean).length;
        if (hit.found === 'inside' || starts.has(word) || (treatment === 'recursive' && depth <= 2)) {
          return refusal(hit.path, hit.protectedDir);
        }
      }
    }
  }
  return null;
}

// Where each segment runs and what it can see: literal cd/pushd steps (and
// subshell scope) move the directory, `env -C` moves one segment, bare
// assignments define variables, and redirections are split from the argv.
function placeSegments(segments, cwd, home) {
  let dir = cwd;
  const stack = [];
  const vars = new Map();
  return segments.map((segment) => {
    for (let open = 0; open < segment.opens; open += 1) stack.push(dir);
    const list = segment.words;
    const head = headIndex(list);
    if (head === -1) {
      for (const word of list.filter(isAssignment)) {
        const [name, ...value] = word.split('=');
        const text = value.join('=');
        if (/[$`]/u.test(text)) vars.delete(name);
        else vars.set(name, text);
      }
    }
    const scope = new Map(vars);
    const chdir = list.findIndex((word, index) => index < head && (word === '-C' || word === '--chdir'));
    const segmentDir = chdir === -1 ? dir : pathOf(list[chdir + 1] ?? '', dir, home, scope);
    const argv = [];
    const writes = [];
    for (let index = 0; index < list.length; index += 1) {
      const input = index > head ? INPUT.exec(list[index]) : null;
      if (input !== null) {
        if (input[1] === '') index += 1;
        continue;
      }
      const match = index < head ? null : REDIRECT.exec(list[index]);
      if (match === null) {
        argv.push(list[index]);
        continue;
      }
      const target = match[1] !== '' ? match[1] : list[index + 1] ?? '';
      if (match[1] === '') index += 1;
      if (!target.startsWith('&')) writes.push(target);
    }
    const name = head === -1 ? '' : basename(argv[head] ?? '');
    if (name === 'cd' || name === 'pushd') {
      const target = argv[head + 1];
      dir = target === undefined || target.startsWith('-') ? null : pathOf(target, dir, home, scope);
    } else if (name === 'popd') {
      dir = null;
    }
    // A close with no open seen is a substitution's `)`, not a subshell's.
    const placedSegment = { argv, head, writes, dir: segmentDir, vars: scope };
    for (let close = 0; close < segment.closes && stack.length > 0; close += 1) dir = stack.pop();
    return placedSegment;
  });
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const home = '/home/u';
  const repo = '/r';
  const protectedDirs = [`${repo}/.git/autoloop/run`, `${home}/.claude/autoloop/run-latches`];
  // A minimal tokenizer for the fixtures; the guard passes its own.
  const segmentsOf = (command) => command.split(/\s*(?:&&|\|\||;|\|)\s*/u).filter(Boolean).map((text) => {
    const opens = /^\(+/u.exec(text)?.[0].length ?? 0;
    const closes = /\)+$/u.exec(text)?.[0].length ?? 0;
    return { words: text.slice(opens, text.length - closes).trim().split(/\s+/u), opens, closes };
  });
  const refused = (command, cwd = repo) => runStateProblem(segmentsOf(command), { cwd, protectedDirs, home }) !== null;
  const tampering = [
    'rm -f .git/autoloop/run/1.json',
    'rm -rf .git/autoloop',
    'rm -rf .git',
    'rm -r ./.git/autoloop/run',
    'mv .git/autoloop/run /tmp/x',
    'mv .git/autoloop /tmp/x',
    'echo {} > .git/autoloop/run/a.json',
    'printf x >.git/autoloop/run/a.json',
    'cat /tmp/forged 1>> .git/autoloop/run/a.json',
    'cp /tmp/forged.json .git/autoloop/run/b.json',
    'cp -r /tmp/fake/autoloop .git/',
    'cp -r /tmp/fake/. .git/autoloop/',
    'mv /tmp/run .git/autoloop/',
    'ln -sf /tmp/x .git/autoloop/run/c.json',
    'tee .git/autoloop/run/a.json',
    'truncate -s0 .git/autoloop/run/1.json',
    'sed -i s/a/b/ .git/autoloop/run/1.json',
    'find . -name *.json -delete',
    'find .git -path *run* -exec rm {} +',
    'rm -rf .g*/a*/r*',
    'rm .git/autoloop/run/*',
    'cd .git/autoloop && rm -rf run',
    'cd .git; rm -rf autoloop',
    'pushd .git/autoloop/run && rm 1.json',
    '(cd /tmp) ; cd .git/autoloop ; rm -rf run',
    'env -C .git/autoloop rm -rf run',
    'rm -rf ~/.claude/autoloop/run-latches',
    'rm -rf $HOME/.claude/autoloop',
    'rm -rf ${HOME}/.claude',
    'rm -rf ~',
    'rm -rf /',
    'chmod -R 000 .git',
    'rsync -a --delete /tmp/empty/ .git/autoloop/',
    'echo .git/autoloop/run | xargs rm -rf',
    'find . -type f | xargs rm',
    'dd if=/dev/null of=.git/autoloop/run/1.json',
    'tar -xf /tmp/t.tar -C .git',
    'find . -name *.json | while read f ; do rm $f ; done',
    'for f in .git/autoloop/run/* ; do rm $f ; done',
    'if true ; then rm -rf .git/autoloop ; fi',
  ].filter((command) => !refused(command));
  check('every shape that writes, moves or deletes the run state is refused', tampering.length === 0);
  if (tampering.length > 0) console.error(`  evaded: ${JSON.stringify(tampering)}`);
  const ordinary = [
    'cat .git/autoloop/run/1.json',
    'jq . .git/autoloop/run/1.json',
    'ls -la .git/autoloop/run',
    'rg -n baseBranch .git/autoloop/run',
    'git status',
    'git add .',
    'rm -f src/old.ts',
    'rm -rf dist node_modules/.cache',
    'mv src/a.ts src/b.ts',
    'cp -r fixtures/ /tmp/x',
    'mv /tmp/result.json .',
    'find . -name *.orig',
    'echo done > /tmp/autoloop-354/note.md',
    'cd /tmp/autoloop-354 && rm -rf live',
    'sed -n 1,5p .git/autoloop/run/1.json',
    'npm test > /tmp/out.txt 2>&1',
    'rm -rf .autoloop/tmp',
    'for f in src/*.ts ; do rm $f ; done',
    'cd /r ; rm -rf $SCRATCH',
    'cd /r && git diff --name-only | xargs rm -f',
    'node tools/release-verify.mjs --fingerprint-stdin < .git/autoloop/run/1.json',
    'node x.mjs <.git/autoloop/run/1.json',
    'rsync -a --files-from=- ./ /tmp/copy/',
    "fd -H '^CLAUDE.md$|^x$' . --exclude .git",
    'find src -name .git | while read f ; do cmp $f /tmp/x ; done',
    'git -C /r show HEAD:a > /tmp/a ; for f in a b ; do diff /tmp/$f $f ; done',
  ].filter((command) => refused(command));
  check('reading the run state, and ordinary work elsewhere, is not refused', ordinary.length === 0);
  if (ordinary.length > 0) console.error(`  false positives: ${JSON.stringify(ordinary)}`);
  check('nothing is judged without protected directories',
    runStateProblem(segmentsOf('rm -rf .git'), { cwd: repo, protectedDirs: [], home }) === null);
  check('a relative path after an unknown cd is not resolved against the old directory',
    !refused('cd "$X" && rm -rf run'));
  const padded = [`rm -rf ${'*'.repeat(5000)}x/${'?*'.repeat(2000)}`, `${'xargs rm ; '.repeat(3000)}ls`];
  const paddedAt = Date.now();
  for (const command of padded) refused(command);
  check('padded globs and pipelines stay fast', Date.now() - paddedAt < 1000);
  check('glob segments match like the shell does', relation('/r/.g?t/*', '/r/.git/autoloop/run') === 'ancestor'
    && relation('/r/.git/autoloop/run/*.json', '/r/.git/autoloop/run') === 'inside'
    && relation('/r/src/*', '/r/.git/autoloop/run') === null);
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
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
  console.error('usage: run-state-guard.mjs --self-test');
  process.exit(2);
}
