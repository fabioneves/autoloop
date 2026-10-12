#!/usr/bin/env node
// PreToolUse(Bash) guard — refuses the acts that are irreversible or
// unauthorized, and nothing else. Vendored by autoloop:setup and wired into
// the active host's project hooks (.claude/settings.json).
//
//   BLOCK (exit 2), in the session that owns a run
//     1. a merge: `gh pr merge`, the REST merge endpoint, a GraphQL merge
//        mutation, or a hand-posted commit status the merge gate trusts.
//     2. a commit on, or a push to, the configured base branch — the base
//        takes pull requests only. Skipped when the same command switches
//        branches first (git switch|checkout). A commit, tree, contents or
//        ref write through the API (REST or GraphQL) is refused outright.
//     3. `git push --force`/-f or a `+<refspec>` — only --force-with-lease.
//     4. a release-tag push or a GitHub release mutation — a maintainer act.
//     5. a branch-protection or ruleset mutation — the human's baseline.
//     6. `git add` or `git commit` naming a secret path (`.env*`, key
//        material, a credential or token path: lane-contract isSecretPath).
//     7. a commit message carrying Co-Authored-By.
//     8. `AskUserQuestion` while a run is live.
//     9. a branch switch of a checkout a reviewer dispatch is reading.
//    10. a command that runs the plugin's prime and does anything else, or
//        runs it outside the session's project (checked in every session).
//    11. a hook payload the guard cannot read, while this process holds a
//        latch (fail closed for the owner).
//    12. a workflow dispatch: `gh workflow run|enable` or the dispatch
//        endpoints — an unmerged branch with the repository's secrets.
//
//   Rules 1, 2, 4, 5 and 12 are matched through `gh api` and through raw
//   HTTP to the API host (curl, wget, httpie, xh), where any write method
//   is refused. A git alias set on the command line, a gh alias, a function
//   body, a case branch, a trap action, and a shell fed by a heredoc or a
//   literal echo are judged as the commands they run; a hidden alias (from
//   the environment or a config include) is refused.
//
//   ALLOW everything else (exit 0). The kept rules match the literal command
//   with the lexer below; a token the lexer cannot classify is allowed. The
//   guard never refuses because it does not understand a command. An inline
//   interpreter's program (`python3 -c`, `node -e`) is not shell, and is
//   not judged (SPEC-guard-reduction, accepted).
//
//   The rules apply only to the session that owns a run (run-markers.mjs
//   ownedRun), from its prime until /clear or exit — `--close-run` does not
//   end them. A guard that throws exits by the same ownership; one that
//   cannot start falls back to hooks.json, which reads the latch of the
//   shell's parent ($PPID, the Claude process).
//
//   NOT a sandbox: reading the environment or a credential file is allowed.
//   Secrets are protected by scoping them (a repo-scoped token without admin
//   rights, no API key in the loop's environment); rule 6 only keeps one out
//   of a commit.
//
// Usage:  (hook) reads the PreToolUse payload on stdin
//         node <plugin-tools>/command-guard.mjs --self-test

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_VERSION,
  repositoryRoot,
} from './config-contract.mjs';
import { LOOP_BRANCH_RE } from './claim-contract.mjs';
import { hookRoot } from './hook-root.mjs';
import { isSecretPath } from './lane-contract.mjs';
import {
  runMarkerDirectory, loopRunIsOpen, loopRunIsLive, pluginRunMarkers, ancestorChain, isClaudeProcess,
  procEntry, psEntry, commonDirOf, heldLatch, ownedRun, pinnedModelsPath, processStart, protectedPaths, pruneLatches, recordHostSession,
  recordLatch, sessionLatch, sessionOwnerPid,
} from './run-markers.mjs';
import { ORDINARY, readsOnly, runStateProblem, TAMPERING } from './run-state-guard.mjs';
import { boundedGit, gitStalled, setGitDeadline } from './git-budget.mjs';

const BRANCH_CREATION_FLAGS = new Set([
  '-c',
  '-C',
  '-b',
  '-B',
  '--create',
  '--force-create',
  '--orphan',
]);
const CURRENT_BRANCH_REFS = new Set(['HEAD', '@']);
const BULK_PUSH_FLAGS = new Set([
  '--all',
  '--branches',
  '--follow-tags',
  '--mirror',
  '--tags',
]);

// Strip heredoc bodies so text INSIDE a body (e.g. a PR description that quotes
// "gh pr merge") never false-positives.
// One linear pass over the command, the way the shell reads it: quotes,
// `#` comments (at a word start, outside quotes) and heredocs (`<<EOF`,
// `<<-EOF`, quoted or not — never the `<<<` here-string, never inside quotes
// or a comment). It returns the command text without comments and without
// heredoc bodies — the rest of a `<<EOF` line stays, since it is command text
// — and the bodies, marked expanded when the delimiter was unquoted (the
// shell then runs their substitutions). Regex versions of this hid whole
// lines from every rule: `cat <<EOF && gh pr merge`, `echo x # it's` swallowing
// the next line, `<<<` read as a heredoc (reviews of the guard hardening).
export function lexShell(cmd, options = {}) {
  let out = '';
  const bodies = [];
  const pending = [];
  // With `markHeredocs`, each `<<EOF` leaves a marker word (\u0001 + the
  // body's index) where it stood, so a shell fed by a heredoc (`bash <<EOF`)
  // can be judged on that body.
  let registered = 0;
  let single = false;
  let double = false;
  // Inside `(( … ))` or `$(( … ))`, `<<` is a shift, never a heredoc: read as
  // one, it hid the lines after `(( x = 1<<EOF ))` (review of the LFE fixes).
  let arithmetic = 0;
  const atWordStart = () => out.length === 0 || /[\s;|&()]/u.test(out[out.length - 1]);
  for (let index = 0; index < cmd.length;) {
    const char = cmd[index];
    if (single) {
      out += char;
      if (char === "'") single = false;
      index += 1;
      continue;
    }
    if (char === '\\') {
      out += char + (cmd[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (double) {
      out += char;
      if (char === '"') double = false;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (char === "'") single = true;
      else double = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '#' && atWordStart()) {
      while (index < cmd.length && cmd[index] !== '\n') index += 1;
      continue;
    }
    if (char === '(' && cmd[index + 1] === '(') {
      arithmetic += 1;
      out += '((';
      index += 2;
      continue;
    }
    if (arithmetic > 0 && char === ')' && cmd[index + 1] === ')') {
      arithmetic -= 1;
      out += '))';
      index += 2;
      continue;
    }
    if (arithmetic === 0 && char === '<' && cmd[index + 1] === '<' && cmd[index + 2] !== '<' && cmd[index - 1] !== '<') {
      let at = index + 2;
      const strip = cmd[at] === '-';
      if (cmd[at] === '-' || cmd[at] === '~') at += 1;
      while (cmd[at] === ' ' || cmd[at] === '\t') at += 1;
      let delimiter = '';
      let quoted = false;
      while (at < cmd.length && !/[\s;|&<>()]/u.test(cmd[at])) {
        if (cmd[at] === "'" || cmd[at] === '"') {
          const quote = cmd[at];
          quoted = true;
          at += 1;
          while (at < cmd.length && cmd[at] !== quote) delimiter += cmd[at++];
          at += 1;
        } else if (cmd[at] === '\\') {
          quoted = true;
          delimiter += cmd[at + 1] ?? '';
          at += 2;
        } else {
          delimiter += cmd[at++];
        }
      }
      if (delimiter === '') {
        out += '<<';
        index += 2;
        continue;
      }
      pending.push({ delimiter, strip, expanded: !quoted });
      out += options.markHeredocs === true ? ` ${HEREDOC_MARK}${registered} ` : ' ';
      registered += 1;
      index = at;
      continue;
    }
    if (char === '\n' && pending.length > 0) {
      out += '\n';
      index += 1;
      for (const doc of pending) {
        let body = '';
        while (index < cmd.length) {
          const end = cmd.indexOf('\n', index);
          const line = cmd.slice(index, end === -1 ? cmd.length : end).replace(/\r$/u, '');
          index = end === -1 ? cmd.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/u, '') : line) === doc.delimiter) break;
          body += `${line}\n`;
        }
        bodies.push({ body, expanded: doc.expanded });
      }
      pending.length = 0;
      continue;
    }
    out += char;
    index += 1;
  }
  return { text: out, bodies };
}

const HEREDOC_MARK = '\u0001';

export function stripHeredocs(cmd) {
  return lexShell(cmd).text;
}

// The bodies of heredocs whose delimiter is unquoted: the shell expands them,
// so a substitution inside runs.
function expandedHeredocBodies(cmd) {
  return lexShell(cmd).bodies.filter(({ expanded }) => expanded).map(({ body }) => body);
}

// Redirection operators glued to a word (`echo x>file`, `2>&1`) set apart,
// outside quotes, so the rule sees the target as its own word.
function spacedRedirections(text) {
  let out = '';
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (single) {
      out += char;
      if (char === "'") single = false;
      continue;
    }
    if (char === '\\') {
      out += char + (text[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = true;
    if (char === '"') double = !double;
    if (double || (char !== '>' && char !== '<')) {
      out += char;
      continue;
    }
    // A leading fd number (or &) belongs to the operator only as a word of
    // its own; found by walking back, not by a pattern over all of `out`.
    let back = out.length;
    while (back > 0 && /\d/u.test(out[back - 1])) back -= 1;
    if (back === out.length && out[back - 1] === '&') back -= 1;
    const word = back < out.length && (back === 0 || /\s/u.test(out[back - 1]));
    out = word ? `${out.slice(0, back)} ${out.slice(back)}` : `${out} `;
    let operator = char;
    while (index + 1 < text.length && /[<>&|-]/u.test(text[index + 1]) && operator.length < 3) operator += text[++index];
    out += `${operator} `;
  }
  return out;
}

function decodeAnsiCBody(body) {
  const escapes = new Map([
    ['a', '\x07'],
    ['b', '\b'],
    ['e', '\x1b'],
    ['E', '\x1b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
  ]);
  let output = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') {
      output += body[index];
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === '\r' && body[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (escaped === '\n') {
      index += 1;
      continue;
    }
    if (escapes.has(escaped)) {
      output += escapes.get(escaped);
      index += 1;
      continue;
    }
    if (escaped === 'x' || escaped === 'u' || escaped === 'U') {
      const maximum = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
      const digits = body.slice(index + 2).match(
        new RegExp(`^[0-9a-fA-F]{1,${maximum}}`, 'u'),
      )?.[0] ?? '';
      const codePoint = Number.parseInt(digits, 16);
      if (
        digits.length > 0
        && Number.isSafeInteger(codePoint)
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        output += String.fromCodePoint(codePoint);
        index += digits.length + 1;
        continue;
      }
    }
    if (/^[0-7]$/u.test(escaped ?? '')) {
      const digits = body.slice(index + 1).match(/^[0-7]{1,3}/u)?.[0] ?? '';
      output += String.fromCodePoint(Number.parseInt(digits, 8));
      index += digits.length;
      continue;
    }
    output += escaped ?? '\\';
    if (escaped !== undefined) index += 1;
  }
  return output;
}

// ANSI-C quotes (`$'…'`) decoded where the shell reads them: outside other
// quotes only. A `$'` inside a single-quoted pattern (`rg '^Closes #388$'`)
// is the pattern's last `$` and its closing quote, not the start of an ANSI-C
// string; decoding it there desynced every reader after it (LFE replay).
// One linear pass; `quoted` keeps each decoded string single-quoted for the
// tokenizer.
function decodeAnsiC(cmd, quoted) {
  let out = '';
  let quote = null;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (quote === "'") {
      out += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      out += char + (cmd[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (quote === '"') {
      out += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === '$' && cmd[index + 1] === "'") {
      let end = index + 2;
      while (end < cmd.length && cmd[end] !== "'") end += cmd[end] === '\\' ? 2 : 1;
      const body = decodeAnsiCBody(cmd.slice(index + 2, Math.min(end, cmd.length)));
      // Unquoted, a decoded backslash stays escaped: bare, a trailing one
      // (`echo $'\\'`) escaped the real newline after it and joined the next
      // line's command to this one (review of the LFE fixes).
      out += quoted ? `'${body.replaceAll("'", "'\\''")}'` : body.replaceAll('\\', '\\\\');
      index = end;
      continue;
    }
    // `$"…"` is a locale string: drop the `$`, the quote that follows opens it.
    if (char === '$' && cmd[index + 1] === '"') continue;
    if (char === "'" || char === '"') quote = char;
    out += char;
  }
  return out;
}

// The same decoding, kept quoted, for the tokenizer: `$'\x2egit'` is `'.git'`.
function quotedAnsiC(cmd) {
  return decodeAnsiC(cmd, true);
}

function shellSegments(cmd) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < cmd.length; i += 1) {
    const char = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const pair = cmd.slice(i, i + 2);
    const separator = pair === '&&' || pair === '||'
      ? pair
      : char === ';' || char === '\n' || char === '|' || char === '&'
        ? ';'
        : null;
    if (!separator) continue;
    segments.push({ command: cmd.slice(start, i).trim(), next: separator, raw: separator === ';' ? char : pair });
    i += separator.length - 1;
    start = i + 1;
  }
  segments.push({ command: cmd.slice(start).trim(), next: null, raw: null });
  return segments.filter((segment) => segment.command);
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let active = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) words.push(word);
      word = '';
      active = false;
      continue;
    }
    word += char;
    active = true;
  }
  if (active) words.push(word);
  return words;
}

// Wrappers that pass execution through to their argument; anything else in
// front of `git`/`gh` means the word is an ARGUMENT, not an invocation — a live
// section banner (`echo "=== git diffstat ==="`) read as a command because the
// executable was found anywhere in the segment. Every entry runs the command
// that FOLLOWS it, so the word after one is still an invocation.
const EXEC_WRAPPERS = new Set([
  'command',
  'doas',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'sudo',
  'time',
  'timeout',
  'xargs',
]);

