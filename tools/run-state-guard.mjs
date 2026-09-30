#!/usr/bin/env node
// autoloop — run-state-guard.mjs
//
// The run's own state — and the guard's own code — is off limits to the run.
// The command guard enforces only while a run is open, and "open" is evidenced
// by files: the run markers under <git-common-dir>/autoloop/run and the
// session latch under ~/.claude/autoloop/run-latches. A run that could delete
// or forge them, or rewrite the plugin's tools and hooks, could switch its own
// guard off (security audit after 0.60.0). This module judges one Bash command
// against those protected directories.
//
// Matching dangerous word-forms one by one lost to the shell's rewriting
// (brace expansion, ANSI-C quotes, symlinks, `git --work-tree … clean`), so a
// command that deletes, moves, copies over or re-permissions is PROVEN
// instead: each operand must resolve to a concrete path — braces expanded,
// variables known, the directory known, symlinks resolved — that is neither
// inside nor above a protected directory. What cannot be proven is refused.
// Every other command may not name a path inside one, and a redirection into
// one is a write whatever the command. Reading the state (cat, jq, ls) stays
// allowed.
//
// The guard runs as the session's own user: a script the run writes to a file
// and then executes can still reach any of it, so the enforcement boundary
// stays the repository's server-side rules.
//
//   node <plugin-tools>/run-state-guard.mjs --self-test

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_ONLY = new Set([
  '[', 'basename', 'cat', 'cmp', 'diff', 'dirname', 'du', 'echo', 'egrep', 'false', 'fd', 'fgrep', 'file',
  'grep', 'head', 'jq', 'less', 'ls', 'md5sum', 'more', 'printf', 'pwd', 'readlink', 'realpath', 'rg',
  'sha1sum', 'sha256sum', 'stat', 'tail', 'test', 'tree', 'true', 'wc',
]);
const WRAPPERS = new Set([
  'command', 'doas', 'env', 'exec', 'ionice', 'nice', 'nohup', 'setsid', 'stdbuf', 'sudo', 'time', 'timeout',
  // Shell keywords that put a command after them: `do rm "$f"` runs rm.
  '!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while',
]);
// Commands whose operands must be proven: they delete, move, overwrite or
// re-permission what they name, or (chmod, chown) lock the guard out of it.
const DESTRUCTIVE = new Set([
  'chgrp', 'chmod', 'chown', 'cp', 'dd', 'install', 'ln', 'mkfifo', 'mknod', 'mv', 'rm', 'rmdir', 'rsync',
  'shred', 'tar', 'tee', 'truncate', 'unlink', 'unzip',
]);
// Copies read their sources; only a move (or a symlink, whose source becomes
// reachable under a new name) puts its sources at stake.
const COPYING = new Set(['cp', 'install', 'rsync']);
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
// git subcommands that write where their paths (or an explicit work tree) point.
const GIT_WRITING = new Set(['archive', 'checkout', 'checkout-index', 'clean', 'clone', 'init', 'mv', 'reset', 'restore', 'rm', 'worktree']);
const GIT_VALUED = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '-c', '--config-env']);
// gh commands that write files where an option (or, for clone, the operand) says.
const GH_OUTPUTS = new Set(['-D', '--dir', '-O', '--output']);
// Expansion syntax — a `$` in a regex argument (`'^\.ddev$|x'`) is not one.
const EXPANSION = /\$(?:[A-Za-z_{(]|\d)|`/u;
const REDIRECT = /^(?:\d*|&)(?:>>?|>\||<>|>&)(.*)$/u;
// Input redirections, here-docs and here-strings read: `< file` is no operand.
const INPUT = /^\d*<(?![>&])(?:<<|<-?)?(.*)$/u;
const MAX_TRACKED_WORDS = 20_000;
const MAX_BRACE_WORDS = 64;

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

// The executable's index, behind wrappers, their options and assignments.
function headIndex(words, from = 0) {
  for (let index = from; index < words.length; index += 1) {
    const word = words[index];
    if (isAssignment(word) || WRAPPERS.has(basename(word)) || /^\d+[smhd]?$/u.test(word)) continue;
    if (word.startsWith('-') && index > from && WRAPPERS.has(basename(words[from]))) continue;
    return index;
  }
  return -1;
}

// Brace expansion, as the shell does it before anything else: `{a,b}` lists
// and `{x..y}` ranges, nested, capped. null when the cap is exceeded.
export function expandBraces(word, limit = MAX_BRACE_WORDS) {
  let results = [word];
  for (let round = 0; round < 16; round += 1) {
    const next = [];
    let changed = false;
    for (const item of results) {
      const open = findBraceOpen(item);
      if (open === null) {
        next.push(item);
        continue;
      }
      changed = true;
      const { start, end, parts } = open;
      for (const part of parts) next.push(item.slice(0, start) + part + item.slice(end + 1));
      if (next.length > limit) return null;
    }
    results = next;
    if (!changed) return results;
  }
  return null;
}

// The first brace group that closes, in one pass (innermost first: the
// words it yields are the same set the shell's outermost-first order gives).
function findBraceOpen(word) {
  const open = [];
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index];
    if (char === '{') {
      open.push({ start: index, commas: [] });
    } else if (char === ',' && open.length > 0) {
      open.at(-1).commas.push(index);
    } else if (char === '}' && open.length > 0) {
      const { start, commas } = open.pop();
      if (commas.length > 0) {
        const cuts = [start, ...commas, index];
        return { start, end: index, parts: cuts.slice(0, -1).map((cut, at) => word.slice(cut + 1, cuts[at + 1])) };
      }
      const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/u.exec(word.slice(start + 1, index));
      if (range !== null) return { start, end: index, parts: rangeParts(range[1], range[2]) };
    }
  }
  return null;
}

function rangeParts(from, to) {
  const numeric = /^-?\d+$/u.test(from) && /^-?\d+$/u.test(to);
  const [low, high] = numeric ? [Number(from), Number(to)] : [from.charCodeAt(0), to.charCodeAt(0)];
  const step = low <= high ? 1 : -1;
  const parts = [];
  for (let value = low; parts.length <= MAX_BRACE_WORDS; value += step) {
    parts.push(numeric ? String(value) : String.fromCharCode(value));
    if (value === high) break;
  }
  return parts;
}

const SPECIAL_PARAMETER = /\$(?:\$|!|\?|#|\d)/gu;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu;
// An unknown value whose origin mentions the git dir or the Claude config dir
// may be the run state (`"$(git rev-parse --git-dir)"/autoloop`).
const SMELL = /rev-parse|\.git(?![\w-])|autoloop|\.claude|run-latches|\bHOME\b|~/u;
const MAX_ALTERNATIVES = 64;

function homeExpanded(text, home) {
  const expanded = text.replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/u, home);
  if (expanded === '~') return home;
  return expanded.startsWith('~/') ? `${home}${expanded.slice(1)}` : expanded;
}

// A word's variables substituted, left to right, in one pass: a known one
// by each of its values (a loop variable stands for every item), an unknown
// one kept — with its smell. null past the cap.
function substitute(text, vars) {
  let results = [{ text: '', smell: false }];
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const literal = text.slice(last, match.index);
    last = match.index + match[0].length;
    const entry = vars.get(match[1] ?? match[2]);
    const smell = entry?.smell === true;
    if (entry?.values == null) {
      results = results.map((result) => ({ text: result.text + literal + match[0], smell: result.smell || smell }));
      continue;
    }
    const next = [];
    for (const result of results) {
      for (const value of entry.values) next.push({ text: result.text + literal + value, smell: result.smell || smell });
    }
    if (next.length > MAX_ALTERNATIVES) return null;
    results = next;
  }
  const tail = text.slice(last);
  return results.map((result) => ({ ...result, text: result.text + tail }));
}

// Every text a word can stand for — `~`, $HOME, special parameters and the
// command's own variables substituted, braces expanded — as { text, smell }.
// null past the cap.
function expansions(word, home, vars) {
  const substituted = substitute(homeExpanded(word.replace(SPECIAL_PARAMETER, '0'), home), vars);
  if (substituted === null) return null;
  const results = [];
  for (const { text, smell } of substituted) {
    const braced = expandBraces(text);
    if (braced === null || results.length + braced.length > MAX_ALTERNATIVES) return null;
    const inline = /\$\(|`/u.test(text) && SMELL.test(text);
    for (const alternative of braced) results.push({ text: alternative, smell: smell || inline });
  }
  return results;
}

// The real location of a path whose leading part exists: symlinks made by an
// earlier command are followed, glob segments are kept as they are.
function canonical(path) {
  const parts = path.split('/');
  const globAt = parts.findIndex((part) => /[*?[]/u.test(part));
  let prefix = globAt === -1 ? path : parts.slice(0, globAt).join('/') || '/';
  const rest = globAt === -1 ? [] : parts.slice(globAt);
  const tail = [];
  for (let guard = 0; guard < 256 && prefix !== '/' && !existsSync(prefix); guard += 1) {
    tail.unshift(basename(prefix));
    prefix = dirname(prefix);
  }
  try {
    return join(realpathSync(prefix), ...tail, ...rest);
  } catch {
    return path;
  }
}

// What a word names where a segment runs: the concrete paths (and their real
// locations), and the texts that stay unknown — an unresolved expansion, or a
// relative path after a cd the guard could not follow. null past the cap.
function resolveWord(word, at, home) {
  const alternatives = expansions(word, home, at.vars);
  if (alternatives === null) return null;
  const paths = [];
  const unknowns = [];
  for (const { text, smell } of alternatives) {
    if (text === '') continue;
    if (EXPANSION.test(text)) {
      unknowns.push({ text, smell });
    } else if (!isAbsolute(text) && at.dir === null) {
      unknowns.push({ text, smell: smell || at.dirSmell, relative: true });
    } else {
      const path = isAbsolute(text) ? resolve(text) : resolve(at.dir, text);
      paths.push(path);
      const real = canonical(path);
      if (real !== path) paths.push(real);
    }
  }
  return { paths, unknowns };
}

// Whether a text the guard cannot resolve could still be the run state: its
// origin smells of the git dir or the Claude config dir; a literal part names
// a run-state component (`$X/autoloop`, `cd "$X" && rm -rf run`); or its
// literal lead sits inside the state or within two levels above it
// (`.git/$X`, `~/.claude/$X`).
function unknownIsRisky({ text, smell, relative }, at, dirs, components, home) {
  if (smell) return true;
  const first = relative ? 0 : text.search(EXPANSION);
  const literal = text.replace(new RegExp(EXPANSION.source, 'gu'), '/').split('/');
  if (literal.some((part) => components.has(part))) return true;
  if (first <= 0) return false;
  // Bounded alternatives: each stops at the next `$`, `{` or `(`, so a padded
  // word cannot make the replacement quadratic.
  const pattern = text.replace(/\$\{[^}${(]*\}?|\$\([^)${(]*\)?|\$[A-Za-z_][A-Za-z0-9_]*|`[^`${(]*`?/gu, '*');
  if (!isAbsolute(pattern) && at.dir === null) return false;
  const path = isAbsolute(pattern) ? resolve(pattern) : resolve(at.dir, pattern);
  return dirs.some((protectedDir) => {
    const found = relation(path, protectedDir);
    if (found === 'inside') return true;
    if (found !== 'ancestor') return false;
    return protectedDir.split('/').filter(Boolean).length - path.split('/').filter(Boolean).length <= 2;
  });
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

function operands(words, from, valued = new Set()) {
  const result = [];
  let options = true;
  for (let index = from; index < words.length; index += 1) {
    const word = words[index];
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-') && word !== '-') {
      const equals = word.indexOf('=');
      if (equals !== -1) result.push(word.slice(equals + 1));
      else if (valued.has(word) && index + 1 < words.length) result.push(words[++index]);
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

// The commands a find's -exec family runs.
function findActionCommands(words, from) {
  const commands = [];
  for (let index = from; index < words.length; index += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[index])) continue;
    const end = words.findIndex((word, at) => at > index && (word === ';' || word === '\\;' || word === '+'));
    commands.push(words.slice(index + 1, end === -1 ? words.length : end));
  }
  return commands;
}

function optionValues(words, from, names) {
  const values = [];
  for (let index = from; index < words.length; index += 1) {
    const word = words[index];
    const equals = word.indexOf('=');
    if (equals !== -1 && names.has(word.slice(0, equals))) values.push(word.slice(equals + 1));
    else if (names.has(word) && index + 1 < words.length) values.push(words[++index]);
    else if (word.length > 2 && /^-[A-Za-z]/u.test(word) && names.has(word.slice(0, 2))) values.push(word.slice(2));
  }
  return values;
}

// What one command asks of its operands: claims of { word, relations, prove }.
// relations: which relations to a protected directory refuse ('inside',
// 'ancestor', 'near' — an ancestor at most two levels up, 'landing' — an
// ancestor a copy lands the protected name in); prove: a word that cannot be
// resolved refuses the command.
function claims(words, head) {
  const name = basename(words[head] ?? '');
  const rest = words.slice(head + 1);
  const at = head + 1;
  const all = (list, relations, prove) => list.map((word) => ({ word, relations, prove }));
  if (READ_ONLY.has(name)) return [];
  if (name === 'sed' || name === 'perl') {
    return rest.some((word) => /^-[A-Za-z]*i/u.test(word) || word.startsWith('--in-place'))
      ? all(operands(words, at), ['inside'], false) : [];
  }
  if (name === 'find') return findClaims(words, at);
  if (name === 'xargs' || name === 'parallel') {
    // Judged by the command it runs: past its options (and their values). A
    // destructive one takes its operands from the pipe, which nothing proves.
    let index = at;
    while (index < words.length && words[index].startsWith('-')) index += /^-[IndPLEs]$/u.test(words[index]) ? 2 : 1;
    if (index >= words.length) return [];
    const fed = claims([...words, '$XARGS_INPUT'], index);
    return fed.some(({ prove }) => prove) ? [{ word: null, relations: [], prove: true }] : claims(words, index);
  }
  if (name === 'git') return gitClaims(words, head);
  if (name === 'gh') {
    const clone = rest.indexOf('clone');
    const cloned = clone === -1 ? [] : operands(words, at + clone + 1).slice(1);
    return all([...optionValues(words, at, GH_OUTPUTS), ...cloned], ['inside', 'ancestor'], true);
  }
  // Any other program may not name a path inside the run state (a script
  // told to write there); running or reading the plugin's own code is fine.
  if (!DESTRUCTIVE.has(name)) return all(operands(words, at), ['inside'], false).map((claim) => ({ ...claim, stateOnly: true }));
  if (name === 'tar' || name === 'unzip') {
    const extracting = name === 'unzip' || rest.some((word) => /^-?[A-Za-wyz]*x/u.test(word) || word === '--extract' || word === '--get');
    if (!extracting) return all(optionValues(words, at, new Set(['-f', '--file'])), ['inside'], true);
    const targets = optionValues(words, at, new Set(['-C', '--directory', '-d']));
    return all(targets.length > 0 ? targets : ['.'], ['inside', 'ancestor'], true);
  }
  if (name === 'dd') return all(rest.filter((word) => word.startsWith('of=')).map((word) => word.slice(3)), ['inside', 'ancestor'], true);
  const list = operands(words, at, new Set(['-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group']));
  if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
    // The first operand is the mode or owner (unless --reference named it).
    return all(rest.some((word) => word.startsWith('--reference')) ? list : list.slice(1), ['inside', 'ancestor'], true);
  }
  if (COPYING.has(name) || name === 'ln' || name === 'mv') return placingClaims(name, words, at, list);
  return all(list, ['inside', 'ancestor'], true);
}

function findClaims(words, at) {
  const rest = words.slice(at);
  if (!rest.some((word) => FIND_ACTIONS.has(word))) return [];
  // -exec of a read-only command reads; -delete and -fprint* write.
  const writes = rest.some((word) => word === '-delete' || word.startsWith('-fprint') || word === '-fls');
  const actions = findActionCommands(words, at);
  const actionsRead = actions.every((command) => claims(command, headIndex(command)).length === 0);
  if (!writes && actionsRead) return [];
  return findStarts(words, at).map((word) => ({ word, relations: ['inside', 'ancestor'], prove: true }));
}

function placingClaims(name, words, at, list) {
  const rest = words.slice(at);
  const target = optionValues(words, at, new Set(['-t', '--target-directory']));
  const destination = target.length > 0 ? target[0] : list.at(-1);
  const sources = target.length > 0 ? list.filter((word) => word !== target[0]) : list.slice(0, -1);
  const symbolic = name === 'ln' && rest.some((word) => /^-[A-Za-z]*s/u.test(word) || word === '--symbolic');
  const movesSources = name === 'mv' || symbolic || rest.includes('--remove-source-files');
  const deletes = name === 'rsync' && rest.some((word) => word.startsWith('--delete'));
  return [
    ...(movesSources ? sources.map((word) => ({ word, relations: ['inside', 'ancestor'], prove: true })) : []),
    ...(destination === undefined ? [] : [{
      word: destination,
      relations: deletes ? ['inside', 'ancestor'] : ['inside', 'landing'],
      prove: true,
      landing: sources.map((source) => basename(source)),
    }]),
  ];
}

// git writes into its own dir and work tree by design; what it may not do is
// point a writing subcommand (clean, rm, checkout-index, worktree, init …) at
// the run state, or be aimed there through -C / --work-tree / core.worktree.
// An aim at the repository itself is ordinary (`git -C <repo> checkout`): git
// keeps its own dir out of its work tree, so only an aim into the git dir or
// the latch's parents is refused.
function gitClaims(words, head) {
  let index = head + 1;
  const aims = [];
  while (index < words.length && words[index].startsWith('-')) {
    const word = words[index];
    const equals = word.indexOf('=');
    const key = equals === -1 ? word : word.slice(0, equals);
    if (!GIT_VALUED.has(key)) {
      index += 1;
      continue;
    }
    const value = equals === -1 ? words[index + 1] ?? '' : word.slice(equals + 1);
    if (key === '-C' || key === '--git-dir' || key === '--work-tree') aims.push(value);
    if (key === '-c' && /^core\.worktree=/iu.test(value)) aims.push(value.slice(value.indexOf('=') + 1));
    index += equals === -1 ? 2 : 1;
  }
  const subcommand = words[index] ?? '';
  const config = subcommand === 'config' && words.slice(index).some((word) => word === '--file' || word === '-f' || word.startsWith('--file='));
  if (!GIT_WRITING.has(subcommand) && !config) return [];
  const paths = config ? optionValues(words, index, new Set(['--file', '-f']))
    : subcommand === 'archive' ? optionValues(words, index, new Set(['-o', '--output']))
      : operands(words, index + 1, new Set(['-b', '-B', '--orphan', '--reason', '-m', '--message']));
  return [
    ...aims.map((word) => ({ word, relations: ['inside', 'near'], prove: true })),
    ...paths.map((word) => ({ word, relations: ['inside', 'near'], prove: false })),
  ];
}

function refusal(path, protectedDir) {
  return `autoloop guard — this command would change ${path}, which holds (or contains) this run's `
    + `own state or the guard's own code (${protectedDir}): the run markers and the session latch are `
    + 'how the guard knows a run is open, so a run never writes, moves or deletes them. Reading them is '
    + 'fine (cat, jq, ls). A run that is finished closes with `prime.mjs --close-run`.';
}

function unproven(word) {
  return `autoloop guard — this command deletes, moves or overwrites ${word === null ? 'what a pipe feeds it' : `\`${word}\``}, `
    + 'and where that lands cannot be proven (an unresolved variable or substitution, an unknown '
    + 'directory, input from a pipe, or too many brace expansions), so it could reach the run\'s own '
    + 'state. Name the paths literally, or split the command so each step names what it changes.';
}

// segments: [{ words, opens, closes, opaque? }] in order — the words of each
// shell segment, and how many subshell parentheses open before it and close
// after; `opaque` marks text the tokenizer could not take apart. protectedDirs
// hold the run's state; codeDirs the guard's own code, which only a write
// (not a program run with it as an argument) threatens.
export function runStateProblem(segments, { cwd, protectedDirs, codeDirs = [], home = homedir() }) {
  const absolute = (list) => [...new Set(list.filter((dir) => typeof dir === 'string' && isAbsolute(dir)))];
  const stateDirs = absolute(protectedDirs);
  const dirs = absolute([...protectedDirs, ...codeDirs]);
  if (dirs.length === 0) return null;
  if (segments.some((segment) => segment.opaque)) {
    return 'autoloop guard — this command nests more command substitutions than the guard can take '
      + 'apart, so what it changes cannot be proven. Split it into smaller commands.';
  }
  if (segments.reduce((total, segment) => total + segment.words.length, 0) > MAX_TRACKED_WORDS) {
    return 'autoloop guard — this command is too large to check for changes to the run\'s own '
      + 'state, so it cannot be proven safe. Split it into smaller commands.';
  }
  const placed = placeSegments(segments, typeof cwd === 'string' && isAbsolute(cwd) ? cwd : null, home, stateDirs);
  // The names a run-state path is built from (`.git`, `autoloop`, `run`,
  // `.claude`, `run-latches`): an unknown path that spells one is suspect.
  const components = new Set(stateDirs.flatMap((dir) => dir.split('/').filter(Boolean).slice(-3)));
  for (const at of placed) {
    // Redirections write, whatever the command.
    for (const target of at.writes) {
      const problem = judge({ word: target, relations: ['inside'], prove: false }, at, dirs, components, home);
      if (problem !== null) return problem;
    }
    if (at.head === -1) continue;
    const name = basename(at.argv[at.head] ?? '');
    if (name === 'cd' || name === 'pushd' || name === 'popd') continue;
    for (const claim of claims(at.argv, at.head)) {
      const problem = judge(claim, at, claim.stateOnly ? stateDirs : dirs, components, home);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function judge(claim, at, dirs, components, home) {
  const resolved = claim.word === null ? null : resolveWord(claim.word, at, home);
  if (resolved === null) return claim.prove ? unproven(claim.word) : null;
  for (const path of resolved.paths) {
    for (const protectedDir of dirs) {
      const found = relation(path, protectedDir);
      if (found === null) continue;
      if (claim.relations.includes(found)) return refusal(path, protectedDir);
      if (found !== 'ancestor') continue;
      const depth = protectedDir.split('/').filter(Boolean).length - path.split('/').filter(Boolean).length;
      if (claim.relations.includes('near') && depth <= 2) return refusal(path, protectedDir);
      // A copy or move into an ancestor lands its sources' names there.
      if (claim.relations.includes('landing')) {
        const landing = childBelow(path, protectedDir);
        const lands = claim.landing.some((leaf) => leaf === '' || leaf === '.' || /[*?[{$`]/u.test(leaf) || leaf === landing);
        if (lands) return refusal(path, protectedDir);
      }
    }
  }
  if (claim.prove && resolved.unknowns.some((unknown) => unknownIsRisky(unknown, at, dirs, components, home))) {
    return unproven(claim.word);
  }
  return null;
}