// A wrapper's options that take a value: the value is not the command it
// runs (`sudo -u dev gh pr merge 4` runs gh, not dev).
const WRAPPER_VALUE_OPTIONS = new Map([
  ['doas', new Set(['-C', '-u'])],
  ['env', new Set(['-C', '--chdir', '-S', '--split-string', '-u', '--unset'])],
  ['ionice', new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-e', '-i', '-o', '--error', '--input', '--output'])],
  ['sudo', new Set(['-C', '-D', '-g', '-h', '-p', '-r', '-t', '-T', '-u', '-U'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['timeout', new Set(['-k', '--kill-after', '-s', '--signal'])],
  ['xargs', new Set([
    '-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-i', '--replace', '-L', '--max-lines', '-n', '--max-args',
    '-P', '--max-procs', '-s', '--max-chars',
  ])],
]);

// find(1) hands the words after these flags to the kernel verbatim, so the
// word after the flag is an invocation even though it is not segment-initial.
const EXEC_FORWARDING_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function invokedAt(words, index) {
  return inExecutablePosition(words, index)
    || EXEC_FORWARDING_FLAGS.has(words[index - 1]);
}

// Shell keywords that precede a command in its own position: `do gh pr merge`,
// `then git push`, `! gh …`, `{ git push; }`. `eval` runs its arguments.
// `function <name>` and `case <word> in` take the word after them; a
// function head (`f()`, `f ()`) and a case label (`x)`, `(a|b)`) are
// keywords of their own: the body after them is a command (review of the
// guard reduction: `f() { gh pr merge 1; }; f` ran the merge).
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'do', 'elif', 'else', 'eval', 'if', 'in', 'then', 'until', 'while']);
const KEYWORDS_WITH_NAME = new Set(['case', 'function']);

function isFunctionHead(words, index) {
  return /^[A-Za-z_][A-Za-z0-9_-]*\(\)$/u.test(words[index]) || words[index] === '()' || words[index + 1] === '()';
}

function isCaseLabel(word) {
  return /^\(?[^()\s]*\)$/u.test(word);
}

function inExecutablePosition(words, position) {
  let wrapper = null;
  for (let index = 0; index < position; index += 1) {
    const word = words[index];
    const name = word.slice(word.lastIndexOf('/') + 1);
    if (wrapper !== null && WRAPPER_VALUE_OPTIONS.get(wrapper).has(word)) {
      index += 1;                                              // the option's value
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;      // VAR=value prefix
    if (EXEC_WRAPPERS.has(name)) {
      wrapper = WRAPPER_VALUE_OPTIONS.has(name) ? name : null;
      continue;
    }
    if (KEYWORDS_WITH_NAME.has(word)) {
      index += 1;
      continue;
    }
    if (SHELL_KEYWORDS.has(word) || isFunctionHead(words, index) || isCaseLabel(word)) continue;
    if (/^-/.test(word)) continue;                             // wrapper flags
    if (/^[0-9]+[smhd]?$/.test(word)) continue;                // timeout duration
    return false;
  }
  return true;
}

// The first invocation of `executable` in a segment, or -1: a word that only
// names it (`rg -n "gh pr merge" docs`, `echo git push`) is data.
function executableIndex(words, executable) {
  return words.findIndex((word, index) =>
    (word === executable || word.endsWith(`/${executable}`)) && invokedAt(words, index));
}

// gh's first two positional words after its global options, or null when the
// segment does not invoke gh: `gh -R o/r pr merge 4` → ['pr', 'merge'].
const GH_GLOBAL_OPTIONS = new Set(['-R', '--hostname', '--repo']);

function ghPositionals(words) {
  const gh = executableIndex(words, 'gh');
  if (gh === -1) return null;
  const positionals = [];
  for (let index = gh + 1; index < words.length && positionals.length < 2; index += 1) {
    const word = words[index];
    if (GH_GLOBAL_OPTIONS.has(word)) {
      index += 1;
      continue;
    }
    if ([...GH_GLOBAL_OPTIONS].some((option) => word.startsWith(`${option}=`)) || word.startsWith('-')) continue;
    positionals.push(word);
  }
  return positionals;
}

function gitSubcommandIndex(words, subcommand) {
  const git = executableIndex(words, 'git');
  if (git === -1) return -1;
  const optionsWithValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
  for (let i = git + 1; i < words.length; i += 1) {
    const word = words[i];
    if (optionsWithValues.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word === subcommand ? i : -1;
  }
  return -1;
}

function switchTarget(words, baseBranch) {
  const switchIndex = gitSubcommandIndex(words, 'switch');
  const checkoutIndex = gitSubcommandIndex(words, 'checkout');
  const index = switchIndex === -1 ? checkoutIndex : switchIndex;
  if (index === -1) return null;
  const checkout = checkoutIndex !== -1;
  if (checkout && words.slice(index + 1).includes('--')) return null;
  const tracking = words.slice(index + 1).some(
    (word) => word === '-t' || word === '--track' || word.startsWith('--track='),
  );
  for (let i = index + 1; i < words.length; i += 1) {
    const word = words[i];
    if (BRANCH_CREATION_FLAGS.has(word)) return words[i + 1] ?? null;
    const branchFlag = [...BRANCH_CREATION_FLAGS].find((flag) => word.startsWith(`${flag}=`));
    if (branchFlag) return word.slice(branchFlag.length + 1) || null;
    if (word === '--detach') return null;
    if (word.startsWith('-')) continue;
    if (!checkout) return word === '-' ? baseBranch : tracking ? trackedBranch(word) : word;
    if (tracking) return trackedBranch(word);
    const target = normalizedBranch(word);
    if (target === baseBranch || LOOP_BRANCH_RE.test(target) || word.startsWith('refs/heads/')) {
      return word;
    }
    return word === '-' ? baseBranch : null;
  }
  return null;
}

function normalizedBranch(ref) {
  return String(ref ?? '').replace(/^refs\/heads\//, '');
}

function refTargetsBranch(ref, branch) {
  const pattern = normalizedBranch(ref);
  const wildcard = pattern.indexOf('*');
  if (wildcard === -1) return pattern === branch;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    branch.length >= prefix.length + suffix.length
    && branch.startsWith(prefix)
    && branch.endsWith(suffix)
  );
}

function longOptionPrefix(argument, option) {
  const name = String(argument ?? '').split('=', 1)[0];
  return name.startsWith('--')
    && name.length >= 3
    && option.startsWith(name);
}

function trackedBranch(ref) {
  const remoteRef = String(ref ?? '').replace(/^refs\/remotes\//, '');
  const separator = remoteRef.indexOf('/');
  return separator === -1 ? remoteRef : remoteRef.slice(separator + 1);
}

function pushTargetsBase(words, branches, baseBranch) {
  const index = gitSubcommandIndex(words, 'push');
  if (index === -1) return false;
  const args = words.slice(index + 1);
  if (args.some((arg) =>
    [...BULK_PUSH_FLAGS].some((flag) => longOptionPrefix(arg, flag)))) {
    return true;
  }
  const deleteMode = args.includes('--delete') || args.includes('-d');
  const optionsWithValues = [
    '--repo',
    '--receive-pack',
    '--exec',
    '--push-option',
    '-o',
  ];
  const positional = [];
  let repositoryFromOption = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const option = optionsWithValues.find((candidate) =>
      longOptionPrefix(arg, candidate));
    if (option && !arg.includes('=')) {
      if (option === '--repo') repositoryFromOption = true;
      i += 1;
      continue;
    }
    if (option && arg.includes('=')) {
      if (option === '--repo') repositoryFromOption = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  const refspecs = positional.slice(repositoryFromOption ? 0 : 1);
  if (refspecs.length === 0) return true;
  return refspecs.some((refspec) => {
    const clean = refspec.replace(/^\+/, '');
    if (clean === ':') return true;
    const colon = clean.lastIndexOf(':');
    if (colon === -1 && CURRENT_BRANCH_REFS.has(clean) && branches.has(baseBranch)) {
      return true;
    }
    const destination = colon === -1 ? clean : clean.slice(colon + 1);
    if (!destination && !deleteMode) return false;
    return refTargetsBranch(destination, baseBranch);
  });
}

function pushesReleaseTag(words) {
  const index = gitSubcommandIndex(words, 'push');
  if (index === -1) return false;
  return words.slice(index + 1).some((argument) => {
    const value = argument.replace(/^\+/, '');
    return longOptionPrefix(value, '--tags')
      || longOptionPrefix(value, '--follow-tags')
      || value.includes('refs/tags/')
      || value.split(':').some((ref) =>
        /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(ref));
  });
}

export function expandHome(path) {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function mutatingGhApi(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return false;
  const args = words.slice(api + 1);
  let method = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-X' || argument === '--method') {
      method = args[index + 1]?.toUpperCase() ?? null;
      index += 1;
    } else if (/^-X[A-Za-z]+$/u.test(argument)) {
      method = argument.slice(2).toUpperCase();
    } else if (argument.startsWith('--method=')) {
      method = argument.slice('--method='.length).toUpperCase();
    }
  }
  if (method === null && args.some((argument) =>
    argument === '--input'
    || argument.startsWith('--input=')
    || argument === '-f'
    || argument === '-F'
    || argument === '--field'
    || argument === '--raw-field'
    || /^-[fF].+/u.test(argument)
    || argument.startsWith('--field=')
    || argument.startsWith('--raw-field='))) {
    method = 'POST';
  }
  return method !== null && !new Set(['GET', 'HEAD']).has(method);
}

const GITHUB_API_HOST = 'api.github.com';

// The path segments of an API endpoint, from a bare path or an absolute URL
// of the API host in any spelling (scheme, case, `:443`, userinfo, query);
// null for another host or a path this reader cannot take apart.
function normalizedGithubApiEndpoint(value, { absoluteOnly = false } = {}) {
  if (typeof value !== 'string' || /\s/u.test(value)) return null;
  let endpoint;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) || /^[^/]*api\.github\.com/iu.test(value)) {
    let url;
    try {
      url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ? value : `https://${value}`);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== GITHUB_API_HOST || !['http:', 'https:'].includes(url.protocol)) return null;
    endpoint = url.pathname;
  } else {
    if (absoluteOnly) return null;
    endpoint = value;
  }
  endpoint = endpoint.split(/[?#]/u, 1)[0].replace(/^\/+/u, '');
  if (!endpoint) return null;
  try {
    const segments = endpoint.split('/').map((segment) =>
      decodeURIComponent(segment));
    return segments.every((segment) => segment.length > 0) ? segments : null;
  } catch {
    return null;
  }
}

function githubApiEndpoints(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return [];
  return words
    .slice(api + 1)
    .map(normalizedGithubApiEndpoint)
    .filter((endpoint) => endpoint !== null);
}

// End of a `$(` body starting at `start`, honouring quotes and nesting; -1 when
// the body is not one this reader can delimit with certainty.
function substitutionEnd(cmd, start) {
  let depth = 1;
  let quote = null;
  for (let index = start; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === '"') continue;
    if (char === "'") quote = "'";
    else if (char === '`') {
      const close = cmd.indexOf('`', index + 1);
      if (close === -1) return -1;
      index = close;
    } else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const MAX_SUBSTITUTION_DEPTH = 4;

function isAssignmentWord(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

// A path that holds a secret, as a commit must never: the one rule in
// lane-contract.mjs (isSecretPath), shared with the merge families and the
// lane. The lane contract's other protected families (`.github`, the loop's
// control roots) stop a merge, not a commit, so they stay there.
// Options of `git add` and `git commit` that take a value, so the value is
// never read as a path.
const STAGING_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date',
  '-t', '--template', '--cleanup', '--trailer', '--fixup', '--squash', '--chmod', '--pathspec-from-file',
]);

// The secret paths a segment stages: `git add <paths>` and `git commit
// [-a] <paths>`, from the segment's quoted words (a commit message is one
// word, whatever it says). `git add .` names no path and is allowed.
export function stagedSecretPaths(words) {
  const index = [gitSubcommandIndex(words, 'add'), gitSubcommandIndex(words, 'commit')].find((at) => at !== -1);
  if (index === undefined) return [];
  const paths = [];
  let literal = false;
  for (let at = index + 1; at < words.length; at += 1) {
    const word = words[at];
    if (literal) {
      paths.push(word);
      continue;
    }
    if (word === '--') {
      literal = true;
      continue;
    }
    if (STAGING_VALUE_OPTIONS.has(word)) {
      at += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    paths.push(word);
  }
  return paths.filter(isSecretPath);
}

const MERGE_MUTATION_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest)\b/u;
const PROTECTION_MUTATION_RE = /\b(?:create|update|delete)(?:RepositoryRuleset|BranchProtectionRule)\b/u;
const COMMIT_REF_MUTATION_RE = /\b(?:createCommitOnBranch|updateRefs?|createRef|deleteRef)\b/u;
const MAX_EVALUATE_DEPTH = 4;

const MERGE_REASON = 'autoloop guard — no merge: the loop never merges a pull request, through `gh pr merge`, '
  + 'the REST merge endpoint or a GraphQL merge mutation. Allowed: `gh pr view <N> --json '
  + 'mergeStateStatus`; a human, or `auto-merge.mjs <PR>` where the repository config enables it, merges.';
const RELEASE_REASON = 'autoloop guard — no release publication: a release-tag push or a GitHub release '
  + 'mutation is a maintainer act. Allowed: `gh release view <tag>`; report release readiness and '
  + 'leave publication to the maintainer.';
const STATUS_REASON = 'autoloop guard — no hand-posted commit status: verdict evidence comes only from '
  + '`publish-verdict.mjs`, bound to the gate or review it ran on the exact head. Allowed: '
  + '`gh api repos/<o>/<r>/commits/<sha>/status` to read one.';
const PROTECTION_REASON = 'autoloop guard — no branch-protection mutation: the protection and ruleset baseline is '
  + 'the human\'s. Allowed: `gh api repos/<o>/<r>/branches/<base>/protection` to read it; '
  + 'report a mismatch instead of changing it.';
const COMMIT_REF_REASON = 'autoloop guard — no commit or ref write through the API: a contents, commit, tree or '
  + 'ref mutation commits past the checkout and its branch rules. Allowed: `git commit` on the unit branch '
  + 'and `git push origin HEAD:refs/heads/<unit-branch>`.';
const WORKFLOW_REASON = 'autoloop guard — no workflow dispatch: `gh workflow run|enable` and the dispatch '
  + 'endpoints run an unmerged branch with the repository\'s secrets. Allowed: `gh run list --branch '
  + '<unit-branch>` and `gh run view <id>`; a push to the unit branch triggers its own checks.';
const RAW_API_REASON = 'autoloop guard — no raw HTTP write to the GitHub API: a write past `gh` has none of '
  + 'its refusals. Allowed: `gh api <endpoint>` for a read, or the `gh` command the task needs.';

// The refusal an API endpoint earns, by family. The merge endpoint is
// refused whatever the method (its read is `gh pr view`); every other
// family refuses a write only. A `git/refs` write naming a tag is a release.
function apiEndpointProblem(path, mutating, text = '') {
  if ((path[3] === 'pulls' && path[5] === 'merge') || path[3] === 'merges') return MERGE_REASON;
  if (!mutating) return null;
  if (path.includes('protection') || path.includes('rulesets')) return PROTECTION_REASON;
  if (path[0] !== 'repos' || path.length < 4) return null;
  if (path[3] === 'statuses') return STATUS_REASON;
  if (path[3] === 'releases'
    || (path[3] === 'git' && (path[4] === 'tags' || (path[4] === 'refs' && (path[5] === 'tags' || /\brefs\/tags\//u.test(text)))))) {
    return RELEASE_REASON;
  }
  if (path[3] === 'contents' || (path[3] === 'git' && ['blobs', 'commits', 'refs', 'trees'].includes(path[4]))) {
    return COMMIT_REF_REASON;
  }
  if (path[3] === 'dispatches'
    || (path[3] === 'actions' && path[4] === 'workflows' && ['dispatches', 'enable'].includes(path[6]))) {
    return WORKFLOW_REASON;
  }
  return null;
}

// The refusals of a `gh api` segment: the merge endpoint, a merge mutation,
// a hand-posted commit status, a release or tag mutation, a commit or ref
// write (REST or GraphQL), a workflow dispatch, and a protection or ruleset
// mutation. Reads pass, whatever they name.
function ghApiProblem(words) {
  if (ghPositionals(words)?.[0] !== 'api') return null;
  const mutating = mutatingGhApi(words);
  const text = words.join(' ');
  if (MERGE_MUTATION_RE.test(text)) return MERGE_REASON;
  for (const path of githubApiEndpoints(words)) {
    const problem = apiEndpointProblem(path, mutating, text);
    if (problem !== null) return problem;
  }
  if (PROTECTION_MUTATION_RE.test(text)) return PROTECTION_REASON;
  if (COMMIT_REF_MUTATION_RE.test(text)) return COMMIT_REF_REASON;
  return null;
}

// Raw HTTP to the API host (`curl`, `wget`, httpie's `http`/`https`, `xh`):
// a write method, or an endpoint of a refused family, is refused; a plain
// GET or HEAD is a read. The method is read from the client's own options;
// a data or upload option implies a write.
const HTTP_CLIENTS = new Set(['curl', 'http', 'https', 'wget', 'xh']);
const CURL_VALUE_OPTIONS = new Set([
  '-A', '--user-agent', '-b', '--cookie', '-c', '--cookie-jar', '-D', '--dump-header', '-e', '--referer', '-H',
  '--header', '-K', '--config', '-m', '--max-time', '-o', '--output', '-u', '--user', '-w', '--write-out', '-x',
  '--proxy', '--cacert', '--capath', '--cert', '--connect-timeout', '--interface', '--key', '--limit-rate',
  '--max-redirs', '--oauth2-bearer', '--proto', '--resolve', '--retry', '--retry-delay', '--stderr', '--trace',
  '--trace-ascii', '--unix-socket',
]);
const CURL_WRITE_OPTIONS = new Set([
  '-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '-F', '--form', '--form-string',
  '--json', '-T', '--upload-file',
]);
const WGET_WRITE_OPTIONS = new Set(['--post-data', '--post-file', '--body-data', '--body-file']);
const HTTP_METHOD_RE = /^[A-Z]{3,8}$/u;

function rawApiProblem(words) {
  const client = words.findIndex((word, index) =>
    HTTP_CLIENTS.has(word.slice(word.lastIndexOf('/') + 1)) && invokedAt(words, index));
  if (client === -1) return null;
  const name = words[client].slice(words[client].lastIndexOf('/') + 1);
  const args = words.slice(client + 1);
  const endpoints = [];
  let method = null;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [option, inlineValue] = argument.startsWith('--') && argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, null];
    const value = () => (inlineValue !== null ? inlineValue : args[++index] ?? '');
    if (name === 'curl') {
      if (option === '-X' || option === '--request') method = value().toUpperCase();
      else if (/^-X[A-Za-z]+$/u.test(argument)) method = argument.slice(2).toUpperCase();
      else if (argument === '-G' || argument === '--get') method = 'GET';
      else if (argument === '-I' || argument === '--head') method ??= 'HEAD';
      else if (CURL_WRITE_OPTIONS.has(option)) {
        write = true;
        value();
      } else if (option === '--url') endpoints.push(normalizedGithubApiEndpoint(value(), { absoluteOnly: true }));
      else if (CURL_VALUE_OPTIONS.has(option)) value();
      else if (!argument.startsWith('-')) endpoints.push(normalizedGithubApiEndpoint(argument, { absoluteOnly: true }));
    } else if (name === 'wget') {
      if (option === '--method') method = value().toUpperCase();
      else if (WGET_WRITE_OPTIONS.has(option)) {
        write = true;
        value();
      } else if (!argument.startsWith('-')) endpoints.push(normalizedGithubApiEndpoint(argument, { absoluteOnly: true }));
    } else if (argument.startsWith('-')) {
      continue;
    } else if (HTTP_METHOD_RE.test(argument) && endpoints.length === 0) {
      method = argument;
    } else if (endpoints.length === 0) {
      endpoints.push(normalizedGithubApiEndpoint(argument, { absoluteOnly: true }));
    } else if (/^[^=:]+(?::=|==?|:)/u.test(argument)) {
      write = true;                                            // an httpie data item
    }
  }
  const found = endpoints.filter((endpoint) => endpoint !== null);
  if (found.length === 0) return null;
  const effective = method ?? (write ? 'POST' : 'GET');
  const mutating = !['GET', 'HEAD'].includes(effective);
  for (const path of found) {
    const problem = apiEndpointProblem(path, mutating, args.join(' '));
    if (problem !== null) return problem;
  }
  return mutating ? RAW_API_REASON : null;
}

// A literal `NAME=value` the command sets before a segment (`GH=gh; $GH pr
// merge 4`, `export G=git`): a later segment whose head is `$NAME` runs the
// value. An assignment prefix of the same segment does not reach its own
// head (the shell expands the head first), and a value with an expansion of
// its own is not literal.
function literalAssignments(words, into) {
  const assignments = words[0] === 'export' || words[0] === 'declare' || words[0] === 'local' ? words.slice(1) : words;
  if (assignments.length === 0 || !assignments.every(isAssignmentWord)) return;
  for (const word of assignments) {
    const name = word.slice(0, word.indexOf('='));
    const value = word.slice(word.indexOf('=') + 1);
    if (/[$`]/u.test(value)) into.delete(name);
    else into.set(name, value);
  }
}

function resolvedHead(words, assignments) {
  const name = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(words[0] ?? '')?.slice(1).find(Boolean);
  if (name === undefined || !assignments.has(name)) return words;
  return [...shellWords(assignments.get(name)), ...words.slice(1)];
}

// A git alias set on the command line runs its value where its name is used
// (`git -c alias.m='push --force' m`): the segment is judged as the command
// the value names, or as a script when the value starts with `!`. An alias
// whose value the guard cannot read (`--config-env`, an expansion, a config
// include) is hidden, and refused. `git -c alias.st=status st` is `git status`.
const HIDDEN_ALIAS_REASON = 'autoloop guard — no hidden git alias: a `-c alias.*` value the guard cannot read, '
  + '`--config-env=alias.*` or a config include can name any git command. Allowed: `git <subcommand>` '
  + 'spelled out, or `git -c alias.<name>=<literal value> <name>`.';

function resolvedGitAlias(words, assignments) {
  const git = executableIndex(words, 'git');
  if (git === -1) return { words };
  const aliases = new Map();
  const kept = words.slice(0, git + 1);
  let hidden = false;
  let subcommand = -1;
  for (let index = git + 1; index < words.length; index += 1) {
    const word = words[index];
    let setting = null;
    if (word === '-c' || word === '--config-env') setting = `${word}=${words[++index] ?? ''}`;
    else if (/^-c.+/u.test(word)) setting = `-c=${word.slice(2)}`;
    else if (word.startsWith('--config-env=')) setting = word;
    if (setting !== null) {
      const alias = /^(-c|--config-env)=alias\.([^=]+)=(.*)$/su.exec(setting);
      if (/^(?:-c|--config-env)=include(?:if\.[^=]*)?\.path(?:=|$)/iu.test(setting)) hidden = true;
      else if (alias === null) kept.push(...(word === '-c' || word === '--config-env' ? [word, words[index]] : [word]));
      else if (alias[1] === '--config-env') {
        if (assignments.has(alias[3])) aliases.set(alias[2].toLowerCase(), assignments.get(alias[3]));
        else hidden = true;
      } else if (/[$`]/u.test(alias[3])) hidden = true;
      else aliases.set(alias[2].toLowerCase(), alias[3]);
      continue;
    }
    if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(word)) {
      kept.push(word, words[++index] ?? '');
      continue;
    }
    if (word.startsWith('-')) {
      kept.push(word);
      continue;
    }
    subcommand = index;
    break;
  }
  if (subcommand === -1) return { words };
  const value = aliases.get(words[subcommand].toLowerCase());
  if (value === undefined) return hidden ? { words, hidden: true } : { words };
  const rest = words.slice(subcommand + 1);
  if (value.startsWith('!')) return { words, script: [value.slice(1), ...rest].join(' ') };
  return { words: [...kept, ...shellWords(value), ...rest] };
}

// The command's segments as words: heredoc bodies and comments out, ANSI-C
// quotes decoded, line continuations joined, subshell parentheses trimmed,
// quotes kept until the words are split (so `;` in a message splits nothing).
// Each segment carries the heredoc body it reads, the literal head an earlier
// assignment names, and the git alias it runs.
function segmentWords(cmd) {
  const lexed = lexShell(cmd, { markHeredocs: true });
  const text = quotedAnsiC(lexed.text).replace(/\\\r?\n/gu, '');
  const assignments = new Map();
  return shellSegments(text).map((segment) => {
    let heredoc;
    const words = shellWords(trimSubshell(segment.command)).filter((word) => {
      const mark = word.startsWith(HEREDOC_MARK) ? lexed.bodies[Number(word.slice(1))] : undefined;
      if (mark !== undefined) heredoc = mark.body;
      return mark === undefined;
    });
    const resolved = resolvedGitAlias(resolvedHead(words, assignments), assignments);
    literalAssignments(words, assignments);
    return { ...segment, ...resolved, heredoc };
  });
}

// The text a shell segment runs when it is fed rather than told (`bash
// <<EOF`, `sh <<< '…'`, `echo '…' | sh`): its heredoc, its here-string, or
// the literal an `echo`/`printf` pipes into it. A shell with `-c` is read by
// nestedScript; anything else fed to it is unknown, and allowed.
function fedScript(segment, previous) {
  const { words } = segment;
  let index = 0;
  while (index < words.length && (isAssignmentWord(words[index]) || EXEC_WRAPPERS.has(basename(words[index])))) index += 1;
  if (!/^(?:ba|da|k|z)?sh$/u.test(basename(words[index] ?? ''))) return undefined;
  if (words.some((word, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word))) return undefined;
  const hereString = words.indexOf('<<<', index + 1);
  if (hereString !== -1) return words[hereString + 1];
  if (segment.heredoc !== undefined) return segment.heredoc;
  if (previous?.raw !== '|') return undefined;
  const head = basename(previous.words[0] ?? '');
  if (head === 'cat' && previous.words.length === 1) return previous.heredoc;
  if (head === 'echo') return previous.words.slice(1).filter((word) => !/^-[eEn]+$/u.test(word)).join(' ');
  if (head === 'printf') {
    const [format, ...values] = previous.words.slice(1).filter((word) => word !== '--');
    return (format ?? '').replace(/\\n/gu, '\n').replace(/%[^a-zA-Z%]*[a-zA-Z]/gu, () => values.shift() ?? '');
  }
  return undefined;
}

export function evaluate(inputCmd, branch, options = {}) {
  if (typeof inputCmd !== 'string' || inputCmd.length === 0) return { block: false };
  const depth = options.depth ?? 0;
  const baseBranch = options.baseBranch ?? 'main';
  const segments = segmentWords(inputCmd);

  // A script a segment runs as text (`eval`, `sh -c`, a `!` git alias, a
  // trap, a gh alias, a shell fed by a heredoc or a literal echo), and every
  // command substitution, is judged as the commands it holds. A literal
  // evasion of a rule below is caught here; a script the lexer cannot take
  // apart is allowed.
  if (depth < MAX_EVALUATE_DEPTH) {
    const nested = [
      ...segments.map((segment, index) =>
        nestedScript(segment.words)?.script ?? segment.script ?? fedScript(segment, segments[index - 1]))
        .filter((script) => script !== undefined),
      ...substitutionBodies(quotedAnsiC(stripHeredocs(inputCmd))),
    ];
    for (const script of nested) {
      const inner = evaluate(script, branch, { ...options, depth: depth + 1 });
      if (inner.block) return inner;
    }
  }
  if (segments.some(({ hidden }) => hidden === true)) return { block: true, reason: HIDDEN_ALIAS_REASON };

  // 1. never merge — structural: `pr` then `merge` are gh's positional words.
  // A free-text scan also matched option arguments, so a PR *title* containing
  // "merge policy" tripped the rule (live run 3bdd6e5e).
  if (segments.some(({ words }) => {
    const positionals = ghPositionals(words);
    return positionals?.[0] === 'pr' && positionals[1] === 'merge';
  })) {
    return { block: true, reason: MERGE_REASON };
  }

  // 4. releases: `gh release create|delete|edit|upload` and a tag push.
  if (segments.some(({ words }) => {
    const positionals = ghPositionals(words);
    return (positionals?.[0] === 'release' && ['create', 'delete', 'edit', 'upload'].includes(positionals[1]))
      || pushesReleaseTag(words);
  })) {
    return { block: true, reason: RELEASE_REASON };
  }

  // 12. a workflow dispatch runs an unmerged branch with the repository's
  // secrets (review of the guard reduction).
  if (segments.some(({ words }) => {
    const positionals = ghPositionals(words);
    return positionals?.[0] === 'workflow' && ['enable', 'run'].includes(positionals[1]);
  })) {
    return { block: true, reason: WORKFLOW_REASON };
  }

  // 1, 4, 5 and 12 through `gh api`, and through raw HTTP to the API host.
  for (const { words } of segments) {
    const problem = ghApiProblem(words) ?? rawApiProblem(words);
    if (problem !== null) return { block: true, reason: problem };
  }

  // 6. a secret path staged (a message is one word, whatever it says).
  for (const { words } of segments) {
    const [path] = stagedSecretPaths(words);
    if (path !== undefined) {
      return {
        block: true,
        reason:
          `autoloop guard — no secret path in a commit: \`${path}\` is an .env file, key material or a `
          + 'credential path. Allowed: `git add <source path>` for the other files; leave the secret '
          + 'file unstaged and name it in the report.',
      };
    }
  }

  // 2. the base branch takes pull requests only: the branch each segment runs
  // on is followed through `git switch|checkout` and the `&&`/`||`/`;` operators.
  let states = [{ branch: branch ?? null, succeeded: null }];
  let previousOperator = null;
  for (const segment of segments) {
    const executes = states.filter(({ succeeded }) =>
      previousOperator === null
      || previousOperator === ';'
      || (previousOperator === '&&' && succeeded === true)
      || (previousOperator === '||' && succeeded === false));
    const skipped = states.filter((state) => !executes.includes(state));
    const possibleBranches = new Set(
      executes.map((state) => state.branch).filter(Boolean),
    );
    const { words } = segment;
    if (
      gitSubcommandIndex(words, 'commit') !== -1
      && (
        possibleBranches.has(baseBranch)
        || executes.some((state) => state.branch === null)
      )
    ) {
      return {
        block: true,
        reason:
          `autoloop guard — no commit on the base branch: "${baseBranch}" takes pull requests only, `
          + 'and the current branch must be known. Allowed: `git switch -c <type>/gh-<N>-<slug>` '
          + 'first, then the same commit there.',
      };
    }
    if (pushTargetsBase(words, possibleBranches, baseBranch)) {
      return {
        block: true,
        reason:
          `autoloop guard — no push to the base branch: "${baseBranch}" takes pull requests only. `
          + 'Allowed: `git push origin HEAD:refs/heads/<unit-branch>`, an explicit non-base refspec.',
      };
    }
    const target = switchTarget(words, baseBranch);
    const outcomes = [...skipped];
    for (const state of executes) {
      outcomes.push({
        branch: target ? normalizedBranch(target) : state.branch,
        succeeded: true,
      });
      outcomes.push({ branch: state.branch, succeeded: false });
    }
    states = [...new Map(
      outcomes.map((state) => [
        `${state.branch ?? ''}\0${state.succeeded}`,
        state,
      ]),
    ).values()];
    previousOperator = segment.next;
  }

  // 7. no co-author trailers (checked on the whole command: the trailer rides
  // in -m text or a heredoc message).
  if (
    segments.some(({ words }) => gitSubcommandIndex(words, 'commit') !== -1)
    && /Co-Authored-By:/iu.test(inputCmd)
  ) {
    return {
      block: true,
      reason:
        'autoloop guard — no Co-Authored-By trailer: commits carry no co-author. Allowed: '
        + '`git commit -m "<subject>"` with the same message and no trailer.',
    };
  }

  // 3. force pushes: only --force-with-lease. Catches both the `--force`/`-f` flags AND the
  //    `+<refspec>` force syntax (`git push origin +main`, incl. a quoted `'+refs/…'`), which
  //    force-updates a ref with neither flag. Scoped to the words AFTER `push`: testing the
  //    whole command line read `date +%H:%M` as a force refspec (2026-07-29).
  if (segments.some(({ words }) => {
    const push = gitSubcommandIndex(words, 'push');
    return push !== -1 && words.slice(push + 1).some(
      (word) => longOptionPrefix(word, '--force') || /^-[^-]*f[^-]*$/u.test(word) || /^\+\S/u.test(word),
    );
  })) {
    return {
      block: true,
      reason:
        'autoloop guard — no force push: `--force`, `-f` and a `+<refspec>` rewrite history. Allowed: '
        + '`git push --force-with-lease origin <unit-branch>`, after a rebase.',
    };
  }

  return { block: false };
}

function currentBranch() {
  const result = boundedGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return branch.length > 0 ? branch : null;
}

// A command that runs the plugin's own prime to open a run (not --close-run,
// --park or --self-test) in a repository other than the session's project.
// It follows the command's own directory changes (cd, pushd, env -C, in
// subshells too) and matches the invocation, never a mention: `rg prime.mjs`
// or another repository's prime.mjs is none of its business. Compared by
// common git dir, so a linked worktree of the project is the project.
const PLUGIN_PRIME = realOrSelf(join(dirname(fileURLToPath(import.meta.url)), 'prime.mjs'));
const PRIME_EXEMPT = new Set(['--close-run', '--park', '--self-test']);

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function commonGitDir(dir) {
  const result = boundedGit(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return result.status === 0 ? realOrSelf(result.stdout.trim()) : null;
}

// Where a segment runs node, if it does: node in executable position (behind
// passthrough wrappers, their options and assignments only), with the
// directory an `env -C`/`--chdir` moves it to.
function nodeInvocation(words, dir) {
  let target = dir;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (basename(word) === 'node') return { index: i, target };
    if (word === '-C' || word === '--chdir') {
      if (words[i + 1] !== undefined) target = resolve(dir, expandHome(words[i + 1]));
      i += 1;
    } else if (word.startsWith('--chdir=')) {
      target = resolve(dir, expandHome(word.slice('--chdir='.length)));
    } else if (!(EXEC_WRAPPERS.has(basename(word)) || isAssignmentWord(word) || word.startsWith('-') || /^\d+[smhd]?$/u.test(word))) {
      return null;
    }
  }
  return null;
}

// Drops subshell parentheses and whitespace from a segment's ends. Linear on
// purpose: a backtracking pattern here let a padded command outrun the hook
// timeout (security re-audit, round 5).
function trimSubshell(segment) {
  let start = 0;
  let end = segment.length;
  while (start < end && (segment[start] === '(' || /\s/u.test(segment[start]))) start += 1;
  while (end > start && (segment[end - 1] === ')' || /\s/u.test(segment[end - 1]))) end -= 1;
  return segment.slice(start, end);
}

// The hook's own budget: the host kills a hook at 15 s and then lets the
// command run, so a guard that cannot finish must refuse before that. Every
// prime segment cost two git spawns, and a padded command outran the timeout
// (security audit after 0.60.0); common dirs are now resolved once each.
export const GUARD_DEADLINE_MS = 10_000;
const MAX_PRIME_TARGETS = 64;
const OVER_BUDGET = 'autoloop guard — this command is too large to check within the guard\'s time '
  + 'budget, so it cannot be proven safe. Split it into smaller commands.';

export function foreignPrimeProblem(command, cwd, projectRoot, prime = PLUGIN_PRIME, deadline = Date.now() + GUARD_DEADLINE_MS) {
  if (typeof command !== 'string' || !/\bnode\b/u.test(command)) return null;
  let dir = cwd;
  let project;
  const targets = new Map();
  for (const { command: segment } of shellSegments(command)) {
    if (Date.now() > deadline) return OVER_BUDGET;
    let words = shellWords(trimSubshell(segment));
    const comment = words.findIndex((word) => word.startsWith('#'));
    if (comment !== -1) words = words.slice(0, comment);
    if ((words[0] === 'cd' || words[0] === 'pushd') && words[1] !== undefined) {
      dir = resolve(dir, expandHome(words[1]));
      continue;
    }
    const target = primeTarget(words, dir, prime);
    if (target === null) continue;
    // A function defers the project root's own git lookup to a prime command.
    if (typeof projectRoot === 'function') projectRoot = projectRoot();
    if (project === undefined) project = commonGitDir(projectRoot);
    if (!targets.has(target)) {
      if (targets.size === MAX_PRIME_TARGETS) return OVER_BUDGET;
      targets.set(target, commonGitDir(target));
    }
    if (project === null || targets.get(target) === project) continue;
    return `autoloop guard — this session's project is ${projectRoot}, but prime would open the run in `
      + `${target}, outside it: the session's hooks would guard the wrong repository. Start a `
      + 'session in that repository and run the loop there.';
  }
  return null;
}

// A branch switch in a checkout a reviewer is reading changes the files
// under it: the LFE run (2026-09-30) switched to finalize one unit while
// another's code review read the same checkout, and had to kill and redo the
// review. The review roles read; a branch switch waits for them (other
// HEAD moves — reset, rebase, pull — are not covered here).
const READING_ROLES = new Set(['plan-review', 'diff-review', 'code-review', 'doubt-review']);

export function switchesCheckout(words) {
  const git = words.findIndex((word, index) => (word === 'git' || word.endsWith('/git')) && invokedAt(words, index));
  if (git === -1) return false;
  // Past git's own options (and -C / -c values) to the subcommand.
  let index = git + 1;
  while (index < words.length && words[index].startsWith('-')) index += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[index]) ? 2 : 1;
  const subcommand = words[index];
  const rest = words.slice(index + 1);
  if (rest.includes('--help') || rest.includes('-h')) return false;
  // A new branch with no start point is made at HEAD: no file under a reader
  // changes (review of the no-run switch rule).
  const positional = rest.filter((word) => !word.startsWith('-'));
  const creates = rest.some((word) => ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(word));
  if (creates && positional.length <= 1) return false;
  if (subcommand === 'switch') return true;
  // `git checkout <ref>` (or `-b <new> <start>`) moves HEAD; `git checkout
  // [<ref>] -- <paths>` edits files only.
  return subcommand === 'checkout' && !rest.includes('--') && (creates || positional.length === 1);
}

function readingDispatchIn(dir) {
  let top;
  try {
    top = realpathSync(dir);
  } catch {
    return null;
  }
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return null; // no process table: the rule cannot look, and does not guess
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      const role = args[args.indexOf('--role') + 1];
      if (!args.some((arg) => /dispatch(?:-stream\.sh|\.mjs)$/u.test(arg)) || !READING_ROLES.has(role)) continue;
      const cwd = realpathSync(`/proc/${entry}/cwd`);
      if (cwd === top || cwd.startsWith(`${top}/`)) return { pid: Number(entry), role };
    } catch { /* gone, or not ours to read */ }
  }
  return null;
}

// Whether a segment runs the plugin's own prime to open a run.
// The directory a segment runs the plugin's prime in to open a run (not
// --close-run, --park or --self-test), or null when it does not.
function primeTarget(words, dir, prime = PLUGIN_PRIME) {
  const node = nodeInvocation(words, dir);
  if (node === null) return null;
  const scriptIndex = words.findIndex((word, index) => index > node.index && !word.startsWith('-'));
  if (scriptIndex === -1 || realOrSelf(resolve(node.target, expandHome(words[scriptIndex]))) !== prime) return null;
  return words.slice(scriptIndex + 1).some((word) => PRIME_EXEMPT.has(word)) ? null : node.target;
}

function primeSegment(words, cwd, prime = PLUGIN_PRIME) {
  return primeTarget(words, cwd, prime) !== null;
}

// Whether a command opens a run anywhere in it (cd steps followed).
export function opensRun(command, cwd, prime = PLUGIN_PRIME) {
  if (typeof command !== 'string' || !/\bnode\b/u.test(command)) return false;
  let dir = cwd;
  for (const { command: segment } of shellSegments(stripHeredocs(command))) {
    const words = shellWords(trimSubshell(segment));
    if ((words[0] === 'cd' || words[0] === 'pushd') && words[1] !== undefined) {
      dir = resolve(dir, expandHome(words[1]));
      continue;
    }
    if (primeSegment(words, dir, prime)) return true;
  }
  return false;
}

// The plugin hook passes nothing (the root is CLAUDE_PROJECT_DIR); `--root`
// names one explicitly (tests, smoke). A STATE path is never accepted: its
// repository would have to be guessed from where the file sits.
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { selfTest: true, root: undefined, error: null };
  }
  if (args.length === 0) return { selfTest: false, root: undefined, error: null };
  if (args.length === 2 && args[0] === '--root' && typeof args[1] === 'string' && args[1].length > 0) {
    return { selfTest: false, root: args[1], error: null };
  }
  return { selfTest: false, root: undefined, error: 'expected --root <repository> or --self-test' };
}

// Corpus replay: real command shapes from live sessions, each tagged with the
// incident that earned it a place. Unit fixtures test what we imagined; the
// corpus tests what sessions actually typed — five of one day's bugs were guard
// verdicts on commands no fixture contained. Exposed as `--corpus` so verify
// replays it as its own step.
export function replayCorpus() {
  const failures = [];
  let total = 0;
  try {
    const corpusPath = join(dirname(fileURLToPath(import.meta.url)), 'guard-corpus.json');
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
    for (const entry of corpus.cases) {
      const verdict = evaluate(entry.cmd, entry.branch, { baseBranch: 'main' });
      const got = verdict.block ? 'block' : 'allow';
      if (got !== entry.expect) {
        failures.push(
          `FAIL [corpus: expect ${entry.expect}, got ${got}] (${entry.why}): `
          + entry.cmd.split('\n')[0]);
      }
    }
    total = corpus.cases.length;
  } catch (error) {
    failures.push(`FAIL [corpus unreadable]: ${error.message}`);
  }
  return { total, failures };
}

// A question asked mid-run waits on a human who is, by design, not there:
// three AskUserQuestion calls in live LFE runs idled 2.2h, 23.2h and more,
// every other unit in the queue waiting behind one unit's decision. The
// decision belongs on that unit's issue, where the human will look anyway.
export function askUserQuestionProblem(runIsLive) {
  if (runIsLive !== true) return null;
  return 'autoloop guard — a live run never waits on a synchronous question: every other '
    + 'queued unit would wait behind it. A judgment call is yours to make: take the recommended '
    + 'option and record it with `unit.mjs --decide`. A genuine human decision is `unit.mjs '
    + '--block`, which records the question on the issue. Then take the next unit. If no unit can proceed, '
    + 'close the run first (`node <plugin-tools>/prime.mjs --close-run`), then ask.';
}