// Where each segment runs and what it can see: literal cd/pushd steps (and
// subshell scope) move the directory, `env -C` moves one segment,
// assignments, `for` lists and `read` define variables (a `read` fed by a
// find over the state, or by anything that smells of it, is suspect), and
// redirections are split from the argv.
function placeSegments(segments, cwd, home, dirs) {
  let dir = cwd;
  let dirSmell = false;
  const stack = [];
  const vars = new Map();
  const define = (name, values, smell) => vars.set(name, { values, smell });
  let previous = null;
  return segments.map((segment) => {
    for (let open = 0; open < segment.opens; open += 1) stack.push({ dir, dirSmell });
    const list = joinSubstitutions(segment.words);
    const head = headIndex(list);
    const headName = head === -1 ? '' : basename(list[head]);
    const setter = ['export', 'declare', 'local', 'readonly', 'typeset'].includes(headName);
    if (head === -1 || setter) {
      for (const word of list.slice(setter ? head + 1 : 0).filter(isAssignment)) {
        const [name, ...value] = word.split('=');
        const text = value.join('=');
        if (/^\$\(\s*mktemp\b[^)]*\)$/u.test(text)) {
          define(name, [join('/tmp', `mktemp-${name}`)], false);
          continue;
        }
        const values = expansions(text, home, vars);
        const unknown = values === null || values.some(({ text: item }) => EXPANSION.test(item));
        define(name, unknown ? null : values.map(({ text: item }) => item),
          values === null || values.some(({ smell }) => smell) || (unknown && SMELL.test(text)));
      }
    } else if (list[0] === 'for' && list[2] === 'in') {
      const items = list.slice(3).flatMap((word) => expansions(word, home, vars) ?? [{ text: '$UNKNOWN', smell: true }]);
      define(list[1], items.length > MAX_ALTERNATIVES ? null : items.map(({ text }) => text), items.some(({ smell }) => smell));
    } else if (headName === 'read' || headName === 'mapfile' || headName === 'readarray') {
      const producer = previous === null ? null : producerRisk(previous, home, dirs);
      for (const name of list.slice(head + 1).filter((word) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word))) define(name, null, producer !== false);
    }
    const at = { dir, dirSmell, vars: new Map(vars) };
    const chdir = list.findIndex((word, index) => index < head && (word === '-C' || word === '--chdir'));
    const segmentDir = chdir === -1 ? { dir, dirSmell } : placeDir(list[chdir + 1] ?? '', at, home);
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
      // `>&2` and `>&-` duplicate descriptors; `>&file` writes a file.
      if (!/^&?(?:\d+|-)$/u.test(target)) writes.push(target.replace(/^&/u, ''));
    }
    if (headName === 'cd' || headName === 'pushd') {
      const target = argv[head + 1];
      ({ dir, dirSmell } = target === undefined || target.startsWith('-')
        ? { dir: null, dirSmell: false } : placeDir(target, at, home));
    } else if (headName === 'popd') {
      ({ dir, dirSmell } = { dir: null, dirSmell: false });
    }
    const placedSegment = { argv, head, writes, dir: segmentDir.dir, dirSmell: segmentDir.dirSmell, vars: at.vars };
    // A close with no open seen is a substitution's `)`, not a subshell's.
    for (let close = 0; close < segment.closes && stack.length > 0; close += 1) ({ dir, dirSmell } = stack.pop());
    previous = { words: list, head, at };
    return placedSegment;
  });
}