function selfTest() {
  // Every hook this self-test spawns gets its own HOME: the session latch
  // lives there and is keyed by the Claude process running the test, so a
  // shared (or the real) HOME would latch one case's run into the next — or
  // into the operator's own session.
  const homes = [];
  const isolatedEnv = () => {
    homes.push(mkdtempSync(join(tmpdir(), 'guard-home-')));
    return { ...process.env, HOME: homes.at(-1) };
  };
  let corpusCount = 0;
  const tools = dirname(fileURLToPath(import.meta.url));
  const cases = [
    // [cmd, branch, expectBlock, baseBranch]
    // 2026-09-30, the LFE run: quoted text read as commands. A quoted jq
    // filter's `|`, a quoted regex's backquotes and `(sh|bash)`, a block
    // question quoting the command a human should run, the `'"'"'` idiom and
    // PHP's ` . ` concatenation are all text.
    [`node ${join(tools, 'unit.mjs')} --block --issue 5 --question "May #5 be finalized? A human runs: gh pr merge 5"`, 'feat/gh-1-x', false],
    [`node ${join(tools, 'prime.mjs')} --park "#396 race evidence (base contracts + head -race suite)" --minutes 60`, 'feat/gh-1-x', false],
    ["rg -n '^```(sh|bash|shell)' b.md", 'feat/gh-1-x', false],
    ["sed -i 's/a/it'\"'\"'s `x`/' f", 'feat/gh-1-x', false],
    ["ddev wp eval '$a = \"x\" . \"y\"; $b = $c - 7; echo $a;'", 'feat/gh-1-x', false],
    ["rg -c '^Closes #388$' f; node x.mjs", 'feat/gh-1-x', false],
    // Review of the LFE fixes: a keyword, group or unlisted wrapper in front
    // of gh, an eval'd script, an escaped quote or backslash — none may hide
    // a refused command.
    ["echo it\\'s && git push origin main", 'feat/gh-1-x', true],
    ["echo \"\\\\'\" && git push origin main", 'feat/gh-1-x', true],
    ["echo \"\\\\'\" && gh pr merge 5", 'feat/gh-1-x', true],
    ["echo \\\\\\\" && git push origin main", 'feat/gh-1-x', true],
    ["echo \"a\\\\\\\"b\" ; gh pr merge 5", 'feat/gh-1-x', true],
    ["printf '%s\\\\' \"\\\\'\" && git push origin main", 'feat/gh-1-x', true],
    ['{ gh pr merge 5; }', 'feat/gh-1-x', true],
    ['if true; then gh release create v1; fi', 'feat/gh-1-x', true],
    ['! gh pr merge 5', 'feat/gh-1-x', true],
    ['for i in 1; do gh pr merge 5; done', 'feat/gh-1-x', true],
    ['eval "x; gh pr merge 5"', 'feat/gh-1-x', true],
    ["eval 'gh pr merge 5'", 'feat/gh-1-x', true],
    ["bash -c 'gh pr merge 5'", 'feat/gh-1-x', true],
    ["sh -c 'git push origin HEAD:main'", 'feat/gh-1-x', true],
    ['(( x = 1<<EOF ))\ngit push origin main\nEOF', 'feat/gh-1-x', true],
    // Second review: a decoded ANSI-C backslash escaping the newline.
    ["echo $'\\x5c'\ngh release create v1", 'feat/gh-1-x', true],
    ["echo $'\\\\'\ngh pr merge 5", 'feat/gh-1-x', true],
    // ...and none of that may hide a real command: a quote inside the other
    // kind (or escaped) left bare turned the rest of the line into one word.
    ['git commit -qm "it\'s" && git push origin main', 'feat/gh-1-x', true],
    ['git commit -qm \'a "b\' && git push origin main', 'feat/gh-1-x', true],
    ["rg -c '^x$' f; gh pr merge 5 --squash", 'feat/gh-1-x', true],
    // SPEC-guard-reduction: a word that only names git or gh is data. A
    // search for a refused command, a banner, a log grep, a quoted question.
    ['rg -n "gh pr merge" docs', 'feat/gh-1-x', false],
    ['rg -n "git push --force" docs', 'feat/gh-1-x', false],
    ['git log --grep "git push origin main" --oneline', 'feat/gh-1-x', false],
    ['echo "=== git diffstat ==="', 'feat/gh-1-x', false],
    ['echo "gh pr merge 42"', 'feat/gh-1-x', false],
    ['node /tmp/x.mjs --question "gh pr merge 5"', 'feat/gh-1-x', false],
    ['cd /r\nnode /p/scaffold.mjs --reconcile . 2>&1 | head -80', 'feat/gh-1-x', false],
    ['git log --oneline | grep node', 'feat/gh-1-x', false],
    // The removed rules' former triggers are allowed: inline interpreters,
    // heredocs, loops, expansions, unknown subcommands, inline bodies,
    // readiness, labels, a long command.
    ['python3 -c "import json; print(1)"', 'feat/gh-1-x', false],
    ["node -e 'console.log(1)'", 'feat/gh-1-x', false],
    ['node', 'feat/gh-1-x', false],
    ['echo data | node', 'feat/gh-1-x', false],
    ["zsh -ic 'alias | grep x'", 'feat/gh-1-x', false],
    ['bash <<\'EOF\'\nls\nEOF', 'feat/gh-1-x', false],
    ['. /dev/stdin', 'feat/gh-1-x', false],
    ['command -v php', 'feat/gh-1-x', false],
    ['for f in a.md b.md; do rg -n "^## " $f; done', 'feat/gh-1-x', false],
    ['for f in $(ls); do rm $f; done', 'feat/gh-1-x', false],
    ['while read l; do echo $l; done', 'feat/gh-1-x', false],
    ['S="/tmp/a b"; ls $S', 'feat/gh-1-x', false],
    ['ls $UNSET_PATH/x', 'feat/gh-1-x', false],
    ['verb=view; gh pr $verb 42', 'feat/gh-1-x', false],
    ['git diffstat', 'feat/gh-1-x', false],
    ['gh foo', 'feat/gh-1-x', false],
    ['git -c alias.st=status st', 'feat/gh-1-x', false],
    ['git commit -q -F - <<EOF\nmsg with $(pwd) live\nEOF', 'feat/gh-1-x', false],
    ['gh pr create --draft --title "t" --body "inline"', 'feat/gh-2-y', false],
    ['gh issue comment 5 -b "hi"', 'feat/gh-2-y', false],
    ['gh issue comment 7 --body "/answer 128 chars"', 'feat/gh-2-y', false],
    ['gh issue comment 7 --body-file /dev/stdin', 'feat/gh-2-y', false],
    ['gh pr ready 42', 'feat/gh-2-y', false],
    ['gh issue edit 7 --add-label loop-ready', 'feat/gh-2-y', false],
    ['gh issue edit 40 --remove-label loop-halt', 'main', false],
    ['gh issue edit 7 --add-label loop-repair', 'feat/gh-2-y', false],
    ['gh label edit old-name --name loop-ready', 'feat/gh-2-y', false],
    ['gh issue edit 298 --add-label "loop:02-plan" --remove-label "loop:03-plan-review"', 'main', false],
    ['gh issue edit 298 --add-label loop:05-implement', 'feat/gh-298-x', false],
    ['gh issue edit 296 --add-label loop:10-publish', 'feat/gh-296-x', false],
    ['gh api repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{pullRequestId:\"x\"}){pullRequest{id}}}'", 'feat/gh-2-y', false],
    ['gh api graphql --input /tmp/query.json', 'feat/gh-2-y', false],
    [`echo ${'x'.repeat(70 * 1024)}`, 'feat/gh-1-x', false],
    ["awk '{ print | \"sh\" }' f", 'feat/gh-1-x', false],
    ['diff <(git show a:f) <(git show b:f)', 'feat/gh-1-x', false],
    ['git push origin $(git branch --show-current)', 'feat/gh-1-x', false],
    ['echo "${X:-$(cat f)}"', 'feat/gh-1-x', false],
    // 1. merge, in every spelling the lexer resolves.
    ['gh pr merge 42', 'feat/gh-1-x', true],
    ['gh --repo o/r pr merge 42 --squash', 'feat/gh-1-x', true],
    ['gh pr merge --auto 42', 'feat/gh-1-x', true],
    ['for f in 41 42; do gh pr merge $f; done', 'feat/gh-1-x', true],
    ['g""h p""r m""erge 42', 'feat/gh-1-x', true],
    ['g\\\nh pr merge 42', 'feat/gh-1-x', true],
    ["$'g\\x68' pr merge 42", 'feat/gh-1-x', true],
    ['timeout 30 gh pr merge 42', 'feat/gh-1-x', true],
    ['xargs -n1 gh pr merge', 'feat/gh-1-x', true],
    ['echo $(gh pr merge 42)', 'feat/gh-1-x', true],
    ['echo "`gh pr merge 42`"', 'feat/gh-1-x', true],
    // The word "merge" inside an option argument is not a merge invocation: a PR
    // about merge policy must be creatable (live false positive, run 3bdd6e5e).
    ['gh pr create --fill --title "chore: migrate scaffold and enable auto merge policy"', 'chore/autoloop-migrate', false],
    ['gh pr edit 180 --title "enable auto merge policy"', 'feat/gh-2-y', false],
    ["gh pr view 42 --jq '$.mergeable'", 'feat/gh-1-x', false],
    ['gh pr view 42 --json mergeStateStatus,mergeable', 'develop', false],
    ['gh pr list --search draft:false', 'main', false],
    // 2. the base branch takes pull requests only.
    ['git commit -m "feat: x"', 'develop', true, 'develop'],
    ['git commit -m "feat: x"', 'main', true],
    ['git commit -m "feat: x"', 'master', true, 'master'],
    ['git commit -m "feat: unknown branch"', null, true, 'trunk'],
    ['git commit -m "feat: x"', 'feat/gh-2-y', false],
    ['git c\\\nommit -m "unsafe continued token"', 'trunk', true, 'trunk'],
    ["$'g\\151t' commit -m \"unsafe encoded token\"", 'trunk', true, 'trunk'],
    ['(git commit -m "unsafe grouped")', 'trunk', true, 'trunk'],
    ['$(git commit -m "unsafe substitution")', 'trunk', true, 'trunk'],
    ['`git commit -m "unsafe backtick"`', 'trunk', true, 'trunk'],
    ['echo "$(git commit -m unsafe)"', 'trunk', true, 'trunk'],
    ['{ git commit -m "unsafe brace"; }', 'trunk', true, 'trunk'],
    ['(git switch -c feat/gh-3-z && git commit -m "safe grouped")', 'trunk', false, 'trunk'],
    ['git switch -c feat/gh-3-z && git commit --allow-empty -m "chore: claim #3"', 'main', false],
    ['git commit -m "unsafe first" && git switch feat/gh-3-z', 'trunk', true, 'trunk'],
    ['git switch trunk && git commit -m "unsafe target"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch feat/gh-3-z || git commit -m "unsafe fallback"', 'trunk', true, 'trunk'],
    ['git switch trunk || git switch feat/gh-3-z && git commit -m "unsafe"', 'trunk', true, 'trunk'],
    ['git checkout trunk || git switch feat/gh-3-z && git push origin HEAD', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z; git commit -m "unsafe after uncertain switch"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z | git commit -m "unsafe pipeline"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout -b feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout ./README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout . && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout HEAD -- README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git -C . checkout README.md && git -C . commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout --track origin/trunk && git commit -m "unsafe tracked base"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch --track origin/trunk && git commit -m "unsafe tracked base"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch --track origin/feat/gh-3-z && git commit -m "safe tracked unit"', 'trunk', false, 'trunk'],
    ['git commit -m "allowed on main"', 'main', false, 'trunk'],
    ['git push origin HEAD', 'trunk', true, 'trunk'],
    ['git push origin @', 'trunk', true, 'trunk'],
    ['git push origin HEAD', 'feat/gh-2-y', false, 'trunk'],
    ['git push', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git switch feat/gh-2-y && git push origin HEAD', 'trunk', false, 'trunk'],
    ['git push --all origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --al origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --branches origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --bra origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --mirror origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --mi origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :', 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/*:refs/heads/*'", 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/feat/*:refs/heads/feat/*'", 'feat/gh-2-y', false, 'trunk'],
    ['git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/heads/trunk', 'feat/gh-2-y', true, 'trunk'],
    ['(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['$(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['echo "`git push origin HEAD:trunk`"', 'feat/gh-2-y', true, 'trunk'],
    ['{ git push origin HEAD:trunk; }', 'feat/gh-2-y', true, 'trunk'],
    ["(g'i't push origin HEAD:trunk)", 'feat/gh-2-y', true, 'trunk'],
    ['/usr/bin/git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --rep=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --delete origin trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push --set-upstream origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['A=1 git status --short', 'feat/gh-1-x', false],
    ['timeout 30 git fetch origin main', 'feat/gh-1-x', false],
    // 3. force pushes.
    ['git push --force origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo""rce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo\\\nrce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ["git push --$'f\\x6frce' origin feat/gh-2-y", 'feat/gh-2-y', true],
    ['git push --for origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -uf origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -fq origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -f', 'feat/gh-2-y', true],
    ['git push --force-with-lease origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin +main', 'feat/gh-2-y', true],
    ["git push origin '+refs/heads/main'", 'main', true],
    ['git push origin HEAD:refs/heads/feat/gh-2-y; date +%H:%M', 'feat/gh-2-y', false],
    // 4. releases and tags.
    ['git push --tags origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --follow-tags origin feat/gh-2-y', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['gh release create v0.40.0 --notes-file /tmp/notes.md', 'feat/gh-2-y', true],
    ['gh release edit v0.40.0 --title changed', 'feat/gh-2-y', true],
    ['gh release delete v0.40.0 --yes', 'feat/gh-2-y', true],
    ['gh release upload v0.40.0 /tmp/asset.tgz', 'feat/gh-2-y', true],
    ['gh release view v0.40.0', 'feat/gh-2-y', false],
    ['gh release list', 'feat/gh-2-y', false],
    ['gh api repos/o/r/releases -X POST --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X PATCH --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7/assets -X POST --input /tmp/asset.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/assets/9 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/git/refs -X POST -f ref=refs/tags/v0.40.0 -f sha=abc', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases', 'feat/gh-2-y', false],
    // 1 and 5 through gh api: merge, status, protection mutations; reads pass.
    ['gh api repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api repos/o/r/pulls/42/mer\\\nge -X PUT', 'feat/gh-2-y', true],
    ["gh api repos/o/r/pulls/42/$'m\\x65rge' -X PUT", 'feat/gh-2-y', true],
    ['gh api repos/o/r/merges -f base=main -f head=feat/gh-2-y', 'feat/gh-2-y', true],
    ['gh api /repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    [`gh api repos/o/r/statuses/${'a'.repeat(40)} -f state=success -f context=agentic/gate`, 'feat/gh-2-y', true],
    [`gh api repos/o/r/statuses/${'a'.repeat(40)} --method POST --input /tmp/s.json`, 'feat/gh-2-y', true],
    [`gh api repos/o/r/commits/${'a'.repeat(40)}/status`, 'feat/gh-2-y', false],
    [`gh api repos/o/r/commits/${'a'.repeat(40)}/statuses`, 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"})}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"x\"})}'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/branches/main/protection -X DELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -XDELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -f enforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -fenforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -Frequired_status_checks=null', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X DELETE', 'main', true],
    ['gh api orgs/o/rulesets/123 -X DELETE', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X PATCH -f enforcement=disabled', 'main', true],
    ["gh api graphql -f query='mutation{deleteRepositoryRuleset(input:{repositoryRulesetId:\"x\"}){clientMutationId}}'", 'main', true],
    ["gh api repos/o/r/branches/main/protection --jq '.enforce_admins.enabled'", 'main', false],
    ['gh api repos/o/r/rulesets', 'main', false],
    ["gh api repos/o/r/issues/5/timeline --jq '.[]'", 'main', false],
    ['gh api repos/o/r/collaborators/alice/permission --jq .role_name', 'main', false],
    ['gh api repos/o/r/issues/7 -X PATCH -f title=x', 'feat/gh-2-y', false],
    // 6. secret paths staged; source and messages pass.
    ['git add .env', 'feat/gh-2-y', true],
    ['git add .env.local src/app.mjs', 'feat/gh-2-y', true],
    ['git add config/.env.production', 'feat/gh-2-y', true],
    ['git add certs/server.pem', 'feat/gh-2-y', true],
    ['git add id_rsa.key', 'feat/gh-2-y', true],
    ['git add keys/deploy', 'feat/gh-2-y', true],
    ['git add config/credentials.yml', 'feat/gh-2-y', true],
    ['git add secrets/api.json', 'feat/gh-2-y', true],
    ['git add token.txt', 'feat/gh-2-y', true],
    ['git add certs/server.crt', 'feat/gh-2-y', true],
    ['git add .ssh/id_rsa', 'feat/gh-2-y', true],
    ['git add github-token.txt', 'feat/gh-2-y', false],
    ['git add auth/token-refresh.ts lib/encryption.ts', 'feat/gh-2-y', false],
    ['git add -- .env', 'feat/gh-2-y', true],
    ['git commit -a .env -m x', 'feat/gh-2-y', true],
    ['git commit -m "x" .env', 'feat/gh-2-y', true],
    ['git commit -m "x" -- secrets/api.json', 'feat/gh-2-y', true],
    ['git add -A && git commit -m "x" -- .env', 'feat/gh-2-y', true],
    ['git add src/app.mjs', 'feat/gh-2-y', false],
    ['git add .', 'feat/gh-2-y', false],
    ['git add -A', 'feat/gh-2-y', false],
    ['git add src/tokenizer.ts lib/environment.mjs', 'feat/gh-2-y', false],
    ['git commit -m "rotate the deploy token in secrets/"', 'feat/gh-2-y', false],
    ['git commit -a -m "fix: read .env at boot"', 'feat/gh-2-y', false],
    ['git commit -F - <<\'MSG\'\nfeat: .env loader\nMSG', 'feat/gh-2-y', false],
    ['cat .env', 'feat/gh-2-y', false],
    ['git diff -- .env', 'feat/gh-2-y', false],
    ['git rm --cached .env', 'feat/gh-2-y', false],
    // 7. the co-author trailer.
    ['git commit -m "fix: y" -m "Co-Authored-By: Claude <n@a.com>"', 'feat/gh-2-y', true],
    ['git commit -F - <<\'MSG\'\nfix: y\n\nCo-Authored-By: Claude <n@a.com>\nMSG', 'feat/gh-2-y', true],
    ['rg -n Co-Authored-By docs', 'feat/gh-2-y', false],
    // heredoc body quoting a forbidden command must NOT trip the guard
    ['cat <<\'EOF\' > /tmp/x\ngh pr merge 42\nEOF', 'main', false],
    ['git commit -F - <<\'MSG\'\nfeat: x\nMSG', 'feat/gh-2-y', false],
    ["git commit -q -F - <<'EOF'\nmsg with `m` backticks\nEOF", 'feat/gh-1-x', false],
    ["git add -A && git commit -q -F - <<'EOF' && git log --oneline -1\nmsg `x` and $(pwd) literal\nEOF", 'feat/gh-1-x', false],
    // The heredoc tail: text after `<<EOF` on its line is command text, for
    // every rule (it hid `gh pr merge` before this fix).
    ['cat <<EOF && gh pr merge 5 --squash\nx\nEOF', 'feat/x', true],
    ["echo '<<EOF'\ngh pr merge 5 --squash\nEOF", 'feat/x', true],
    ['# <<EOF\ngh pr merge 5 --squash\nEOF', 'feat/x', true],
    ["echo x # it's\ngh pr merge 5 --squash", 'feat/x', true],
    // 0.50.0 guard-friction: special parameters and substitutions are reads.
    ['git status --short; echo "exit=$?"', 'feat/gh-1-x', false],
    ['kill $!', 'feat/gh-1-x', false],
    ['echo "pid $$ args $#"', 'feat/gh-1-x', false],
    ['sed -n "$(rg -n \'private function credentials(\' a.php | cut -d: -f1),+40p" a.php', 'feat/gh-1-x', false],
    ['echo "count: $(wc -l < a.txt)"', 'feat/gh-1-x', false],
    ['for f in docs/*.md; do wc -l "$f"; done', 'feat/gh-1-x', false],
    ['ls "$HOME/.claude"', 'feat/gh-1-x', false],
    ['echo "files: `ls | wc -l`"', 'feat/gh-1-x', false],
    ['git diff --stat $(git merge-base HEAD origin/main) -- src', 'feat/gh-1-x', false],
    ['git log --oneline "$(git merge-base HEAD origin/main)..HEAD"', 'feat/gh-1-x', false],
    ["echo '$?' $(git push origin HEAD:main)", 'feat/gh-1-x', true],
    ['echo $(git push origin HEAD:main)', 'feat/gh-1-x', true],
    ["awk '/^## Lessons/,0' docs/agentic/STATE.md", 'feat/gh-1-x', false],
    ['node --version', 'feat/gh-1-x', false],
    ['echo probe && gh auth status && node --version', 'feat/gh-1-x', false],
    // 0.69.0 review of the guard reduction: literal evasions of the kept
    // rules. H1: a commit or ref write through the GitHub API.
    ['gh api -X PUT repos/o/r/contents/README.md -f branch=main -f message=x -f content=eA==', 'feat/gh-1-x', true],
    ['gh api repos/o/r/contents/README.md -X DELETE -f sha=abc -f message=x', 'feat/gh-1-x', true],
    ["gh api graphql -f query='mutation{createCommitOnBranch(input:{branch:{repositoryNameWithOwner:\"o/r\",branchName:\"main\"}}){clientMutationId}}'", 'feat/gh-1-x', true],
    ["gh api graphql -f query='mutation{updateRef(input:{refId:\"x\",oid:\"y\",force:true}){clientMutationId}}'", 'feat/gh-1-x', true],
    ["gh api graphql -f query='mutation{updateRefs(input:{repositoryId:\"x\",refUpdates:[]}){clientMutationId}}'", 'feat/gh-1-x', true],
    ["gh api graphql -f query='mutation{createRef(input:{repositoryId:\"x\",name:\"refs/tags/v1\",oid:\"y\"}){clientMutationId}}'", 'feat/gh-1-x', true],
    ["gh api graphql -f query='mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}'", 'feat/gh-1-x', true],
    ['gh api repos/o/r/git/commits -X POST -f message=x -f tree=y', 'feat/gh-1-x', true],
    ['gh api repos/o/r/git/trees -X POST --input /tmp/tree.json', 'feat/gh-1-x', true],
    ['gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc', 'feat/gh-1-x', true],
    ['gh api repos/o/r/git/refs/heads/feat/gh-1-x -X DELETE', 'feat/gh-1-x', true],
    ['gh api repos/o/r/contents/README.md', 'feat/gh-1-x', false],
    ['gh api repos/o/r/git/refs/heads/main', 'feat/gh-1-x', false],
    ['gh api repos/o/r/git/trees/abc --jq .tree', 'feat/gh-1-x', false],
    ['gh api repos/o/r/git/commits/abc', 'feat/gh-1-x', false],
    // H5: a workflow run or dispatch runs an unmerged branch with the
    // repository's secrets.
    ['gh workflow run ci.yml', 'feat/gh-1-x', true],
    ['gh workflow run ci.yml --ref feat/gh-1-x -f x=1', 'feat/gh-1-x', true],
    ['gh workflow enable ci.yml', 'feat/gh-1-x', true],
    ['gh workflow list', 'feat/gh-1-x', false],
    ['gh workflow view ci.yml', 'feat/gh-1-x', false],
    ['gh api repos/o/r/actions/workflows/ci.yml/dispatches -f ref=feat/gh-1-x', 'feat/gh-1-x', true],
    ['gh api repos/o/r/actions/workflows/123/enable -X PUT', 'feat/gh-1-x', true],
    ['gh api repos/o/r/dispatches -f event_type=deploy', 'feat/gh-1-x', true],
    ['gh api repos/o/r/actions/workflows', 'feat/gh-1-x', false],
    ['gh api repos/o/r/actions/runs --jq .total_count', 'feat/gh-1-x', false],
    // H2: raw HTTP to the API. A write method, or a refused family, is
    // refused; a plain GET is a read.
    ['curl -X PUT https://api.github.com/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true],
    ['curl -XDELETE https://api.github.com/repos/o/r/git/refs/heads/main', 'feat/gh-1-x', true],
    ['curl --request POST -H "Authorization: token x" https://api.github.com/repos/o/r/dispatches', 'feat/gh-1-x', true],
    ["curl -d '{\"base\":\"main\"}' https://api.github.com/repos/o/r/merges", 'feat/gh-1-x', true],
    ['curl -X POST https://api.github.com/repos/o/r/issues/5/comments -d @body.json', 'feat/gh-1-x', true],
    ['curl -T README.md https://api.github.com/repos/o/r/contents/README.md', 'feat/gh-1-x', true],
    ['curl https://api.github.com/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true],
    ['wget --method=PUT -O- HTTPS://API.GITHUB.COM:443/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true],
    ['wget --post-data=x https://api.github.com/repos/o/r/merges', 'feat/gh-1-x', true],
    ['http PUT api.github.com/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true],
    ['xh PUT https://user:tok@api.github.com/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true],
    ['curl -s https://api.github.com/repos/o/r/pulls/4', 'feat/gh-1-x', false],
    ['curl -sI https://api.github.com/rate_limit', 'feat/gh-1-x', false],
    ['curl -H "Authorization: token x" https://api.github.com/repos/o/r/pulls/4/files', 'feat/gh-1-x', false],
    ['curl -X POST https://example.com/api/merge', 'feat/gh-1-x', false],
    ['curl -X POST https://api.github.example.com/repos/o/r/merges', 'feat/gh-1-x', false],
    ['http api.github.com/repos/o/r/pulls/4', 'feat/gh-1-x', false],
    // H3: a command-scoped git alias runs its value. A readable alias is
    // judged as the command it names; a hidden one is refused.
    ["git -c alias.m='push --force' m origin feat/gh-1-x", 'feat/gh-1-x', true],
    ["git -c alias.x='!gh pr merge 1' x", 'feat/gh-1-x', true],
    ['git -c alias.p=push p origin HEAD:main', 'feat/gh-1-x', true],
    ['git -calias.p=push p origin HEAD:main', 'feat/gh-1-x', true],
    ['git -c alias.st=status st', 'feat/gh-1-x', false],
    ['git -c alias.p=push p origin HEAD:refs/heads/feat/gh-1-x', 'feat/gh-1-x', false],
    ['git --config-env=alias.m=M m origin feat/gh-1-x', 'feat/gh-1-x', true],
    ['M="push --force"; git --config-env=alias.m=M m origin feat/gh-1-x', 'feat/gh-1-x', true],
    ['M=status; git --config-env=alias.m=M m', 'feat/gh-1-x', false],
    ['git -c alias.m="$CMD" m', 'feat/gh-1-x', true],
    ['git -c include.path=/tmp/aliases m', 'feat/gh-1-x', true],
    // H4: a gh alias, a function body, a case branch and a trap run text.
    ["gh alias set m 'pr merge' && gh m 1", 'feat/gh-1-x', true],
    ["gh alias set --shell m 'gh pr merge $1'", 'feat/gh-1-x', true],
    ["gh alias set co 'pr checkout'", 'feat/gh-1-x', false],
    ['f() { gh pr merge 1; }; f', 'feat/gh-1-x', true],
    ['f () { gh pr merge 1; }', 'feat/gh-1-x', true],
    ['function f { gh pr merge 1; }; f', 'feat/gh-1-x', true],
    ['function f() { git push origin HEAD:main; }', 'feat/gh-1-x', true],
    ['case x in x) gh pr merge 1;; esac', 'feat/gh-1-x', true],
    ['case "$1" in (merge|m) gh pr merge 1 ;; *) echo no ;; esac', 'feat/gh-1-x', true],
    ["trap 'gh pr merge 1' EXIT", 'feat/gh-1-x', true],
    ["trap -- 'git push origin HEAD:main' INT", 'feat/gh-1-x', true],
    ["trap 'rm -f /tmp/x' EXIT", 'feat/gh-1-x', false],
    ['f() { git status; }; f', 'feat/gh-1-x', false],
    // A shell fed by a heredoc, a here-string or a literal echo runs that text.
    ['bash <<EOF\ngh pr merge 4\nEOF', 'feat/gh-1-x', true],
    ["bash -s <<'EOF'\ngh pr merge 4\nEOF", 'feat/gh-1-x', true],
    ['sh <<EOF\ngit push origin HEAD:main\nEOF', 'feat/gh-1-x', true],
    ["sh <<< 'gh pr merge 1'", 'feat/gh-1-x', true],
    ['echo "gh pr merge 4" | sh', 'feat/gh-1-x', true],
    ["printf '%s\\n' 'gh pr merge 4' | bash", 'feat/gh-1-x', true],
    ['cat <<EOF | sh\ngh pr merge 4\nEOF', 'feat/gh-1-x', true],
    ['echo "gh pr view 4" | sh', 'feat/gh-1-x', false],
    ['cat script.sh | sh', 'feat/gh-1-x', false],
    ['cat <<EOF | sh\nls\nEOF', 'feat/gh-1-x', false],
    ['echo "gh pr merge 4" | tee /tmp/x', 'feat/gh-1-x', false],
    // Accepted by design (SPEC-guard-reduction, required behavior 2 and 3):
    // an inline interpreter's program is not shell, and is not judged; a
    // backslash-space joins one argv word, which gh rejects as a command.
    ["python3 -c \"import os; os.system('gh pr merge 1')\"", 'feat/gh-1-x', false],
    ["node -e \"require('child_process').execSync('gh pr merge 1')\"", 'feat/gh-1-x', false],
    ['gh pr\\ merge 4', 'feat/gh-1-x', false],
    // A wrapper's option value is not the command it runs.
    ['sudo -u dev gh pr merge 4', 'feat/gh-1-x', true],
    ['env -C /repo -u X gh pr merge 4', 'feat/gh-1-x', true],
    ['timeout -s KILL -k 5 30 gh pr merge 4', 'feat/gh-1-x', true],
    ['xargs -I {} -P 2 gh pr merge {}', 'feat/gh-1-x', true],
    ['ionice -c 2 -n 7 nice -n 10 gh pr merge 4', 'feat/gh-1-x', true],
    ['sudo -u dev git status', 'feat/gh-1-x', false],
    // A literal assignment earlier in the command names the command head.
    ['GH=gh; $GH pr merge 4', 'feat/gh-1-x', true],
    ['export G=git; $G push origin HEAD:main', 'feat/gh-1-x', true],
    ['GH=gh; ${GH} pr view 4', 'feat/gh-1-x', false],
    ['GH=gh $GH pr merge 4', 'feat/gh-1-x', false],
    // M6: every spelling of the API host normalises.
    ['gh api HTTPS://API.GITHUB.COM:443/repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api http://api.github.com/repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api https://user:tok@api.github.com/repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/pulls/42/merge?x=1#f -X PUT', 'feat/gh-2-y', true],
  ];
  let ok = true;
  for (const [cmd, branch, expect, baseBranch, extra] of cases) {
    const got = evaluate(cmd, branch, { baseBranch, ...(extra ?? {}) }).block;
    if (got !== expect) {
      console.error(`FAIL [expect block=${expect}, got ${got}]: ${cmd.split('\n')[0].slice(0, 100)}`);
      ok = false;
    }
  }
  // Every refusal must read as policy: a consistent guard identity prefix and
  // a closing sentence naming the sanctioned alternative, never an error dump.
  let messageChecks = 0;
  {
    messageChecks += 1;
    const asked = askUserQuestionProblem(true);
    const askCases =
      typeof asked === 'string'
      && asked.startsWith('autoloop guard — ')
      && asked.includes('unit.mjs --decide')
      && asked.includes('unit.mjs --block')
      && asked.includes('--close-run')
      && asked.trimEnd().endsWith('.')
      && askUserQuestionProblem(false) === null;
    if (!askCases) {
      console.error('FAIL [no synchronous question mid-run]');
      ok = false;
    }
  }
  {
    const reasons = cases
      .filter(([, , expect]) => expect)
      .map(([cmd, branch, , baseBranch]) => [cmd, evaluate(cmd, branch, { baseBranch }).reason ?? '']);
    messageChecks += 1;
    for (const [cmd, reason] of reasons) {
      if (!reason.startsWith('autoloop guard — ') || !reason.trimEnd().endsWith('.')) {
        console.error(`FAIL [block reason is not policy-shaped]: ${cmd.split('\n')[0]}`);
        ok = false;
      }
    }
    // SPEC-guard-reduction: each refusal names its rule and one allowed form.
    messageChecks += 1;
    for (const [cmd, reason] of reasons) {
      if (!/^autoloop guard — no [A-Za-z -]+:/u.test(reason) || !/Allowed: `[^`]+`/u.test(reason)) {
        console.error(`FAIL [a refusal names its rule and one allowed form]: ${cmd.split('\n')[0]}`);
        ok = false;
      }
    }
    // LFE #506: no refusal recommends a work-size measurement.
    messageChecks += 1;
    if ([...reasons.map(([, reason]) => reason), askUserQuestionProblem(true)].some((reason) =>
      /--shortstat|wc -l|insert\/delete|production-line|To measure|\d+ (?:bytes|lines|KB)/u.test(reason))) {
      console.error('FAIL [no refusal remedy recommends a work-size measurement]');
      ok = false;
    }
  }
  {
    // 6. the secret-path families, and the words a message or option hides.
    messageChecks += 1;
    const secretCases = [
      ['.env', true], ['.env.local', true], ['a/b/.env.production', true], ['.environment', true],
      ['environment.ts', false], ['lib/env.mjs', false],
      ['server.pem', true], ['x/id.key', true], ['store.p12', true], ['cert.pfx', true], ['app.jks', true], ['java.keystore', true],
      ['keys/deploy', true], ['x/keys/a', true], ['keys', true], ['monkeys/a', false], ['hotkeys.json', false],
      ['secrets/a.json', true], ['secret.txt', true], ['config/credentials.yml', true], ['token.json', true],
      ['tokens/x', true], ['certs/server.crt', true], ['.ssh/id_rsa', true], ['docs/secrets.md', true],
      // 0.69.0 review: a segment that IS the word, not a name that contains it.
      ['src/tokenizer.ts', false], ['auth/token-refresh.ts', false], ['lib/encryption.ts', false],
      ['secretary.md', false], ['credentialing.md', false], ['credential-store/x', false], ['github_token', false],
      ['api-tokens.md', false], ['tokens-doc/readme.md', false],
    ];
    const wrongFamily = secretCases.filter(([path, expected]) => isSecretPath(path) !== expected);
    const staged = [
      ['git add .env', ['.env']],
      ['git add src/a.mjs .env.local', ['.env.local']],
      ['git commit -m "touch .env" src/a.mjs', []],
      ['git commit -m secrets/x src/a.mjs', []],
      ['git commit --author "token <t@x>" -- .env', ['.env']],
      ['git add -p .env', ['.env']],
      ['git add --chmod=+x .env', ['.env']],
      ['git add --pathspec-from-file .env', []],
      ['git rm .env', []],
      ['git status .env', []],
    ];
    const wrongStaging = staged.filter(([command, expected]) =>
      JSON.stringify(stagedSecretPaths(shellWords(command))) !== JSON.stringify(expected));
    if (wrongFamily.length > 0 || wrongStaging.length > 0) {
      console.error(`FAIL [a secret path is told apart from source, in git add and git commit]: ${JSON.stringify([wrongFamily, wrongStaging])}`);
      ok = false;
    }
  }
  const corpusResult = replayCorpus();
  corpusCount = corpusResult.total;
  if (corpusResult.failures.length > 0) {
    ok = false;
    for (const line of corpusResult.failures) console.error(line);
  }

  // From the plugin the guard takes its repository root, never a STATE path
  // whose parent it would have to guess (`.autoloop/STATE.md` two levels up
  // is the repository's parent).
  const argCases = [
    ['no arguments: the hook root', [], undefined],
    ['explicit root', ['--root', '/repo'], '/repo'],
    ['missing root value', ['--root'], null],
    ['a STATE path is no longer accepted', ['--config', '/repo/docs/agentic/STATE.md'], null],
    ['legacy base injection rejected', ['--base', 'main'], null],
  ];
  for (const [name, args, expectedRoot] of argCases) {
    const parsed = parseArgs(args);
    const passed = expectedRoot === null
      ? parsed.error !== null
      : parsed.error === null && parsed.root === expectedRoot;
    if (!passed) {
      console.error(`FAIL [${name}]`);
      ok = false;
    }
  }
  // Plugin hooks fire in every session: the guard stands down for a session
  // that owns no run, whatever the repository holds, while for the owner an
  // unreadable payload is still refused.
  {
    const scratch = mkdtempSync(join(tmpdir(), 'guard-gate-'));
    // The latch prime writes for the owning session, in a fixture HOME: only
    // the conversation it names ('S') is guarded.
    const owner = sessionOwnerPid(process.pid);
    const ownedHome = (home, fields = {}) => {
      rmSync(join(home, '.claude', 'autoloop', 'run-latches'), { recursive: true, force: true });
      mkdirSync(join(home, '.claude', 'autoloop', 'run-latches'), { recursive: true });
      writeFileSync(join(home, '.claude', 'autoloop', 'run-latches', `${owner}.json`), JSON.stringify({
        version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', sessionId: 'S', ...fields,
      }));
      return home;
    };
    const ownedEnv = (fields) => {
      const env = isolatedEnv();
      ownedHome(env.HOME, fields);
      return env;
    };
    const bashInput = (command, cwd) => JSON.stringify({ session_id: 'S', tool_name: 'Bash', ...(cwd ? { cwd } : {}), tool_input: { command } });
    try {
      const hook = (root, env = isolatedEnv()) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: 'not json', encoding: 'utf8', cwd: scratch, timeout: 30000,
        env: { ...env, CLAUDE_PROJECT_DIR: root },
      }).status;
      const unrelated = hook(scratch);
      mkdirSync(join(scratch, '.autoloop'));
      writeFileSync(join(scratch, '.autoloop', 'config.json'),
        JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' } }));
      const unowned = hook(scratch);
      const active = hook(scratch, ownedEnv());
      if (!(unrelated === 0 && unowned === 0 && active === 2)) {
        console.error(`FAIL [the guard stands down for a session that owns no run and acts for the owner]: ${unrelated} ${unowned} ${active}`);
        ok = false;
      }
      // Security review of the cutover: once a run is open the guard never
      // stands down. Deleting the config (or checking out a branch forked
      // before devendor) leaves the run's own marker, and its base, in charge.
      execFileSync('git', ['init', '-q', scratch]);
      const markers = runMarkerDirectory(scratch);
      mkdirSync(markers, { recursive: true });
      writeFileSync(join(markers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now(), baseBranch: 'main' }));
      rmSync(join(scratch, '.autoloop'), { recursive: true, force: true });
      const merge = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput('gh pr merge 5 --squash'),
        encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...ownedEnv(), CLAUDE_PROJECT_DIR: scratch },
      });
      if (merge.status !== 2 || !merge.stderr.includes('autoloop guard')) {
        console.error(`FAIL [an open run keeps the guard on after its config is removed]: ${merge.status} ${merge.stderr}`);
        ok = false;
      }
      // SPEC-guard-reduction: an ordinary command is never refused in the
      // owning session. Fifty read, test, inspection and loop commands, the
      // former triggers of the removed rules among them, each through the
      // hook as the host sends it, on a unit branch.
      execFileSync('git', ['-C', scratch, 'switch', '-q', '-c', 'feat/gh-1-x']);
      execFileSync('git', ['-C', scratch, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
      const ordinary = [
        'ls', 'ls -la tools', 'cat README.md', 'sed -n 1,40p tools/prime.mjs', 'head -20 CHANGELOG.md',
        'tail -5 /tmp/log', 'wc -l tools/*.mjs', 'rg -n TODO tools', "rg -n 'import\\s+(os|sys)' tools/",
        'grep node file', 'grep -rn "gh pr" docs', 'find . -name "*.mjs"', "find . -name '*.mjs' -exec grep -l foo {} +",
        'for f in a b; do echo $f; done', 'for n in 1 2 3; do gh issue view $n --json title; done',
        'command -v node', 'which gh', 'echo $?', 'node x.mjs; echo "exit=$?"', 'x=1; echo $x',
        'D=docs; rg -n autoloop $D/specs', 'eval echo hi', "python3 -c 'print(1)'", "python3 -c 'import json; print(1)'",
        "node -e 'console.log(1)'", "bash -c 'ls'", "zsh -ic 'alias | grep x'", 'cat <<EOF\nx\nEOF',
        "git commit -q -F - <<'EOF'\nmsg with `m` backticks\nEOF", 'git log --oneline | head', 'git status', 'git diff',
        'git diff --stat $(git merge-base HEAD origin/main) -- src', 'git switch -c feat/x', 'git commit -m "x"',
        'git push --force-with-lease origin feat/gh-1-x', 'git push origin feat/gh-1-x', 'git foo-unknown-subcommand', 'gh foo',
        'gh pr comment 1 --body "x"', 'gh pr create --title t --body "inline"', 'gh pr ready 1', 'gh pr ready 1 --undo',
        'gh issue edit 1 --add-label loop-ready', 'gh issue edit 1 --remove-label loop-halt',
        'gh issue edit 1 --add-label loop:02-plan --remove-label loop:03-plan-review', 'gh issue edit 1 --add-label loop:03-plan-review',
        'gh issue comment 1 --body "/answer yes"', 'node --test', 'npm test', 'ls -d /x/*/ | xargs -n1 basename',
        "awk '{ print | \"sh\" }' f", 'diff <(cat a) <(cat b)', 'ls $UNSET_PATH/x', `echo ${'x'.repeat(70 * 1024)}`,
        'node tools/dispatch.mjs --role plan --prompt-file /tmp/p.md --json',
      ];
      const ordinaryEnv = { ...ownedEnv(), CLAUDE_PROJECT_DIR: scratch };
      const refusedOrdinary = ordinary.filter((command) => {
        const background = command.includes('dispatch.mjs');
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
          input: JSON.stringify({ session_id: 'S', tool_name: 'Bash', cwd: scratch, tool_input: { command, ...(background ? { run_in_background: true } : {}) } }),
          encoding: 'utf8', cwd: scratch, timeout: 30000, env: ordinaryEnv,
        });
        return result.status !== 0;
      });
      if (ordinary.length < 50 || refusedOrdinary.length > 0) {
        console.error(`FAIL [an ordinary command is never refused in the owning session]: ${refusedOrdinary.length}/${ordinary.length} refused: ${JSON.stringify(refusedOrdinary.map((command) => command.split('\n')[0].slice(0, 60)))}`);
        ok = false;
      }
      // Security re-audit: a legacy install's own prime writes markers with no
      // baseBranch into the same directory. That is the vendored guard's run,
      // never the plugin's: the plugin guard stands down, it does not lock the
      // repository out.
      writeFileSync(join(markers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now() }));
      const legacyRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
        encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...isolatedEnv(), CLAUDE_PROJECT_DIR: scratch },
      });
      if (legacyRun.status !== 0) {
        console.error(`FAIL [a vendored-era marker never makes the plugin guard refuse]: ${legacyRun.status} ${legacyRun.stderr}`);
        ok = false;
      }
      writeFileSync(join(markers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now(), baseBranch: 'main' }));
      // An unreadable config mid-run falls back to the run's own base rather
      // than refusing every command.
      mkdirSync(join(scratch, '.autoloop'));
      writeFileSync(join(scratch, '.autoloop', 'config.json'), '{ typo');
      const typo = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput('git status'),
        encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...ownedEnv(), CLAUDE_PROJECT_DIR: scratch },
      });
      rmSync(join(scratch, '.autoloop'), { recursive: true, force: true });
      if (typo.status !== 0) {
        console.error(`FAIL [a config typo mid-run falls back to the run's base]: ${typo.status} ${typo.stderr}`);
        ok = false;
      }
      // Every hook (reminders, transcripts, the preflight) acts where the guard
      // does: the owning session keeps the project guarded on a checkout
      // without config, and a session with only a marker in its ancestry is
      // not the owner.
      const rootFor = (env) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'hook-root.mjs'), '--guarded-root'], {
        input: '{"session_id":"S"}', encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...env, CLAUDE_PROJECT_DIR: scratch },
      });
      const guarded = rootFor(ownedEnv());
      const markerOnly = rootFor(isolatedEnv());
      if (guarded.status !== 0 || guarded.stdout.trim() !== realpathSync(scratch) || markerOnly.status !== 1) {
        console.error(`FAIL [the owning session keeps every hook acting; a marker alone does not]: ${guarded.status} ${guarded.stdout} ${markerOnly.status}`);
        ok = false;
      }
      // Security re-audit (M1): opening a run in a repository other than the
      // session's project would leave its hooks guarding the wrong one. The
      // guard (which, unlike Bash, sees CLAUDE_PROJECT_DIR) refuses it —
      // comparing common git dirs, so a linked worktree of the project passes.
      const other = mkdtempSync(join(tmpdir(), 'guard-other-'));
      execFileSync('git', ['init', '-q', other]);
      const primeFrom = (cwd, command) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
        encoding: 'utf8', cwd, timeout: 30000, env: { ...isolatedEnv(), CLAUDE_PROJECT_DIR: other },
      });
      const prime = join(dirname(fileURLToPath(import.meta.url)), 'prime.mjs');
      const refused = (cwd, command) => primeFrom(cwd, command).status === 2;
      // Security re-audit round 4: every shape that runs the plugin's prime
      // somewhere else is refused, and nothing that merely mentions a
      // prime.mjs (or runs another one) is.
      const evasions = [
        [scratch, `node ${prime} --json`],
        [other, `cd ${scratch} && node ${prime} --json`],
        [other, `cd ${scratch}; node ${prime} --json`],
        [other, `(cd ${scratch} && node ${prime} --json)`],
        [other, `cd . && cd ${scratch} && node ${prime} --json`],
        [other, `pushd ${scratch} && node ${prime} --json`],
        [other, `env -C ${scratch} node ${prime} --json`],
        [scratch, `node ${prime} --json # --close-run`],
        [scratch, `node ${dirname(prime)}/"pri""me.mjs" --json`],
      ].filter(([cwd, command]) => !refused(cwd, command));
      mkdirSync(join(other, 'scripts'));
      writeFileSync(join(other, 'scripts', 'prime.mjs'), '');
      const falsePositives = [
        [other, `cd ${scratch} && rg -n foo templates/tools/prime.mjs`],
        [other, `cd ${scratch} && git log --oneline -- templates/tools/prime.mjs`],
        [scratch, 'node scripts/prime.mjs'],
        [other, `node ${prime} --json`],
        [scratch, `node ${prime} --close-run`],
      ].filter(([cwd, command]) => refused(cwd, command));
      if (evasions.length + falsePositives.length > 0) {
        console.error(`FAIL [prime never opens a run outside the session's project, and only prime is judged] `
          + `evaded: ${JSON.stringify(evasions.map(([, c]) => c))}; `
          + `false positives: ${JSON.stringify(falsePositives.map(([, c]) => c))}`);
        ok = false;
      }
      // Security re-audit round 5: the check runs on any command naming node,
      // in every repository, so it must stay linear — a padded command that
      // outran the hook timeout would skip every rule.
      const padded = ['gh pr merge 5 # node' + ' '.repeat(300_000) + 'x', 'node x' + ' )'.repeat(100_000) + 'y'];
      const startedAt = Date.now();
      for (const command of padded) foreignPrimeProblem(command, scratch, other);
      const elapsed = Date.now() - startedAt;
      if (elapsed > 1000) {
        console.error(`FAIL [the foreign-prime check stays linear on padded input]: ${elapsed} ms`);
        ok = false;
      }
      // Audit after 0.60.0: every prime segment spawned git twice, so a few
      // thousand of them outran the host's 15 s timeout, which lets the
      // command run. Common dirs resolve once each; too many distinct targets,
      // or a spent budget, refuses.
      const primes = Array(5000).fill(`node ${prime} --json`).join('; ');
      const primesAt = Date.now();
      const primesVerdict = foreignPrimeProblem(primes, scratch, scratch);
      const primesElapsed = Date.now() - primesAt;
      const targets = Array.from({ length: 65 }, (_, index) => {
        mkdirSync(join(scratch, 'targets', String(index)), { recursive: true });
        return `cd ${join(scratch, 'targets', String(index))} && node ${prime} --json`;
      }).join('; ');
      const budgetVerdicts = [
        primesVerdict === null && primesElapsed < 2000,
        foreignPrimeProblem(targets, scratch, scratch)?.includes('time budget') === true,
        foreignPrimeProblem(`node ${prime} --json`, scratch, scratch, undefined, Date.now() - 1)?.includes('time budget') === true,
      ];
      rmSync(join(scratch, 'targets'), { recursive: true, force: true });
      if (budgetVerdicts.includes(false)) {
        console.error(`FAIL [the foreign-prime check fits the hook budget or refuses]: ${JSON.stringify(budgetVerdicts)} ${primesElapsed} ms`);
        ok = false;
      }
      rmSync(other, { recursive: true, force: true });
      // A session that primed twice holds two plugin markers: every base is
      // enforced (a forged marker can only add one), oldest first whatever the
      // directory order.
      const basesOf = (first, second) => {
        writeFileSync(join(markers, 'm1.json'), JSON.stringify({ version: 1, pids: [process.ppid], ...first }));
        writeFileSync(join(markers, 'm2.json'), JSON.stringify({ version: 1, pids: [process.ppid], ...second }));
        const bases = [...new Set(pluginRunMarkers([scratch, scratch]).map(({ marker }) => marker.baseBranch))];
        rmSync(join(markers, 'm1.json'));
        rmSync(join(markers, 'm2.json'));
        return JSON.stringify(bases);
      };
      const older = { openedAtMs: 1, baseBranch: 'old' };
      const newer = { openedAtMs: 2, baseBranch: 'new' };
      if (basesOf(older, newer) !== '["old","new"]' || basesOf(newer, older) !== '["old","new"]') {
        console.error(`FAIL [every plugin marker's base is enforced, oldest first]: ${basesOf(older, newer)}`);
        ok = false;
      }
      // The hook's cwd is not the only place to look: the project root's run counts.
      const fromTmp = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput('gh pr merge 5 --squash'),
        encoding: 'utf8', cwd: tmpdir(), timeout: 30000, env: { ...ownedEnv(), CLAUDE_PROJECT_DIR: scratch },
      });
      if (fromTmp.status !== 2) {
        console.error(`FAIL [a hook whose cwd is outside the repository still sees the project's run]: ${fromTmp.status}`);
        ok = false;
      }
      // Review of the cutover (I7): markers live in the common git dir, so a
      // command issued from a linked worktree of the repository sees the run.
      execFileSync('git', ['-C', scratch, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
      const linked = join(scratch, '..', `${basename(scratch)}-linked`);
      execFileSync('git', ['-C', scratch, 'worktree', 'add', '-q', '--detach', linked]);
      const fromLinked = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput('gh pr merge 5 --squash'),
        encoding: 'utf8', cwd: linked, timeout: 30000, env: { ...ownedEnv(), CLAUDE_PROJECT_DIR: linked },
      });
      rmSync(linked, { recursive: true, force: true });
      if (fromLinked.status !== 2) {
        console.error('FAIL [a linked worktree sees the repository\'s open run]');
        ok = false;
      }
      // Security audit after 0.60.0: the markers were the guard's only record
      // of an open run, and the run could delete or forge them. The run's own
      // state is refused to it, the session latch outside the repository
      // outlives its markers, and every base any record names is enforced.
      const home = ownedHome(join(scratch, 'home'));
      const latches = join(home, '.claude', 'autoloop', 'run-latches');
      const latchHook = (command) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput(command, scratch),
        encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...isolatedEnv(), HOME: home, CLAUDE_PROJECT_DIR: scratch },
      });
      const stateCommands = ['rm -rf .git/autoloop/run', `rm -rf ${latches}`, 'rm -rf .git', 'echo {} > .git/autoloop/run/f.json',
        'echo $(rm -rf .git/autoloop/run)', 'echo `rm -rf .git`', 'D=.git/autoloop; rm -rf $D'];
      const stateVerdicts = stateCommands.map((command) => latchHook(command).status);
      const readVerdict = latchHook(`cat ${join(markers, 'run.json')}`).status;
      rmSync(join(markers, 'run.json'));
      const afterDelete = latchHook('gh pr merge 5 --squash').status;
      const [latchFile] = readdirSync(latches).filter((name) => name.endsWith('.json'));
      const latchText = readFileSync(join(latches, latchFile), 'utf8');
      writeFileSync(join(latches, latchFile), '{ corrupt');
      const corrupt = latchHook('ls');
      writeFileSync(join(latches, latchFile), latchText);
      if (stateVerdicts.some((status) => status !== 2) || readVerdict !== 0
        || afterDelete !== 2 || corrupt.status !== 2 || !corrupt.stderr.includes('latch')) {
        console.error(`FAIL [the run's own state is refused to it, and the session latch outlives its markers]: `
          + `${JSON.stringify({ stateVerdicts, readVerdict, afterDelete, corrupt: corrupt.status })}`);
        ok = false;
      }
      // Security review H1: a run closed its latch with --close-run and the
      // guard stood down for the rest of the session, so it could merge. A
      // closed latch keeps this session guarded until /clear or exit.
      const sessionHook = (command, session, payload = { session_id: session }) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: JSON.stringify({ ...payload, tool_name: 'Bash', cwd: scratch, tool_input: { command } }),
        encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...isolatedEnv(), HOME: home, CLAUDE_PROJECT_DIR: scratch },
      });
      const escapes = ['gh pr merge 42 --squash', 'rm -rf .git/autoloop/run'];
      writeFileSync(join(latches, latchFile), JSON.stringify({ ...JSON.parse(latchText), closedAt: '2026-10-12T00:00:00.000Z' }));
      const afterClose = escapes.map((command) => sessionHook(command, 'S').status);
      const afterClear = escapes.map((command) => sessionHook(command, 'S-after-clear').status);
      // Review L3: a payload that names no session, beside a latch of this
      // process (open, or closed), is refused like an unreadable one.
      const noSessionClosed = [{}, { session_id: '' }, { session_id: 7 }].map((payload) => sessionHook('gh pr merge 42 --squash', null, payload).status);
      writeFileSync(join(latches, latchFile), latchText);
      const noSessionOpen = sessionHook('gh pr merge 42 --squash', null, {});
      if (JSON.stringify(afterClose) !== '[2,2]' || JSON.stringify(afterClear) !== '[0,0]'
        || JSON.stringify(noSessionClosed) !== '[2,2,2]' || noSessionOpen.status !== 2 || !noSessionOpen.stderr.includes('names no session')) {
        console.error(`FAIL [a closed run keeps the guard for its own session until /clear, and a payload naming no session is refused beside a latch]: ${JSON.stringify({ afterClose, afterClear, noSessionClosed, noSessionOpen: noSessionOpen.status })}`);
        ok = false;
      }
      // Security review H2: prime took its session id from the environment,
      // which the command can change. The guard hands it the hook input's.
      {
        const primeHome = join(scratch, 'prime-home');
        const hostFile = join(primeHome, '.claude', 'autoloop', 'run-latches', `${owner}.session`);
        const primeTool = join(dirname(fileURLToPath(import.meta.url)), 'prime.mjs');
        const primeHook = (payload, command = `node ${primeTool} --json`) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
          input: JSON.stringify({ ...payload, tool_name: 'Bash', cwd: scratch, tool_input: { command } }),
          encoding: 'utf8', cwd: scratch, timeout: 30000, env: { ...isolatedEnv(), HOME: primeHome, CLAUDE_PROJECT_DIR: scratch, CLAUDE_CODE_SESSION_ID: 'from-env' },
        });
        const hostOf = () => {
          try {
            return JSON.parse(readFileSync(hostFile, 'utf8')).sessionId;
          } catch {
            return null;
          }
        };
        const handed = primeHook({ session_id: 'S-host' });
        const recorded = hostOf();
        const hostMode = statSync(hostFile).mode & 0o777;
        const refusedCompound = primeHook({ session_id: 'S-other' }, `node ${primeTool} --json && rm -rf .git/autoloop/run`);
        const afterRefusal = hostOf();
        const unnamed = primeHook({});
        if (handed.status !== 0 || recorded !== 'S-host' || hostMode !== 0o600
          || refusedCompound.status !== 2 || afterRefusal !== 'S-host' || unnamed.status !== 0 || hostOf() !== null) {
          console.error(`FAIL [the guard hands prime the hook input's session id, never the environment's]: ${JSON.stringify({ handed: handed.status, recorded, afterRefusal, unnamed: unnamed.status, left: hostOf() })}`);
          ok = false;
        }
        // Latches of exited sessions are pruned on a prime command (the one
        // file work a session that owns no run permits), never on another.
        const deadPid = spawnSync(process.execPath, ['-e', '0'], { timeout: 10000 }).pid;
        const deadLatch = join(dirname(hostFile), `${deadPid}.json`);
        writeFileSync(deadLatch, JSON.stringify({ version: 2, owner: deadPid, ownerStart: null, baseBranch: 'main' }));
        primeHook({ session_id: 'S-host' }, 'ls');
        const keptOnOrdinary = existsSync(deadLatch);
        primeHook({ session_id: 'S-host' });
        if (!keptOnOrdinary || existsSync(deadLatch)) {
          console.error(`FAIL [a prime command prunes the latches of exited sessions; no other command does]: ${keptOnOrdinary} ${existsSync(deadLatch)}`);
          ok = false;
        }
      }
      // Review L1: a guard that throws decides by ownership, not by the
      // shell fallback alone: refuse for this session's run, allow otherwise.
      {
        const crashDir = join(scratch, 'crash-latches');
        mkdirSync(crashDir, { recursive: true });
        const verdict = (sessionId) => crashExitCode(sessionId, { directory: crashDir });
        const none = verdict('S');
        writeFileSync(join(crashDir, `${owner}.json`), JSON.stringify({ version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', sessionId: 'S' }));
        const open = [verdict('S'), verdict('T'), verdict(undefined)];
        writeFileSync(join(crashDir, `${owner}.json`), JSON.stringify({ version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', sessionId: 'S', closedAt: 'x' }));
        const closed = [verdict('S'), verdict('T')];
        writeFileSync(join(crashDir, `${owner}.json`), '{ corrupt');
        const corrupt = verdict('S');
        if (JSON.stringify([none, ...open, ...closed, corrupt]) !== '[0,2,0,2,2,0,2]') {
          console.error(`FAIL [a crashed guard refuses only for the session that owns a run, closed too]: ${JSON.stringify([none, ...open, ...closed, corrupt])}`);
          ok = false;
        }
      }
      // The run-state rule through the guard's own tokenizer: its fixtures,
      // plus the shapes only a real tokenizer produces — quoted messages that
      // mention a deletion run nothing; ANSI-C quotes, substitutions (quoted
      // or not) and backquotes are taken apart.
      const judgedAt = (command) => runStateProblem(guardSegments(command), {
        cwd: '/r', protectedDirs: ['/r/.git/autoloop/run', '/home/u/.claude/autoloop/run-latches'], codeDirs: ['/p/tools'], home: '/home/u', env: {},
      });
      const tokenized = [
        ...TAMPERING.filter((command) => judgedAt(command) === null).map((command) => `evaded: ${command}`),
        ...ORDINARY.filter((command) => judgedAt(command) !== null).map((command) => `refused: ${command}`),
        ...[
          "rm -rf $'\\x2egit'/autoloop",
          'echo $(rm -rf .git/autoloop/run)',
          'echo "$(rm -rf .git/autoloop/run)"',
          'echo `rm -rf .git`',
          'rm -rf "$(git rev-parse --git-common-dir)/autoloop"',
          'rm -rf $(git rev-parse --git-common-dir)/autoloop',
          'D=.git; rm -rf "$D"/autoloop',
          `echo ${'$(true) '.repeat(70)}`,
          'echo x>.git/autoloop/run/a.json',
          "echo x # it's\nrm -rf .git/autoloop/run",
          'cat <<<EOF\nrm -rf .git/autoloop/run\nEOF',
          "alias ls='rm -rf .git/autoloop/run'\nls",
          "cat /tmp/fake.json > \"$(echo /home/u/.claude/autoloop/run-latches/1.json)\"",
          'cat /tmp/forged>>.git/autoloop/run/1.json',
          'cat <<EOF && rm -rf .git/autoloop/run\nx\nEOF',
          'cat <<EOF\n$(rm -rf .git/autoloop/run)\nEOF',
          "eval 'rm -rf .git/autoloop/run'",
          "bash -c 'rm -rf .git/autoloop/run'",
        ].filter((command) => judgedAt(command) === null).map((command) => `evaded: ${command}`),
        ...[
          "git commit -m 'guard: refuse `rm -rf .git/autoloop/run` mid-run'",
          "git commit -m 'refuses $(rm -rf .git) shapes'",
          "echo '$(rm -rf .git)'",
          "cat <<'EOF'\n$(rm -rf .git/autoloop/run)\nEOF",
          'npm test 2>&1 | tail -5',
          "git commit -m 'a>b'",
          'J=$(mktemp) && curl -c $J x && rm -f $J',
          'for r in a b; do rm -rf /tmp/s/$r-clone; done',
          'D=/tmp/perm-probe-$$; mkdir -p $D && rm -rf $D',
          'export W=/tmp/s/stage; rm -rf "$W"',
        ].filter((command) => judgedAt(command) !== null).map((command) => `refused: ${command}`),
      ];
      // The heredoc tail: text after `<<EOF` on its line is command text, for
      // every rule (it hid `gh pr merge` before this fix).
      for (const shape of [
        'cat <<EOF && gh pr merge 5 --squash\nx\nEOF',
        "echo '<<EOF'\ngh pr merge 5 --squash\nEOF",
        '# <<EOF\ngh pr merge 5 --squash\nEOF',
        "echo x # it's\ngh pr merge 5 --squash",
      ]) {
        if (!evaluate(shape, 'feat/x', { baseBranch: 'main' }).block) tokenized.push(`evaded (evaluate): ${shape}`);
      }
      if (tokenized.length > 0) {
        console.error(`FAIL [the run-state rule holds through the guard's tokenizer]: ${JSON.stringify(tokenized)}`);
        ok = false;
      }
      // A command that runs prime and deletes the marker it just wrote is
      // refused in any session (hook-root.mjs covers one that owns no run);
      // so is a git that stalls (a FIFO for .git/config) under the owner,
      // within the budget instead of past the host's timeout.
      mkdirSync(join(scratch, '.autoloop'), { recursive: true });
      writeFileSync(join(scratch, '.autoloop', 'config.json'), JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' } }));
      rmSync(join(markers, 'run.json'), { force: true });
      const primeAndDelete = latchHook(`node ${join(dirname(fileURLToPath(import.meta.url)), 'prime.mjs')} --json && rm -rf .git/autoloop/run`, 'session-p');
      // Refused by the run-opening rule alone (the script's text is not visible).
      const primeAndScript = latchHook(`node ${join(dirname(fileURLToPath(import.meta.url)), 'prime.mjs')} --json && sh /tmp/x.sh`);
      const stalled = join(scratch, 'stalled');
      execFileSync('git', ['init', '-q', stalled]);
      rmSync(join(stalled, '.git', 'config'));
      spawnSync('mkfifo', [join(stalled, '.git', 'config')]);
      const stalledAt = Date.now();
      const stalledHook = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput('ls', stalled),
        encoding: 'utf8', cwd: stalled, timeout: 15000,
        env: { ...isolatedEnv(), HOME: home, CLAUDE_PROJECT_DIR: stalled, AUTOLOOP_GUARD_BUDGET_MS: '3000' },
      });
      const stalledElapsed = Date.now() - stalledAt;
      rmSync(stalled, { recursive: true, force: true });
      writeFileSync(join(markers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now(), baseBranch: 'main' }));
      rmSync(join(scratch, '.autoloop'), { recursive: true, force: true });
      if (primeAndDelete.status !== 2 || primeAndScript.status !== 2 || !primeAndScript.stderr.includes('opens a run')
        || stalledHook.status !== 2 || stalledElapsed > 8000
        || !stalledHook.stderr.includes('git')) {
        console.error(`FAIL [prime-then-delete and a stalled git both refuse]: ${JSON.stringify({
          primeAndDelete: primeAndDelete.status, primeAndScript: primeAndScript.status, stalled: stalledHook.status, stalledElapsed, stalledErr: stalledHook.stderr.slice(0, 120),
        })}`);
        ok = false;
      }
      // A session whose project directory is not itself a git repository,
      // with the run in a repository inside it: the run's own repository is
      // what git must read (a review found every command refused here).
      const work = join(scratch, 'work');
      const inner = join(work, 'repo');
      mkdirSync(inner, { recursive: true });
      execFileSync('git', ['init', '-q', inner]);
      const innerMarkers = runMarkerDirectory(inner);
      mkdirSync(innerMarkers, { recursive: true });
      writeFileSync(join(innerMarkers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now(), baseBranch: 'main' }));
      const workHome = ownedHome(join(scratch, 'work-home'), { scope: inner });
      const fromWork = (command) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: bashInput(command, inner),
        encoding: 'utf8', cwd: inner, timeout: 30000, env: { ...process.env, HOME: workHome, CLAUDE_PROJECT_DIR: work },
      });
      const workLs = fromWork('ls');
      const workMerge = fromWork('gh pr merge 5 --squash');
      if (workLs.status !== 0 || workMerge.status !== 2) {
        console.error(`FAIL [a run in a repository under a non-git project directory is guarded, not locked]: ${workLs.status} ${workLs.stderr.slice(0, 160)} ${workMerge.status}`);
        ok = false;
      }
      // A branch switch waits for a reviewer reading the checkout; file
      // checkouts and other git commands do not.
      if (!(switchesCheckout(shellWords('git switch feat/x')) && switchesCheckout(shellWords('git checkout -q main'))
        && !switchesCheckout(shellWords('git checkout -- src/a.ts')) && !switchesCheckout(shellWords('git checkout HEAD -- a'))
        && !switchesCheckout(shellWords('git status')) && !switchesCheckout(shellWords('echo git switch'))
        && switchesCheckout(shellWords('git -C /r switch x')) && switchesCheckout(shellWords('git checkout -b new origin/x'))
        // A branch made at HEAD, or help, changes no file (review of the no-run rule).
        && !switchesCheckout(shellWords('git switch -c feat')) && !switchesCheckout(shellWords('git checkout -b feat'))
        && !switchesCheckout(shellWords('git switch --help')) && switchesCheckout(shellWords('git switch -c feat origin/main')))) {
        console.error('FAIL [a branch switch is told apart from a file checkout]');
        ok = false;
      }
      // SPEC-model-config: the loop never changes its own step models; the
      // operator's global model config is protected while a run is open.
      {
        const open = protectedPaths({ projectRoot: '/r', runOpen: true, home: '/h' }).state;
        const closed = protectedPaths({ projectRoot: '/r', runOpen: false, home: '/h' }).state;
        // Where the resolver reads it: CLAUDE_CONFIG_DIR when set (review).
        const relocated = protectedPaths({ projectRoot: '/r', runOpen: true, home: '/h', configDir: '/c' }).state;
        // The table a run pinned for its dispatches is run state, always.
        const pinRepo = mkdtempSync(join(tmpdir(), 'guard-pin-'));
        execFileSync('git', ['init', '-q', pinRepo]);
        const pin = pinnedModelsPath(pinRepo);
        const pinned = protectedPaths({ projectRoot: pinRepo, runOpen: false, home: '/h' }).state;
        rmSync(pinRepo, { recursive: true, force: true });
        if (!(open.includes('/h/.claude/autoloop/config.json') && !closed.includes('/h/.claude/autoloop/config.json')
          && relocated.includes('/c/autoloop/config.json') && !relocated.includes('/h/.claude/autoloop/config.json')
          && pin !== null && pin.endsWith('/autoloop/models.json') && pinned.includes(pin))) {
          console.error('FAIL [the global model config is protected while a run is open, and only then; the pinned table always]');
          ok = false;
        }
      }
      // The owning session's `git switch main` waits for a reviewer reading
      // the checkout (LFE run, 2026-09-30 10:05). A session that owns no run
      // is not refused: the loop's exact-head checks see a changed checkout
      // (operator, 2026-10-12).
      if (process.platform === 'linux') {
        const checkout = mkdtempSync(join(tmpdir(), 'guard-switch-'));
        const reader = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'dispatch.mjs', '--role', 'diff-review'], { cwd: checkout, stdio: 'ignore' });
        try {
          execFileSync('git', ['init', '-q', checkout]);
          mkdirSync(join(checkout, '.autoloop'));
          writeFileSync(join(checkout, '.autoloop', 'config.json'),
            JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' } }));
          const run = (command, env = ownedEnv({ scope: checkout })) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            input: bashInput(command, checkout),
            encoding: 'utf8', cwd: checkout, timeout: 30000, env: { ...env, CLAUDE_PROJECT_DIR: checkout },
          });
          const unowned = run('git switch main', isolatedEnv());
          const switched = run('git switch main');
          const status = run('git status --short');
          reader.kill();
          const afterwards = run('git switch main');
          if (!(unowned.status === 0 && switched.status === 2 && switched.stderr.includes('reading this checkout')
            && status.status === 0 && afterwards.status === 0)) {
            console.error(`FAIL [the owner's branch switch waits for a reviewer; another session's does not]: ${unowned.status} ${switched.status} ${status.status} ${afterwards.status} ${switched.stderr.slice(0, 160)}`);
            ok = false;
          }
        } finally {
          reader.kill();
          rmSync(checkout, { recursive: true, force: true });
        }
      }
      // The session's owner: the first Claude ancestor; Claude as pid 1 (a
      // container); without Claude, the outermost ancestor; an unreadable
      // entry stops the walk where it is.
      const chains = {
        claude: new Map([[100, [50, 'zsh', '']], [50, [1, 'claude', '/x/claude']], [1, [0, 'init', '']]]),
        none: new Map([[100, [50, 'zsh', '']], [50, [1, 'tmux', '']], [1, [0, 'init', '']]]),
        pidOne: new Map([[100, [1, 'zsh', '']], [1, [0, 'claude', '/x/claude']]]),
        unreadable: new Map(),
      };
      const ownerOf = (chain) => sessionOwnerPid(100, (pid) => chains[chain].get(pid) ?? null);
      const owners = [ownerOf('claude'), ownerOf('none'), ownerOf('pidOne'), ownerOf('unreadable')];
      // A latch left by an earlier process with this pid (another start) is
      // replaced, not honoured; this process's own start is readable.
      const staleDir = join(scratch, 'stale-latches');
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, `${process.pid}.json`), JSON.stringify({ version: 2, owner: process.pid, ownerStart: 'another-process', baseBranch: 'old' }));
      const replaced = recordLatch({ owner: process.pid, baseBranch: 'main', directory: staleDir });
      const replacedLatch = sessionLatch({ owner: process.pid, directory: staleDir })?.latch;
      if (JSON.stringify(owners) !== '[50,50,1,100]' || replaced === null || replacedLatch?.baseBranch !== 'main'
        || (process.platform === 'linux' && processStart(process.pid) === null)) {
        console.error(`FAIL [the latch owner and its pid-reuse check]: ${JSON.stringify({ owners, replaced, base: replacedLatch?.baseBranch })}`);
        ok = false;
      }
      // A latch whose processes have all exited is a finished session's: pruned.
      const exited = spawnSync(process.execPath, ['-e', '0']).pid;
      mkdirSync(latches, { recursive: true });
      writeFileSync(join(latches, `${exited}.json`), JSON.stringify({ version: 2, owner: exited, ownerStart: null, baseBranch: 'main' }));
      const pruned = pruneLatches(latches);
      if (pruned.length !== 1 || existsSync(join(latches, `${exited}.json`)) || !existsSync(join(latches, latchFile))) {
        console.error(`FAIL [only latches whose processes have exited are pruned]: ${JSON.stringify(pruned)}`);
        ok = false;
      }
      // A forged, newer marker naming another base cannot relax the rules the
      // run's own base imposes: every base is enforced.
      const base = execFileSync('git', ['-C', scratch, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
      ownedHome(home, { baseBranch: base });
      writeFileSync(join(markers, 'run.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: 1, baseBranch: base }));
      writeFileSync(join(markers, 'forged.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: Date.now(), baseBranch: 'elsewhere' }));
      const forged = latchHook('git commit --allow-empty -m x', 'session-c');
      rmSync(join(markers, 'forged.json'));
      if (forged.status !== 2) {
        console.error(`FAIL [a forged marker naming another base cannot relax the base rules]: ${forged.status} ${forged.stderr}`);
        ok = false;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  for (const [name, payload, accepted] of [
    ['canonical hook payload', { tool_input: { command: 'echo ok' } }, true],
    ['missing tool input', {}, false],
    ['non-string hook command', { tool_input: { command: ['echo', 'unsafe'] } }, false],
  ]) {
    const command = payload?.tool_input?.command;
    const passed = (typeof command === 'string') === accepted;
    if (!passed) {
      console.error(`FAIL [${name}]`);
      ok = false;
    }
  }
  // The scoping decides whether `evaluate` is consulted at all, so prove both
  // that a fabricated marker cannot activate the guard and that its evidence is
  // exactly a live process in this hook's own ancestry.
  {
    const scratch = mkdtempSync(join(tmpdir(), 'autoloop-guard-run-'));
    try {
      spawnSync('git', ['init', '--quiet', scratch], { encoding: 'utf8' });
      const directory = runMarkerDirectory(scratch);
      if (directory === null) {
        console.error('FAIL [a checkout resolves its run marker directory]');
        ok = false;
      } else {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const marker = join(directory, 'selftest.json');
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an empty marker directory does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 1, pids: [999_999_999] }));
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [a marker outside this ancestry does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 2, pids: [process.ppid] }));
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an unknown marker version does not open a run]');
          ok = false;
        }
        writeFileSync(marker, 'not json');
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an unreadable marker does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 1, pids: [process.ppid] }));
        if (process.platform === 'linux' && loopRunIsOpen(scratch) !== true) {
          console.error('FAIL [a live marker in this ancestry opens a run]');
          ok = false;
        }
        if (process.platform === 'linux' && loopRunIsLive(scratch) !== true) {
          console.error('FAIL [an unclosed live marker is a live run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({
          version: 1,
          pids: [process.ppid],
          closedAt: '2026-08-27T22:16:56.088Z',
        }));
        if (process.platform === 'linux' && loopRunIsLive(scratch) !== false) {
          console.error('FAIL [a closed marker is not a live run]');
          ok = false;
        }
        if (process.platform === 'linux' && loopRunIsOpen(scratch) !== true) {
          console.error('FAIL [closing a run does not disarm the command guard]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 1, pids: [process.ppid], closedAt: null }));
        if (process.platform === 'linux' && loopRunIsLive(scratch) !== false) {
          console.error('FAIL [an unrecognised closedAt counts as closed]');
          ok = false;
        }
        // LFE, 2026-09-28: markers carried the tmux server's pid, so every
        // session under that server read as the loop's own run in that repo.
        const tree = {
          110: [95, 'node'], 95: [80, 'bash'], 80: [70, 'claude'], 70: [60, 'zsh'], 60: [1, 'tmux: server'],
          210: [180, 'node'], 180: [170, 'claude'], 170: [60, 'zsh'],
          310: [305, 'node'], 305: [60, 'bash'],
          // The binary never retitles itself (measured, 2.1.283): comm is
          // the name it was launched under. The npm package copies it to
          // bin/claude.exe; a versioned path launched directly is its version.
          410: [405, 'bash'], 405: [60, 'claude.exe'],
          510: [505, 'bash'], 505: [60, '2.1.283', '/home/u/.local/share/claude/versions/2.1.283'],
        };
        const chain = (start) => {
          try {
            return [...ancestorChain(start, (pid) => tree[pid] ?? null)].join(',');
          } catch (error) {
            return `THREW ${error.message}`;
          }
        };
        const chains = [chain(95), chain(180), chain(305), chain(410), chain(510)];
        if (chains.join(' | ') !== '95,80 | 180 | 305,60 | 410,405 | 510,505') {
          console.error(`FAIL [an ancestry stops at its own claude process]: ${chains.join(' | ')}`);
          ok = false;
        }
        // macOS has no /proc (CI, 0.59.0): ps supplies the same parent and
        // name, or every hook behind a shell wrapper lost sight of the run.
        const viaPs = psEntry(process.pid);
        const viaProc = procEntry(process.pid);
        const stubbed = psEntry(505, () => ({ status: 0, stdout: '   60 /home/u/.local/share/claude/versions/2.1.283\n' }));
        if (!(viaPs !== null && (viaProc === null || (viaPs[0] === viaProc[0] && viaPs[1] === viaProc[1]))
          && stubbed?.[0] === 60 && isClaudeProcess(stubbed[1], stubbed[2]))) {
          console.error(`FAIL [ps reads the same ancestry /proc does]: ${JSON.stringify({ viaPs, viaProc, stubbed })}`);
          ok = false;
        }
      }
    } catch {
      // An unwritable scratch directory is not a guard defect.
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  console.log(
    ok
      ? `self-test OK (${corpusCount} corpus + ${cases.length + messageChecks} cases)`
      : 'self-test FAILED',
  );
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  return ok;
}

// A refusal is a policy decision, not a malfunction — and it has to READ that way.
//
// Blocking with stderr and exit 2 alone makes the host render every refusal as
// "PreToolUse:Bash hook error", identical to a crashed hook. A correct decision
// then looks like a broken tool, which invites working around it instead of
// reading it. Emitting the structured decision as well makes the host present
// the reason on its own terms; measured against claude 2.1.220, the error
// framing disappears and the reason survives verbatim.
//
// All three parts are load-bearing. The JSON removes the error framing. `exit 2`
// keeps the refusal failing CLOSED if the host ever stops parsing this shape —
// JSON with exit 0 would then fail OPEN, a security regression rather than a
// cosmetic change. stderr keeps the reason visible in that case too.
// The command as the run-state rule reads it: each shell segment's words, and
// the subshell parentheses that open before it and close after it. ANSI-C
// quotes are decoded first, and every command substitution — outside single
// quotes — is judged as the commands it runs; more of them than can be taken
// apart makes an opaque segment, which the rule refuses.
const MAX_SUBSTITUTION_BODIES = 64;

export function guardSegments(cmd, depth = 0) {
  const text = quotedAnsiC(stripHeredocs(cmd));
  // shellSegments splits `>&file` at its `&`; the redirection is rejoined.
  const pieces = [];
  for (const piece of shellSegments(text)) {
    const last = pieces.at(-1);
    if (last !== undefined && last.raw === '&' && /[<>]$/u.test(last.command)) {
      pieces[pieces.length - 1] = { ...piece, command: `${last.command}&${piece.command}` };
    } else {
      pieces.push(piece);
    }
  }
  const segments = pieces.map(({ command }) => {
    // Linear scans, like trimSubshell: an anchored-at-end pattern backtracks
    // quadratically on a padded command.
    let leading = 0;
    let start = 0;
    for (; start < command.length && (command[start] === '(' || /\s/u.test(command[start])); start += 1) {
      if (command[start] === '(') leading += 1;
    }
    let trailing = 0;
    let end = command.length;
    for (; end > start && (command[end - 1] === ')' || /\s/u.test(command[end - 1])); end -= 1) {
      if (command[end - 1] === ')') trailing += 1;
    }
    // Only parentheses the segment leaves unbalanced open or close a
    // subshell: the `)` of `J=$(mktemp)` belongs to its substitution.
    let balance = 0;
    for (const char of command) balance += char === '(' ? 1 : char === ')' ? -1 : 0;
    const opens = Math.min(leading, Math.max(0, balance + trailing));
    const closes = Math.min(trailing, Math.max(0, leading - balance));
    // Cut exactly those parentheses, by position (one pass each way).
    let from = 0;
    for (let seen = 0; seen < opens; from += 1) if (command[from] === '(') seen += 1;
    let to = command.length;
    for (let seen = 0; seen < closes; to -= 1) if (command[to - 1] === ')') seen += 1;
    const body = command.slice(from, to);
    let words = shellWords(spacedRedirections(body.trim()));
    const comment = words.findIndex((word) => word.startsWith('#'));
    if (comment !== -1) words = words.slice(0, comment);
    return { words, opens, closes };
  }).flatMap((segment) => {
    // `eval` and a shell's `-c` script run text of their own: judged as the
    // commands it holds (eval in this shell, `sh -c` in a child).
    const inner = nestedScript(segment.words);
    if (inner === null) return [segment];
    if (depth >= MAX_SUBSTITUTION_DEPTH) return [segment, { words: [], opens: 0, closes: 0, opaque: true }];
    const nested = guardSegments(inner.script, depth + 1);
    if (nested.length > 0 && inner.child) {
      nested[0].opens += 1;
      nested.at(-1).closes += 1;
    }
    return [segment, ...nested];
  });
  const bodies = [...substitutionBodies(text), ...expandedHeredocBodies(quotedAnsiC(cmd)).flatMap(substitutionBodies)];
  if (bodies.length === 0) return segments;
  if (depth >= MAX_SUBSTITUTION_DEPTH || bodies.length > MAX_SUBSTITUTION_BODIES) {
    return [...segments, { words: [], opens: 0, closes: 0, opaque: true }];
  }
  for (const body of bodies) {
    const inner = guardSegments(body, depth + 1);
    if (inner.length === 0) continue;
    inner[0].opens += 1;
    inner.at(-1).closes += 1;
    segments.push(...inner);
  }
  return segments;
}