// The shell keeps `$(git rev-parse --git-dir)/x` one word; the tokenizer
// split it at its spaces. Words are rejoined until each substitution closes.
function joinSubstitutions(words) {
  const joined = [];
  for (let index = 0; index < words.length; index += 1) {
    let word = words[index];
    const open = (text) => (text.match(/\$\(/gu) ?? []).length - (text.match(/\)/gu) ?? []).length
      + ((text.match(/`/gu) ?? []).length % 2);
    while (open(word) > 0 && index + 1 < words.length) word = `${word} ${words[++index]}`;
    joined.push(word);
  }
  return joined;
}

// A directory a cd moves to: one concrete path, else unknown (and whether
// that unknown smells of the run state).
function placeDir(word, at, home) {
  const resolved = resolveWord(word, at, home);
  if (resolved === null) return { dir: null, dirSmell: true };
  if (resolved.unknowns.length > 0 || resolved.paths.length === 0) {
    return { dir: null, dirSmell: resolved.unknowns.some(({ smell }) => smell) };
  }
  return { dir: resolved.paths.at(-1), dirSmell: false };
}

// Whether a segment feeding a `read` could list the run state: a find over
// (or into) it, or words that smell of it. false when it cannot.
function producerRisk({ words, head, at }, home, dirs) {
  if (head === -1) return false;
  if (words.some((word) => SMELL.test(word))) return true;
  if (basename(words[head]) !== 'find') return false;
  return findStarts(words, head + 1).some((start) => {
    const resolved = resolveWord(start, at, home);
    if (resolved === null || resolved.unknowns.length > 0) return true;
    return resolved.paths.some((path) => dirs.some((protectedDir) => relation(path, protectedDir) !== null));
  });
}

// Fixtures, relative to a repository at /r with home /home/u and the plugin's
// tools at /p/tools. Exported so command-guard replays them through its own
// tokenizer.
export const TAMPERING = Object.freeze([
  'rm -f .git/autoloop/run/1.json',
  'rm -rf .git/autoloop',
  'rm -rf .git',
  'rm -r ./.git/autoloop/run',
  'mv .git/autoloop/run /tmp/x',
  'mv .git/autoloop /tmp/x',
  'mv .git/autoloop/run{,.bak}',
  'echo {} > .git/autoloop/run/a.json',
  'printf x >.git/autoloop/run/a.json',
  'echo {} >&.git/autoloop/run/x.json',
  'cat /tmp/forged 1>> .git/autoloop/run/a.json',
  'cp /tmp/forged.json .git/autoloop/run/b.json',
  'cp -r /tmp/fake/autoloop .git/',
  'cp -r /tmp/fake/. .git/autoloop/',
  'cp -t .git/autoloop/run /tmp/forged.json',
  'mv /tmp/run .git/autoloop/',
  'ln -sf /tmp/x .git/autoloop/run/c.json',
  'ln -s .git g',
  'ln -s ~/.claude h',
  'tee .git/autoloop/run/a.json',
  'truncate -s0 .git/autoloop/run/1.json',
  'sed -i s/a/b/ .git/autoloop/run/1.json',
  'find . -name *.json -delete',
  'find .git -path *run* -exec rm {} +',
  'rm -rf .g*/a*/r*',
  'rm .git/autoloop/run/*',
  'rm -rf .git/autoloop/{run,zz}',
  'rm -rf ~/.claude/autoloop/{run-latches,x} .git/{autoloop,x}',
  'rm -rf .git/autoloop/r{t..v}n',
  'cd .git/autoloop && rm -rf run',
  'cd .git; rm -rf autoloop',
  'pushd .git/autoloop/run && rm 1.json',
  '(cd /tmp) ; cd .git/autoloop ; rm -rf run',
  'env -C .git/autoloop rm -rf run',
  'cd $(git rev-parse --git-dir) && rm -rf autoloop',
  'cd "$X" && rm -rf run',
  'rm -rf $(git rev-parse --git-common-dir)/autoloop',
  'rm -rf ~/.claude/autoloop/run-latches',
  'rm -rf $HOME/.claude/autoloop',
  'rm -rf ${HOME}/.claude',
  'export D=.git ; rm -rf $D/autoloop',
  'rm -rf ~',
  'rm -rf /',
  'chmod -R 000 .git',
  'chmod 000 .git/autoloop',
  'rsync -a --delete /tmp/empty/ .git/autoloop/',
  'echo .git/autoloop/run | xargs rm -rf',
  'find . -type f | xargs rm',
  'dd if=/dev/null of=.git/autoloop/run/1.json',
  'tar -xf /tmp/t.tar -C .git',
  'find . -name *.json | while read f ; do rm $f ; done',
  'for f in a ; do rm $f ; done ; for d in .git ; do rm -rf $d ; done',
  'for f in .git/autoloop/run/* ; do rm $f ; done',
  'if true ; then rm -rf .git/autoloop ; fi',
  'git --work-tree=.git/autoloop/run clean -fdxq',
  'git --work-tree=/home/u/.claude/autoloop/run-latches clean -fdxq',
  'git -C .git/autoloop/run init',
  'git config --file .git/autoloop/run/x.json a.b c',
  'git worktree add .git/autoloop/run/w',
  'gh run download 5 -D .git/autoloop/run',
  'gh release download v1 -O /home/u/.claude/autoloop/run-latches/x --clobber',
  'echo exit > /p/tools/command-guard.mjs',
  'cp /tmp/x.mjs /p/tools/command-guard.mjs',
  'rm -rf /p',
]);

export const ORDINARY = Object.freeze([
  'cat .git/autoloop/run/1.json',
  'jq . .git/autoloop/run/1.json',
  'ls -la .git/autoloop/run',
  'rg -n baseBranch .git/autoloop/run',
  'git status',
  'git add .',
  'git -C /r checkout -b feat/x',
  'git -C /r commit -m x',
  'git worktree add -q --detach /tmp/wt origin/main',
  'git worktree remove /tmp/wt',
  'git clean -fdx',
  'git rm src/old.ts',
  'git checkout -- src/a.ts',
  'rm -f src/old.ts',
  'rm -rf dist node_modules/.cache',
  'mv src/a.ts src/b.ts',
  'cp -r fixtures/ /tmp/x',
  'mv /tmp/result.json .',
  'cp /tmp/result.json .',
  'find . -name *.orig',
  'find . -name *.ts -exec wc -l {} +',
  'find . -type f -exec grep -l foo {} ;',
  'echo done > /tmp/autoloop-354/note.md',
  'echo x > "$OUT"',
  'cd /tmp/autoloop-354 && rm -rf live',
  'S=/tmp/s ; rm -rf $S/rel',
  'sed -n 1,5p .git/autoloop/run/1.json',
  'npm test > /tmp/out.txt 2>&1',
  'npm test 2>&1 >&2',
  'rm -rf .autoloop/tmp',
  'for f in src/*.ts ; do wc -l $f ; done',
  'node tools/release-verify.mjs --fingerprint-stdin < .git/autoloop/run/1.json',
  'node x.mjs <.git/autoloop/run/1.json',
  'rsync -a --files-from=- ./ /tmp/copy/',
  "fd -H '^CLAUDE.md$|^x$' . --exclude .git",
  'find src -name .git | while read f ; do cmp $f /tmp/x ; done',
  'git -C /r show HEAD:a > /tmp/a ; for f in a b ; do diff /tmp/$f $f ; done',
  'chmod +x scripts/run.sh',
  'tar -czf /tmp/out.tgz src',
  'gh pr create --title x --body-file /tmp/body.md',
  'gh run view 5 --log',
  'node /p/tools/prime.mjs --close-run',
  'bash /p/tools/dispatch-stream.sh /tmp/a.jsonl',
]);

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
  const codeDirs = ['/p/tools'];
  // A minimal tokenizer for the fixtures; command-guard's self-test replays
  // them through the guard's own.
  const segmentsOf = (command) => command.split(/\s*(?:&&|\|\||;|\|)\s*/u).filter(Boolean).map((text) => {
    const opens = /^\(+/u.exec(text)?.[0].length ?? 0;
    const closes = /\)+$/u.exec(text)?.[0].length ?? 0;
    return { words: text.slice(opens, text.length - closes).trim().split(/\s+/u), opens, closes };
  });
  const refused = (command, cwd = repo) => runStateProblem(segmentsOf(command), { cwd, protectedDirs, codeDirs, home }) !== null;
  const tampering = TAMPERING.filter((command) => !refused(command));
  check('every shape that writes, moves or deletes the run state is refused', tampering.length === 0);
  if (tampering.length > 0) console.error(`  evaded: ${JSON.stringify(tampering)}`);
  const ordinary = ORDINARY.filter((command) => refused(command));
  check('reading the run state, and ordinary work elsewhere, is not refused', ordinary.length === 0);
  if (ordinary.length > 0) console.error(`  false positives: ${JSON.stringify(ordinary)}`);
  check('nothing is judged without protected directories',
    runStateProblem(segmentsOf('rm -rf .git'), { cwd: repo, protectedDirs: [], home }) === null);
  check('an opaque segment refuses',
    runStateProblem([{ words: [], opens: 0, closes: 0, opaque: true }], { cwd: repo, protectedDirs, home }) !== null);
  const padded = [`rm -rf ${'*'.repeat(5000)}x/${'?*'.repeat(2000)}`, `${'xargs rm ; '.repeat(3000)}ls`,
    `rm -rf ${'{a,b}'.repeat(40)}`, 'rm -rf {1..100000}'];
  const paddedAt = Date.now();
  for (const command of padded) refused(command);
  check('padded globs, braces and pipelines stay fast', Date.now() - paddedAt < 1000);
  const braceSet = (word) => JSON.stringify([...new Set(expandBraces(word))].sort());
  check('braces expand to the words the shell gives', braceSet('a/{b,c{d,e}}/{1..3}')
    === JSON.stringify(['a/b/1', 'a/b/2', 'a/b/3', 'a/cd/1', 'a/cd/2', 'a/cd/3', 'a/ce/1', 'a/ce/2', 'a/ce/3'])
    && expandBraces('{a,b}'.repeat(10)) === null && JSON.stringify(expandBraces('x{y}')) === '["x{y}"]');
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