// The script an `eval`, a shell's `-c`, a `trap`, a shell alias or a gh
// alias runs, if the segment is one.
function nestedScript(words) {
  let index = 0;
  while (index < words.length && (isAssignmentWord(words[index]) || EXEC_WRAPPERS.has(basename(words[index])))) index += 1;
  const head = basename(words[index] ?? '');
  if (head === 'eval') return { script: words.slice(index + 1).join(' '), child: false };
  // An alias's value runs wherever its name is used later.
  if (head === 'alias') {
    const values = words.slice(index + 1).filter((word) => word.includes('=')).map((word) => word.slice(word.indexOf('=') + 1));
    return values.length === 0 ? null : { script: values.join(' ; '), child: false };
  }
  // A trap's action runs on its signal (`trap 'gh pr merge 1' EXIT`).
  if (head === 'trap') {
    const action = words.slice(index + 1).find((word) => word !== '--' && !word.startsWith('-'));
    return action === undefined || words.length < index + 3 ? null : { script: action, child: false };
  }
  // `gh alias set <name> <value>` runs `gh <value>` wherever the name is
  // used; `--shell` makes the value a shell script.
  if (head === 'gh' && words[index + 1] === 'alias' && words[index + 2] === 'set') {
    const rest = words.slice(index + 3);
    const shell = rest.some((word) => word === '--shell' || word === '-s');
    const [, value] = rest.filter((word) => !word.startsWith('-'));
    return value === undefined ? null : { script: shell ? value : `gh ${value}`, child: false };
  }
  if (!/^(?:ba|da|k|z)?sh$/u.test(head)) return null;
  const flag = words.findIndex((word, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word));
  return flag === -1 || words[flag + 1] === undefined ? null : { script: words[flag + 1], child: true };
}

// `$(…)` and backquote bodies outside single quotes, in one linear pass (a
// quoted commit message that mentions `$(rm …)` runs nothing). One past the
// cap is enough to know it was exceeded.
function substitutionBodies(text) {
  const bodies = [];
  let single = false;
  let double = false;
  for (let index = 0; index < text.length && bodies.length <= MAX_SUBSTITUTION_BODIES; index += 1) {
    const char = text[index];
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = true;
    else if (char === '"') double = !double;
    else if (char === '$' && text[index + 1] === '(') {
      const end = substitutionEnd(text, index + 2);
      if (end === -1) break;
      bodies.push(text.slice(index + 2, end));
      index = end;
    } else if (char === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) break;
      bodies.push(text.slice(index + 1, end));
      index = end;
    }
  }
  return bodies;
}

function refuse(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// A command that runs the plugin's prime opens a run, so it is checked in
// every session: prime anywhere but the session's project would leave the
// hooks guarding the wrong repository (only a hook sees CLAUDE_PROJECT_DIR),
// and a command that opens a run does only that (and reads) — a compound
// could break git or remove the fresh records before the guard has ever seen
// the run. Git is asked only about a command that runs prime.
// A prime that passes hands prime the host's session id and prunes the
// latches of exited sessions (spec exception 4: the one file work there).
function primeCommandProblems(cmd, cwd, projectRoot, deadline, sessionId) {
  const foreign = foreignPrimeProblem(cmd, cwd, projectRoot, undefined, deadline);
  if (foreign !== null) refuse(foreign);
  if (!opensRun(cmd, cwd)) return;
  if (!guardSegments(cmd).every((segment) => readsOnly(segment.words) || primeSegment(segment.words, cwd))) {
    refuse(
      'autoloop guard — this command opens a run (prime.mjs) and does more than read besides. Run '
      + '`node <plugin-tools>/prime.mjs --json` on its own (redirecting or piping its output to a reader is fine).',
    );
  }
  recordHostSession({ sessionId });
  pruneLatches();
}

// What a guard that threw exits with: 2 for the session that owns a run (its
// latch closed too), 0 for any other, and 1 — the hooks.json fallback then
// decides from the latch file — when ownership cannot be read. A payload not
// yet read names no session: any latch of this process refuses.
export function crashExitCode(sessionId, where = {}) {
  try {
    const owned = typeof sessionId === 'string' && sessionId !== ''
      ? ownedRun({ sessionId, includeClosed: true, ...where })
      : heldLatch(where);
    return owned === null ? 0 : 2;
  } catch {
    return 1;
  }
}

function main() {
  // AUTOLOOP_GUARD_BUDGET_MS can only shorten the budget (the self-test's
  // stalled-git case); nothing can lengthen it past the host's timeout.
  const budget = Math.min(GUARD_DEADLINE_MS, Number(process.env.AUTOLOOP_GUARD_BUDGET_MS) || GUARD_DEADLINE_MS);
  const deadline = Date.now() + budget;
  if (process.argv.includes('--corpus')) {
    const { total, failures } = replayCorpus();
    for (const line of failures) console.error(line);
    console.log(failures.length === 0
      ? `corpus OK (${total} cases)`
      : `corpus FAILED (${failures.length}/${total})`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    refuse(
      `autoloop guard — invalid guard invocation (${parsed.error}), so no command can be `
      + 'proven safe. Re-run autoloop:setup to repair the hook wiring.',
    );
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);
  // Plugin hooks fire in every session. Only the session that owns a run
  // (run-markers.mjs ownedRun, from the hook input's session id) is guarded:
  // for it the rules hold whatever the checkout now says, its latch's base
  // and every open marker's enforced. Any other session is allowed before a
  // git call, except for a command that runs the plugin's own prime — it opens
  // a run, so it is checked here first.
  // Every git call below shares the hook's budget; one that stalls or runs it
  // out makes the guard refuse rather than read "no answer" as "no run".
  setGitDeadline(deadline);
  const allow = () => {
    if (gitStalled()) {
      refuse(
        'autoloop guard — a git call timed out (a stalled or unreadable git directory), so whether '
        + 'the command is safe cannot be proven. Fix or leave the stalled repository, then retry.',
      );
    }
    process.exit(0);
  };
  let payload;
  let payloadError = null;
  let crashSession = null;
  const crashed = (error) => {
    process.stderr.write(`autoloop guard — the guard failed (${error?.message ?? error}), so the command cannot be proven safe.\n`);
    process.exit(crashExitCode(crashSession));
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    payloadError = error;
  }
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null;
  crashSession = sessionId;
  const cmd = payload?.tool_input?.command;
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const projectDir = () => parsed.root ?? hookRoot();
  const latched = ownedRun({ sessionId, includeClosed: true });
  if (latched === null) {
    // A payload that is unreadable or names no session may be the owner's
    // while this process holds a latch (open or closed), so it refuses as a
    // crashed guard does.
    if ((payloadError !== null || sessionId === null) && heldLatch() !== null) {
      refuse(
        `autoloop guard — the hook payload ${payloadError === null ? 'names no session' : `was unreadable (${payloadError.message})`}, `
        + 'so the command cannot be proven safe. Re-run the command; if this repeats, re-run autoloop:setup '
        + 'to repair the hook wiring.',
      );
    }
    if (typeof cmd === 'string') primeCommandProblems(cmd, cwd, projectDir, deadline, sessionId);
    allow();
  }
  if (latched.unreadable) {
    refuse(
      `autoloop guard — this session's run latch (${latched.path}) is unreadable, so whether a `
      + 'run is open cannot be proven and every command is refused. Start a new session.',
    );
  }
  const projectRoot = projectDir();
  const markers = pluginRunMarkers([process.cwd(), projectRoot]);
  // A run whose repository git can no longer read has hidden its markers (a
  // broken HEAD or config): refuse until it can be read again. The run's
  // repository, as its latch records it — the session's project directory
  // need not be one.
  if (commonDirOf(latched.latch.scope ?? projectRoot) === null) {
    refuse(
      'autoloop guard — git cannot read this repository while a run is open (a damaged HEAD, '
      + 'config or refs), so the run\'s state cannot be checked. A human repairs the repository.',
    );
  }
  if (payload?.tool_name === 'AskUserQuestion') {
    const problem = askUserQuestionProblem(loopRunIsLive() || loopRunIsLive(projectRoot));
    if (problem !== null) refuse(problem);
    allow();
  }
  if (typeof cmd !== 'string') {
    refuse(
      'autoloop guard — the hook payload omitted the Bash command, so it cannot be proven '
      + 'safe. Re-run the command; if this repeats, re-run autoloop:setup to repair the '
      + 'hook wiring.',
    );
  }
  primeCommandProblems(cmd, cwd, projectRoot, deadline, sessionId);

  // The run's own state and the guard's own code are off limits.
  const segments = guardSegments(cmd);
  const paths = protectedPaths({ projectRoot, cwd, runOpen: true });
  const stateProblem = runStateProblem(segments, { cwd, protectedDirs: paths.state, codeDirs: paths.code });
  if (stateProblem !== null) refuse(stateProblem);

  // A reviewer reading this checkout outlives the session that dispatched it,
  // so the owning session's branch switch waits for it (LFE run 2026-09-30: a
  // `git switch main` broke the previous session's diff-review). Other
  // sessions are not refused: the loop's exact-head checks see a changed
  // checkout (operator, 2026-10-12).
  if (segments.some(({ words }) => switchesCheckout(words))) {
    const reader = readingDispatchIn(repositoryRoot(cwd));
    if (reader !== null) {
      refuse(
        `autoloop guard — a ${reader.role} dispatch (pid ${reader.pid}) is reading this checkout, `
        + 'and switching branches would change the files under it. Do this in another worktree '
        + '(`git worktree add`), or wait for the review to return; if the session that dispatched '
        + `it is gone and its result is not wanted, stop pid ${reader.pid} first.`,
      );
    }
  }
  pruneLatches();

  // While a plugin run is open its recorded bases are the authority, whatever
  // the checkout now says (a missing, unreadable or different config): the
  // latch's pinned one and every open marker's, each enforced, so a forged
  // marker can only add rules.
  const bases = [...new Set([latched.latch.baseBranch, ...markers.map(({ marker }) => marker.baseBranch)]
    .filter((base) => typeof base === 'string'))];
  const branch = currentBranch();
  for (const baseBranch of bases) {
    const verdict = evaluate(cmd, branch, { baseBranch, cwd: payload?.cwd });
    if (verdict.block) refuse(verdict.reason);
  }
  allow();
}

// realpath compare — the naive `file://` string check fails open on encoded paths and symlinks.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
