#!/usr/bin/env node
// PreToolUse(Bash) guard — converts the autoloop NEVER rules from prose into blocks.
// Vendored by autoloop:setup and wired into the active host's project hooks
// (.claude/settings.json and/or .codex/hooks.json).
//
//   BLOCK (exit 2)
//     1. `gh pr merge` in any form            — L2: the loop/agent never merges (STATE.md).
//     2. `git commit` while on a permanent branch — permanent branches take PRs only.
//        Skipped when the same command switches branches first (git switch|checkout).
//     3. a commit message carrying Co-Authored-By — commits carry no co-author trailer.
//     4. `git push --force`/-f                — only --force-with-lease is allowed.
//     5. inline --body/-b on gh pr create|comment|review|edit / gh issue comment —
//        untrusted text never rides in shell source; use --body-file (STATE → Lessons).
//     6. `gh api` reaching a merge endpoint, a GraphQL merge mutation, or a mutating
//        call on branch protection — the REST/GraphQL bypass of rule 1 and of
//        "never edit the protection yourself".
//     7. creating, applying, or renaming `loop-ready`; release-tag pushes; and
//        GitHub release mutations — prompt transport grants none of that authority.
//     8. active shell expansion, inline interpreter source, and unknown Git/GitHub
//        subcommands — opaque syntax can conceal any rule above.
//
//   ALLOW other literal canonical commands (exit 0). An invalid hook payload fails
//   closed because it cannot prove which command the host is about to execute.
//
// Usage:  (hook) reads the PreToolUse payload on stdin
//         node tools/agentic/command-guard.mjs --self-test

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MIGRATABLE_CONFIG_VERSIONS,
  extractConfig,
  validateConfig,
} from './config-contract.mjs';
import { LOOP_BRANCH_RE } from './claim-contract.mjs';

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
const GIT_COMMANDS = new Set([
  'add',
  'am',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bundle',
  'cat-file',
  'checkout',
  'cherry',
  'cherry-pick',
  'check-attr',
  'check-ignore',
  'clean',
  'clone',
  'commit',
  'config',
  'describe',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'format-patch',
  'fsck',
  'gc',
  'grep',
  'help',
  'init',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge',
  'merge-base',
  'merge-tree',
  'mv',
  'notes',
  'pull',
  'push',
  'range-diff',
  'rebase',
  'reflog',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'shortlog',
  'show',
  'show-ref',
  'sparse-checkout',
  'stash',
  'status',
  'submodule',
  'switch',
  'tag',
  'update-index',
  'verify-commit',
  'verify-tag',
  'version',
  'worktree',
]);
const GH_COMMANDS = new Set([
  'alias',
  'api',
  'attestation',
  'auth',
  'browse',
  'cache',
  'codespace',
  'completion',
  'config',
  'extension',
  'gist',
  'gpg-key',
  'help',
  'issue',
  'label',
  'org',
  'pr',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'workflow',
]);

// Strip heredoc bodies so text INSIDE a body (e.g. a PR description that quotes
// "gh pr merge") never false-positives.
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<[-~]?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?![A-Za-z0-9_-])/g,
    '',
  );
}

function executableShellStructure(cmd) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '`' || (char === '$' && cmd[index + 1] === '(')) return true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`' || char === '(' || char === ')' || char === '{' || char === '}') {
      return true;
    }
  }
  return false;
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

function decodeAnsiCQuotes(cmd) {
  return cmd.replace(
    /\$'((?:\\[\s\S]|[^'])*)'/gu,
    (_match, body) => decodeAnsiCBody(body),
  );
}

function executableLexicalText(cmd) {
  const decoded = decodeAnsiCQuotes(cmd);
  let output = '';
  for (let index = 0; index < decoded.length; index += 1) {
    const char = decoded[index];
    if (char === '\\') {
      if (decoded[index + 1] === '\r' && decoded[index + 2] === '\n') {
        index += 2;
      } else if (decoded[index + 1] === '\n') {
        index += 1;
      } else if (index + 1 < decoded.length) {
        output += decoded[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') continue;
    if (
      char === '$'
      && (decoded[index + 1] === "'" || decoded[index + 1] === '"')
    ) {
      continue;
    }
    output += char;
  }
  return output;
}

function structuredGitMutation(cmd) {
  if (!executableShellStructure(cmd)) return false;
  const visible = executableLexicalText(cmd);
  return /(?:^|[\s;&|(`{}])(?:\/[^\s;&|(`{}]+\/)*git\b(?:(?![;&|\n]).)*\b(?:commit|push)\b/u
    .test(visible);
}

function hasActiveShellExpansion(cmd) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      if (quote === '"') quote = null;
      else if (quote === null) quote = '"';
      continue;
    }
    if (
      char === '`'
      || char === '<' && cmd[index + 1] === '('
      || char === '>' && cmd[index + 1] === '('
      || (
        char === '$'
        && !new Set(["'", '"']).has(cmd[index + 1])
        && /[({A-Za-z_0-9@*#?$!_-]/u.test(cmd[index + 1] ?? '')
      )
    ) {
      return true;
    }
  }
  return false;
}

function opaqueMutationSyntax(cmd) {
  return hasActiveShellExpansion(cmd);
}

function interpreterHeredoc(cmd) {
  const interpreters =
    /(?:^|[\s;&|])(?:\/[^\s;&|]+\/)*(?:ba|da|k|z)?sh(?:\s|$)|(?:^|[\s;&|])(?:\/[^\s;&|]+\/)*(?:node|nodejs|bun|deno|perl|php|ruby|python(?:\d+(?:\.\d+)?)?)(?:\s|$)/u;
  const shellSources =
    /(?:^|[\s;&|])(?:source(?=\s|$)|\.(?=\s|$))/u;
  const logicalLines = String(cmd).replace(/\\\r?\n/gu, ' ');
  return logicalLines.split(/\r?\n/u).some((line) =>
    /<<[-~]?[ \t]*(?:['"]?)[A-Za-z_][A-Za-z0-9_-]*(?:['"]?)/u.test(line)
    && (
      interpreters.test(executableLexicalText(line))
      || shellSources.test(executableLexicalText(line))
    ));
}

function inlineInterpreterSource(cmd) {
  const sourceFlags = new Set([
    '-c',
    '-e',
    '-E',
    '-p',
    '-r',
    '--eval',
    '--print',
  ]);
  const interpreters = new Set([
    'bash',
    'bun',
    'dash',
    'deno',
    'ksh',
    'lua',
    'luajit',
    'node',
    'nodejs',
    'osascript',
    'perl',
    'php',
    'python',
    'python2',
    'python3',
    'ruby',
    'R',
    'Rscript',
    'sh',
    'tclsh',
    'wish',
    'zsh',
  ]);
  return shellSegments(executableLexicalText(cmd)).some(({ command }) => {
    const words = shellWords(command);
    const shellSource = words.findIndex((word) =>
      word === 'source' || word === '.');
    if (
      shellSource !== -1
      && words.slice(shellSource + 1).some((argument) =>
        argument === '-'
        || /^\/dev\/(?:stdin|fd\/[0-9]+)$/u.test(argument)
        || /^\/proc\/(?:self|thread-self|[0-9]+)\/fd\/[0-9]+$/u.test(argument))
    ) {
      return true;
    }
    return words.some((word, index) => {
      const executable = word.slice(word.lastIndexOf('/') + 1);
      if (
        !interpreters.has(executable)
        && !/^python\d+(?:\.\d+)?$/u.test(executable)
      ) {
        return false;
      }
      const argumentsAfterExecutable = words.slice(index + 1);
      if (argumentsAfterExecutable.length === 0) return true;
      if (argumentsAfterExecutable.some(
        (argument) =>
          sourceFlags.has(argument)
          || argument === '-'
          || /^\/dev\/(?:stdin|fd\/[0-9]+)$/u.test(argument)
          || /^\/proc\/(?:self|thread-self|[0-9]+)\/fd\/[0-9]+$/u.test(argument)
          || /^-[A-Za-z]*[ceEpr][A-Za-z]*$/u.test(argument),
      )) {
        return true;
      }
      return !argumentsAfterExecutable.some((argument) => !argument.startsWith('-'));
    });
  });
}

function opaqueCommandAssembler(cmd) {
  return shellSegments(executableLexicalText(cmd)).some(({ command }) => {
    const words = shellWords(command);
    if (
      executableIndex(words, 'xargs') !== -1
      || executableIndex(words, 'parallel') !== -1
    ) {
      return true;
    }
    for (const executable of ['awk', 'gawk', 'mawk', 'nawk']) {
      const index = executableIndex(words, executable);
      if (index === -1) continue;
      const argumentsAfterExecutable = words.slice(index + 1);
      const fileBacked = argumentsAfterExecutable.some(
        (argument) =>
          argument === '-f'
          || argument === '--file'
          || argument.startsWith('--file='),
      );
      if (!fileBacked) return true;
    }
    return false;
  });
}

function invokesIntentCapture(cmd) {
  return shellSegments(executableLexicalText(cmd)).some(({ command }) => {
    const words = shellWords(command);
    return words.some((word) =>
      /(?:^|\/)intent-contract\.mjs$/u.test(word))
      && words.some((word) =>
        ['--capture-hook', '--capture-hook-json'].includes(word));
  });
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
    segments.push({ command: cmd.slice(start, i).trim(), next: separator });
    i += separator.length - 1;
    start = i + 1;
  }
  segments.push({ command: cmd.slice(start).trim(), next: null });
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

function executableIndex(words, executable) {
  return words.findIndex(
    (word) => word === executable || word.endsWith(`/${executable}`),
  );
}

function commandAfterGlobalOptions(words, executable, optionsWithValues) {
  const executablePosition = executableIndex(words, executable);
  if (executablePosition === -1) return null;
  for (let index = executablePosition + 1; index < words.length; index += 1) {
    const word = words[index];
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (
      [...optionsWithValues].some((option) => word.startsWith(`${option}=`))
      || word.startsWith('-')
    ) {
      continue;
    }
    return word;
  }
  return null;
}

function unknownAmbientAliasSyntax(cmd) {
  return shellSegments(cmd).some(({ command }) => {
    const words = shellWords(command);
    const gitCommand = commandAfterGlobalOptions(
      words,
      'git',
      new Set([
        '-C',
        '-c',
        '--config-env',
        '--exec-path',
        '--git-dir',
        '--namespace',
        '--super-prefix',
        '--work-tree',
      ]),
    );
    if (gitCommand !== null && !GIT_COMMANDS.has(gitCommand)) return true;
    const ghCommand = commandAfterGlobalOptions(
      words,
      'gh',
      new Set(['-R', '--hostname', '--repo']),
    );
    return ghCommand !== null && !GH_COMMANDS.has(ghCommand);
  });
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

function hasCommandLineGitAlias(words) {
  const git = executableIndex(words, 'git');
  if (git === -1) return false;
  for (let index = git + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === '-c') {
      const setting = words[index + 1] ?? '';
      if (/^(?:alias\.|include(?:if\..+)?\.path(?:=|$))/i.test(setting)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (
      /^-calias\./i.test(word)
      || /^-cinclude(?:if\..+)?\.path(?:=|$)/i.test(word)
      || /^--config-env=(?:alias\.|include(?:if\..+)?\.path=)/i.test(word)
    ) {
      return true;
    }
    if (!word.startsWith('-')) return false;
  }
  return false;
}

function hasCommandLineGitConfig(words) {
  const git = executableIndex(words, 'git');
  if (git === -1) return false;
  return words.slice(0, git).some((word) => /^GIT_CONFIG(?:_|=)/u.test(word))
    || words.slice(git + 1).some(
      (word) =>
        word === '-c'
        || /^-c.+/u.test(word)
        || word === '--config-env'
        || word.startsWith('--config-env='),
    );
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

function isInlineGhBody(words) {
  const gh = executableIndex(words, 'gh');
  if (gh === -1) return false;
  const scope = words.findIndex((word, index) => index > gh && (word === 'pr' || word === 'issue'));
  const action = words[scope + 1];
  if (scope === -1 || !new Set(['create', 'comment', 'review', 'edit']).has(action)) return false;
  return words.some(
    (word) =>
      word === '--body'
      || word === '-b'
      || /^-[^-]*b.*$/u.test(word)
      || (word.startsWith('--body=') && !word.startsWith('--body-file=')),
  );
}

function hasGhScopedAction(words, scope, action) {
  const gh = executableIndex(words, 'gh');
  if (gh === -1) return false;
  const scopeIndex = words.indexOf(scope, gh + 1);
  return scopeIndex !== -1 && words.indexOf(action, scopeIndex + 1) !== -1;
}

function optionValues(words, option, shortOption) {
  const values = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === option || word === shortOption) {
      values.push(words[index + 1] ?? '');
      index += 1;
    } else if (word.startsWith(`${option}=`)) {
      values.push(word.slice(option.length + 1));
    } else if (
      shortOption !== undefined
      && word.startsWith(shortOption)
      && word.length > shortOption.length
    ) {
      values.push(word.slice(shortOption.length));
    }
  }
  return values;
}

const PROTECTED_LIFECYCLE_LABELS = new Set([
  'loop-delivered',
  'loop-ready',
]);

function protectedLifecycleLabel(value) {
  return PROTECTED_LIFECYCLE_LABELS.has(value.trim().toLowerCase());
}

function addsProtectedLifecycleLabel(words) {
  const edit =
    hasGhScopedAction(words, 'issue', 'edit')
    || hasGhScopedAction(words, 'pr', 'edit');
  return edit && optionValues(words, '--add-label').some((value) =>
    value.split(',').some(protectedLifecycleLabel));
}

function renamesProtectedLifecycleLabel(words) {
  return hasGhScopedAction(words, 'label', 'edit')
    && optionValues(words, '--name', '-n').some(
      protectedLifecycleLabel,
    );
}

function createsProtectedLifecycleLabel(words) {
  if (!hasGhScopedAction(words, 'label', 'create')) return false;
  const label = words.indexOf('label');
  const create = words.indexOf('create', label + 1);
  return create !== -1
    && (words[create + 1] ?? '').trim().toLowerCase() === 'loop-ready';
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

function normalizedGithubApiEndpoint(value) {
  if (typeof value !== 'string') return null;
  const prefix = 'https://api.github.com/';
  let endpoint;
  if (value.startsWith(prefix)) {
    endpoint = value.slice(prefix.length);
  } else {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return null;
    endpoint = value.replace(/^\/+/u, '');
  }
  endpoint = endpoint.split(/[?#]/u, 1)[0];
  if (!endpoint || /\s/u.test(endpoint)) return null;
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

function githubApiFieldAssignments(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return [];
  const args = words.slice(api + 1);
  const assignments = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['-f', '-F', '--field', '--raw-field'].includes(argument)) {
      assignments.push(args[index + 1] ?? '');
      index += 1;
    } else if (/^-[fF].+/u.test(argument)) {
      assignments.push(argument.slice(2));
    } else {
      const match = argument.match(/^--(?:field|raw-field)=(.*)$/u);
      if (match) assignments.push(match[1]);
    }
  }
  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    return {
      name: separator === -1 ? assignment : assignment.slice(0, separator),
      value: separator === -1 ? '' : assignment.slice(separator + 1),
    };
  });
}

function hasInputOption(words) {
  return words.some(
    (word) => word === '--input' || word.startsWith('--input='),
  );
}

function opaqueIssueLabelApiMutation(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).find((segments) =>
    segments.length >= 5
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'issues'
    && /^[1-9][0-9]*$/u.test(segments[4]));
  if (!endpoint) return false;
  if (endpoint.length === 6 && endpoint[5] === 'labels') return true;
  if (endpoint.length !== 5) return false;
  return hasInputOption(words)
    || githubApiFieldAssignments(words).some(
      ({ name }) => name === 'labels' || name === 'labels[]',
    )
    || words.some((word) => word.toLowerCase().includes('loop-delivered'));
}

function terminalLabelApiRename(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).some((segments) =>
    segments.length === 5
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'labels'
    && segments[4].length > 0);
  if (!endpoint) return false;
  if (hasInputOption(words)) return true;
  return githubApiFieldAssignments(words).some(
    ({ name, value }) =>
      name === 'new_name'
      && (
        protectedLifecycleLabel(value)
        || value.startsWith('@')
      ),
  );
}

function protectedLabelApiCreate(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).some((segments) =>
    segments.length === 4
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'labels');
  if (!endpoint) return false;
  if (hasInputOption(words)) return true;
  return githubApiFieldAssignments(words).some(
    ({ name, value }) =>
      name === 'name'
      && (
        value.startsWith('@')
        || value.trim().toLowerCase() === 'loop-ready'
      ),
  );
}

function decodeUnicodeEscapes(value) {
  const decode = (match, digits) => {
    const codePoint = Number.parseInt(digits, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  };
  return value
    .replace(/\\?u\{([0-9a-fA-F]{1,6})\}/gu, decode)
    .replace(/\\?u([0-9a-fA-F]{4})/gu, decode);
}

function terminalGraphqlMutation(command) {
  const words = shellWords(command);
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  const graphql = words.indexOf('graphql', api + 1);
  if (gh === -1 || api === -1 || graphql === -1) return false;
  const fields = githubApiFieldAssignments(words);
  const decodedCommand = decodeUnicodeEscapes(command);
  const updateIssueLabels = /\bupdateIssue\b/u.test(command)
    && (
      /\b(?:labels|labelIds)\s*:/u.test(command)
      || /\$(?:labels|labelIds)\b/u.test(command)
      || fields.some(({ name }) => name === 'labels' || name === 'labelIds')
    );
  const updateLabelName = /\bupdateLabel\b/u.test(command)
    && (
      /\bloop-(?:delivered|ready)\b/iu.test(decodedCommand)
      || fields.some(
        ({ name, value }) =>
          name === 'name'
          && (
            protectedLifecycleLabel(value)
            || value.startsWith('@')
          ),
      )
    );
  const createReadyLabel = /\bcreateLabel\b/u.test(command)
    && (
      /\bloop-ready\b/iu.test(decodedCommand)
      || fields.some(
        ({ name, value }) =>
          name === 'name'
          && (
            value.trim().toLowerCase() === 'loop-ready'
            || value.startsWith('@')
          ),
      )
    );
  return updateIssueLabels || updateLabelName || createReadyLabel;
}

function hasOpaqueGraphqlInput(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  const graphql = words.indexOf('graphql', api + 1);
  if (gh === -1 || api === -1 || graphql === -1) return false;
  const args = words.slice(api + 1);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input' || argument.startsWith('--input=')) return true;
    if (
      ['-F', '--field'].includes(argument)
      && /^query=@/u.test(args[index + 1] ?? '')
    ) {
      return true;
    }
    if (/^(?:-F|--field=)query=@/u.test(argument)) return true;
  }
  return false;
}

/**
 * Pure rule evaluation — returns { block: boolean, reason?: string }.
 * `branch` is the current Git branch; null keeps branch-sensitive mutations fail-closed.
 */
export function evaluate(rawCmd, branch, options = {}) {
  if (typeof rawCmd !== 'string' || rawCmd.length === 0) return { block: false };
  if (interpreterHeredoc(rawCmd)) {
    return {
      block: true,
      reason:
        'Blocked: a shell or language interpreter reading a heredoc is opaque to command '
        + 'policy. Use a visible canonical command or a reviewed file.',
    };
  }
  if (inlineInterpreterSource(rawCmd)) {
    return {
      block: true,
      reason:
        'Blocked: inline shell or language-interpreter source is opaque to command policy. '
        + 'Use a visible canonical command or a reviewed file.',
    };
  }
  if (opaqueCommandAssembler(rawCmd)) {
    return {
      block: true,
      reason:
        'Blocked: inline command assembly is opaque to command policy. '
        + 'Use literal canonical commands or a reviewed program file.',
    };
  }
  if (opaqueMutationSyntax(rawCmd)) {
    return {
      block: true,
      reason:
        'Blocked: active shell expansion is opaque to command policy and can hide a mutation. '
        + 'Use literal canonical commands; split discovery and mutation into separate tool calls.',
    };
  }
  const cmd = stripHeredocs(rawCmd);
  const lexicalCmd = executableLexicalText(cmd);
  const baseBranch = options.baseBranch ?? 'main';

  if (
    invokesIntentCapture(lexicalCmd)
    || /(?:^|[\s'"])\.git\/autoloop\/intents(?:\/|[\s'"]|$)/u.test(
      lexicalCmd,
    )
  ) {
    return {
      block: true,
      reason:
        'Blocked: invocation-intent transport is reserved for the host hook. '
        + 'A model command cannot capture or rewrite invocation intent.',
    };
  }

  if (unknownAmbientAliasSyntax(lexicalCmd)) {
    return {
      block: true,
      reason:
        'Blocked: an unknown Git or GitHub CLI command may resolve through an ambient alias. '
        + 'Use a canonical built-in subcommand.',
    };
  }

  if (structuredGitMutation(cmd)) {
    return {
      block: true,
      reason:
        'Blocked: grouped or substituted Git commit/push syntax can hide branch and destination '
        + 'state. Run the canonical Git command without shell grouping or substitution.',
    };
  }

  // 1. never merge
  if (/\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/.test(lexicalCmd)) {
    return {
      block: true,
      reason:
        'Blocked: `gh pr merge` — L2: the loop/agent never merges directly ' +
        '(docs/agentic/STATE.md → Autonomy). A human merges, or the repo-ratified ' +
        'tools/agentic/auto-merge.mjs performs the sole sanctioned policy-gated exception.',
    };
  }

  const segments = shellSegments(lexicalCmd);
  if (segments.some(({ command }) =>
    hasGhScopedAction(shellWords(command), 'pr', 'ready'))) {
    return {
      block: true,
      reason:
        'Blocked: raw pull-request readiness mutation. '
        + 'Use the exact-head Autoloop terminal finalizer.',
    };
  }
  if (segments.some(({ command }) =>
    addsProtectedLifecycleLabel(shellWords(command))
    || renamesProtectedLifecycleLabel(shellWords(command))
    || createsProtectedLifecycleLabel(shellWords(command)))) {
    return {
      block: true,
      reason:
        'Blocked: raw protected lifecycle-label mutation. '
        + '`loop-ready` requires an independent maintainer action; '
        + '`loop-delivered` requires the exact-head Autoloop terminal finalizer.',
    };
  }
  if (segments.some(({ command }) =>
    hasGhScopedAction(shellWords(command), 'release', 'create')
    || hasGhScopedAction(shellWords(command), 'release', 'delete')
    || hasGhScopedAction(shellWords(command), 'release', 'edit')
    || hasGhScopedAction(shellWords(command), 'release', 'upload')
    || pushesReleaseTag(shellWords(command)))) {
    return {
      block: true,
      reason:
        'Blocked: release or tag publication requires an independent maintainer release action; '
        + 'best-effort Autoloop invocation intent grants no release authority.',
    };
  }
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
    const words = shellWords(segment.command);
    if (hasCommandLineGitAlias(words)) {
      return {
        block: true,
        reason:
          'Blocked: command-scoped Git aliases or config includes can hide a protected mutation. '
          + 'Run the canonical Git subcommand without an alias override.',
      };
    }
    if (
      gitSubcommandIndex(words, 'push') !== -1
      && hasCommandLineGitConfig(words)
    ) {
      return {
        block: true,
        reason:
          'Blocked: command-scoped Git configuration can hide push destinations or force '
          + 'semantics. Run canonical `git push` without configuration overrides.',
      };
    }
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
          `Blocked: \`git commit\` may target configured base "${baseBranch}" — the base takes PRs `
          + 'only and the current branch must be proven. Create a working branch first: '
          + '<type>/gh-<N>-<slug> (autoloop:dev step 4).',
      };
    }
    if (pushTargetsBase(words, possibleBranches, baseBranch)) {
      return {
        block: true,
        reason:
          `Blocked: \`git push\` targets or can resolve to configured base "${baseBranch}" — `
          + 'use an explicit non-base refspec; the base takes PRs only.',
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

  // 3. no co-author trailers (checked on the RAW command: the trailer rides in -m text)
  if (
    segments.some(
      ({ command }) => gitSubcommandIndex(shellWords(command), 'commit') !== -1,
    )
    && /Co-Authored-By:/i.test(executableLexicalText(rawCmd))
  ) {
    return {
      block: true,
      reason:
        'Blocked: commit message carries a Co-Authored-By trailer — this repo forbids ' +
        'co-author trailers on commits (autoloop hard rules). Re-run without it.',
    };
  }

  // 4. force pushes: only --force-with-lease. Catches both the `--force`/`-f` flags AND the
  //    `+<refspec>` force syntax (`git push origin +main`, incl. a quoted `'+refs/…'`), which
  //    force-updates a ref with neither flag.
  if (/\bgit\b[^\n]*\bpush\b/.test(lexicalCmd)) {
    const flagForce = segments.some(({ command }) => {
      const words = shellWords(command);
      const push = gitSubcommandIndex(words, 'push');
      return push !== -1 && words.slice(push + 1).some(
        (word) =>
          longOptionPrefix(word, '--force')
          || /^-[^-]*f[^-]*$/u.test(word),
      );
    });
    const refspecForce = /(?:^|\s)\+\S/.test(lexicalCmd);
    if (flagForce || refspecForce) {
      return {
        block: true,
        reason:
          'Blocked: force push (`--force`/-f or a `+<refspec>` force-update) — destructive. Use ' +
          '--force-with-lease (and only on loop branches after a rebase, autoloop:pitcrew step 7).',
      };
    }
  }

  // 5. gh bodies go via --body-file, never inline
  if (segments.some(({ command }) => isInlineGhBody(shellWords(command)))) {
    return {
      block: true,
      reason:
        'Blocked: inline --body/-b on a gh command — untrusted text never rides in shell ' +
        'source (STATE → Lessons). Write the body to a scratch file with the host\'s safe file-editing surface ' +
        'and pass --body-file.',
    };
  }

  // 6. `gh api` must not merge or mutate branch protection. Reads stay allowed —
  //    issue timeline, collaborator role_name, and GraphQL queries/resolveReviewThread
  //    are all read-shaped and pass.
  if (/\bgh\b[^\n]*\bapi\b/.test(lexicalCmd)) {
    if (segments.some(({ command }) =>
      hasOpaqueGraphqlInput(shellWords(command)))) {
      return {
        block: true,
        reason:
          'Blocked: GraphQL query input from a file or stdin is opaque to the merge guard. '
          + 'Pass a visible read-only query inline.',
      };
    }
    if (/\/(pulls\/[^\s/]+\/merge|merges)\b/.test(lexicalCmd)) {
      return {
        block: true,
        reason:
          'Blocked: `gh api` merge endpoint — L2: the loop/agent never merges directly, via any ' +
          'raw surface (docs/agentic/STATE.md → Autonomy). Use human merge or the repo-ratified policy gate.',
      };
    }
    if (
      /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest)\b/
        .test(lexicalCmd)
    ) {
      return {
        block: true,
        reason:
          'Blocked: GraphQL merge mutation — L2: the loop/agent never merges directly, via any ' +
          'raw surface (docs/agentic/STATE.md → Autonomy). Use human merge or the repo-ratified policy gate.',
      };
    }
    if (
      /\bmarkPullRequestReadyForReview\b/u.test(lexicalCmd)
      || /\baddLabelsToLabelable\b/u.test(lexicalCmd)
      || segments.some(({ command }) => terminalGraphqlMutation(command))
    ) {
      return {
        block: true,
        reason:
          'Blocked: raw terminal GraphQL mutation. '
          + 'Use the exact-head Autoloop terminal finalizer.',
      };
    }
    if (segments.some(({ command }) =>
      opaqueIssueLabelApiMutation(shellWords(command))
      || terminalLabelApiRename(shellWords(command))
      || protectedLabelApiCreate(shellWords(command)))) {
      return {
        block: true,
        reason:
          'Blocked: raw issue or label mutation could bypass terminal delivery policy. '
        + 'Use a canonical gh issue command or the Autoloop terminal finalizer.',
      };
    }
    if (segments.some(({ command }) => {
      const words = shellWords(command);
      if (!mutatingGhApi(words)) return false;
      return githubApiEndpoints(words).some((path) =>
        path.length >= 4
        && path[0] === 'repos'
        && (
          path[3] === 'releases'
          || (
            path[3] === 'git'
            && ['refs', 'tags'].includes(path[4])
          )
        ));
    })) {
      return {
        block: true,
        reason:
          'Blocked: raw release/tag API mutation requires an independent maintainer release action.',
      };
    }
    if (
      /\/(?:protection|rulesets?(?:\/|\b))/.test(lexicalCmd) &&
      (
        /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(\s|=)/
          .test(lexicalCmd)
        || /(^|\s)-X(?:DELETE|PATCH|POST|PUT)(?:\s|$)/iu.test(lexicalCmd)
        || /(^|\s)-[fF]\S+/u.test(lexicalCmd)
      )
    ) {
      return {
        block: true,
        reason:
          'Blocked: mutating `gh api` call on branch or ruleset protection — the protection ' +
          'baseline is the human\'s control; the loop only reads it ' +
          '(docs/agentic/STATE.md → Autonomy). Report the mismatch instead.',
      };
    }
    if (
      /\b(?:create|update|delete)(?:RepositoryRuleset|BranchProtectionRule)\b/u
        .test(lexicalCmd)
    ) {
      return {
        block: true,
        reason:
          'Blocked: GraphQL branch/ruleset protection mutation — the protection baseline is '
          + 'the human\'s control; the loop only reads it.',
      };
    }
  }

  return { block: false };
}

function currentBranch() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

// The guard is defense-in-depth for commands a run issues; repository rules are
// the enforcement boundary. Applying it to every Bash call in the project turns
// ordinary development into a fight with a policy that was never aimed at it, so
// it enforces only while a run is actually open.
//
// An open run is evidenced by a live broker lease bound to a process in this
// hook's own ancestry. `finish` revokes the lease, so the evidence disappears
// with the run. Anything unreadable or ambiguous means "no run": a guard that
// cannot establish an open run must not block a human.
function brokerLeaseDirectory() {
  const parent = ['darwin', 'linux'].includes(process.platform)
    ? realpathSync('/tmp')
    : realpathSync(tmpdir());
  return join(
    parent,
    `autoloop-broker-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
  );
}

function ancestorPids(limit = 64) {
  const pids = new Set();
  let pid = process.ppid;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    pids.add(pid);
    let parent;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
      return pids;
    }
    if (!Number.isSafeInteger(parent) || parent <= 0) return pids;
    pid = parent;
  }
  return pids;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function loopRunIsOpen() {
  let entries;
  try {
    entries = readdirSync(brokerLeaseDirectory());
  } catch {
    return false;
  }
  const ancestors = ancestorPids();
  for (const entry of entries) {
    if (!entry.startsWith('host-') || !entry.endsWith('.lease')) continue;
    let lease;
    try {
      lease = JSON.parse(
        readFileSync(join(brokerLeaseDirectory(), entry), 'utf8'),
      );
    } catch {
      continue;
    }
    if (
      Number.isSafeInteger(lease?.pid)
      && Number.isSafeInteger(lease?.hostPid)
      && ancestors.has(lease.hostPid)
      && processAlive(lease.pid)
    ) {
      return true;
    }
  }
  return false;
}

export function loadConfiguredBase(statePath) {
  const config = extractConfig(readFileSync(statePath, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    // A configuration awaiting migration is not a hostile one. Refusing here
    // blocks every command in the repository, including the ones Setup needs to
    // perform the migration, so report the remedy and let the command through.
    // No loop can run under an unmigrated schema — Runtime rejects it at open —
    // so nothing the guard exists to protect is reachable in this state.
    if (MIGRATABLE_CONFIG_VERSIONS.includes(config?.version)) {
      throw Object.assign(
        new Error(
          `repository configuration is schema ${config.version}; `
          + 'run autoloop:setup to migrate. The command guard is inactive until then',
        ),
        { migrationPending: true },
      );
    }
    throw new Error(`invalid ProjectConfig: ${errors.join('; ')}`);
  }
  return config.baseBranch;
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { selfTest: true, statePath: null, error: null };
  }
  if (args.length === 0) {
    return {
      selfTest: false,
      statePath: 'docs/agentic/STATE.md',
      error: null,
    };
  }
  if (
    args.length === 2
    && args[0] === '--config'
    && typeof args[1] === 'string'
    && args[1].length > 0
  ) {
    return { selfTest: false, statePath: args[1], error: null };
  }
  return {
    selfTest: false,
    statePath: null,
    error: 'expected --config <STATE path> or --self-test',
  };
}

function selfTest() {
  const cases = [
    // [cmd, branch, expectBlock, baseBranch]
    ['gh pr merge 42', 'feat/gh-1-x', true],
    ['gh --repo o/r pr merge 42 --squash', 'feat/gh-1-x', true],
    ['verb=merge; gh pr $verb 42', 'feat/gh-1-x', true],
    ['gh pr m$(printf erge) 42', 'feat/gh-1-x', true],
    ['a=g; b=h; c=m; d=erge; "$a$b" pr "$c$d" 42', 'feat/gh-1-x', true],
    ['a=g; b=h; c=m; d=erge; eval "$a$b pr $c$d 42"', 'feat/gh-1-x', true],
    ['x=$(printf \\\\147\\\\150); y=$(printf \\\\155\\\\145\\\\162\\\\147\\\\145); $x pr $y 42', 'feat/gh-1-x', true],
    ["python3 -c 'import os; os.system(\"g\"+\"h pr m\"+\"erge 42\")'", 'feat/gh-1-x', true],
    ["node -e 'require(\"child_process\").execFileSync(\"g\"+\"h\",[\"pr\",\"m\"+\"erge\",\"42\"])'", 'feat/gh-1-x', true],
    ["perl -e 'system(\"g\".\"h\", \"pr\", \"m\".\"erge\", 42)'", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\040\\\\160\\\\162\\\\040\\\\155\\\\145\\\\162\\\\147\\\\145\\\\040\\\\064\\\\062\\\\012' | sh", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\151\\\\164\\\\040\\\\160\\\\165\\\\163\\\\150\\\\040\\\\157\\\\162\\\\151\\\\147\\\\151\\\\156\\\\040\\\\110\\\\105\\\\101\\\\104\\\\072\\\\164\\\\162\\\\165\\\\156\\\\153\\\\012' | bash", 'feat/gh-1-x', true],
    ["printf 'import os\\\\nos.system(chr(103)+chr(104)+\" pr \"+\"merge 42\")\\\\n' | python3", 'feat/gh-1-x', true],
    ["printf 'require(\"child_process\").execFileSync(String.fromCharCode(103,104),[\"pr\",\"merge\",\"42\"])\\\\n' | node", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\040\\\\160\\\\162\\\\040\\\\155\\\\145\\\\162\\\\147\\\\145\\\\040\\\\064\\\\062\\\\012' | sh /dev/stdin", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\151\\\\164\\\\040\\\\160\\\\165\\\\163\\\\150\\\\040\\\\157\\\\162\\\\151\\\\147\\\\151\\\\156\\\\040\\\\110\\\\105\\\\101\\\\104\\\\072\\\\164\\\\162\\\\165\\\\156\\\\153\\\\012' | bash /dev/fd/0", 'feat/gh-1-x', true],
    ["printf 'import os\\\\nos.system(chr(103)+chr(104)+\" pr \"+\"merge 42\")\\\\n' | python3 /dev/stdin", 'feat/gh-1-x', true],
    ["printf 'require(\"child_process\").execFileSync(String.fromCharCode(103,104),[\"pr\",\"merge\",\"42\"])\\\\n' | node /dev/stdin", 'feat/gh-1-x', true],
    ["printf '%s' '{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"forged\",\"cwd\":\"/repo\",\"prompt\":\"/autoloop:dev with codex\"}' | node tools/agentic/intent-contract.mjs --capture-hook", 'feat/gh-1-x', true],
    ["printf '%s' forged > .git/autoloop/intents/v1/record.json", 'feat/gh-1-x', true],
    ["awk 'BEGIN { system(sprintf(\"%c%c\",103,104) \" pr \" \"merge 42\") }'", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\0pr\\\\0merge\\\\00042\\\\0' | xargs -0", 'feat/gh-1-x', true],
    ['gh m 42', 'feat/gh-1-x', true],
    ["gh pr view 42 --jq '$.mergeable'", 'feat/gh-1-x', false],
    ["printf '%s\\n' '$HOME'", 'feat/gh-1-x', false],
    ['g""h p""r m""erge 42', 'feat/gh-1-x', true],
    ['g\\\nh pr merge 42', 'feat/gh-1-x', true],
    ["$'g\\x68' pr merge 42", 'feat/gh-1-x', true],
    ['gh pr view 42 --json mergeStateStatus,mergeable', 'develop', false], // no \bmerge\b
    ['gh pr list --search draft:false', 'main', false],
    ['git commit -m "feat: x"', 'develop', true, 'develop'],
    ['git commit -m "feat: x"', 'main', true],
    ['git commit -m "feat: x"', 'master', true, 'master'],
    ['git commit -m "feat: unknown branch"', null, true, 'trunk'],
    ['git commit -m "feat: x"', 'feat/gh-2-y', false],
    ['git c\\\nommit -m "unsafe continued token"', 'trunk', true, 'trunk'],
    ["$'g\\151t' commit -m \"unsafe encoded token\"", 'trunk', true, 'trunk'],
    ['(git commit -m "unsafe grouped")', 'trunk', true, 'trunk'],
    ['$(git commit -m "unsafe substitution")', 'trunk', true, 'trunk'],
    ['$("git" commit -m "unsafe quoted substitution")', 'trunk', true, 'trunk'],
    ['`git commit -m "unsafe backtick"`', 'trunk', true, 'trunk'],
    ['("git" commit -m "unsafe quoted group")', 'trunk', true, 'trunk'],
    ['`"git" commit -m "unsafe quoted backtick"`', 'trunk', true, 'trunk'],
    ['echo "$(git commit -m unsafe)"', 'trunk', true, 'trunk'],
    ['{ git commit -m "unsafe brace"; }', 'trunk', true, 'trunk'],
    ['(git \\\ncommit -m "unsafe continued")', 'trunk', true, 'trunk'],
    ["('git' commit -m \"unsafe quoted executable\")", 'trunk', true, 'trunk'],
    ['(g\\it commit -m "unsafe escaped executable")', 'trunk', true, 'trunk'],
    ['(git switch -c feat/gh-3-z && git commit -m "opaque")', 'trunk', true, 'trunk'],
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
    ['git commit -m "fix: y" -m "Co-Authored-By: Claude <n@a.com>"', 'feat/gh-2-y', true],
    ['git push --force origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo""rce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo\\\nrce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ["git push --$'f\\x6frce' origin feat/gh-2-y", 'feat/gh-2-y', true],
    ['git push --for origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -uf origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -fq origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -f', 'feat/gh-2-y', true],
    ['git push --force-with-lease origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin +main', 'feat/gh-2-y', true], // +refspec force
    ["git push origin '+refs/heads/main'", 'main', true], // quoted +refspec force
    ['git push origin feat/gh-2-y', 'feat/gh-2-y', false], // normal push, no force
    ['git push --set-upstream origin feat/gh-2-y', 'feat/gh-2-y', false],
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
    ['git push --tags origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --follow-tags origin feat/gh-2-y', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push --mi origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :', 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/*:refs/heads/*'", 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/feat/*:refs/heads/feat/*'", 'feat/gh-2-y', false, 'trunk'],
    ['git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/heads/trunk', 'feat/gh-2-y', true, 'trunk'],
    ['verb=push; git $verb origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git p$(printf ush) origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['g=git; $g push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['a=g; b=it; c=p; d=ush; "$a$b" "$c$d" origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git ship origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git ci -m x', 'trunk', true, 'trunk'],
    ['(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['$(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['echo "`git push origin HEAD:trunk`"', 'feat/gh-2-y', true, 'trunk'],
    ['{ git push origin HEAD:trunk; }', 'feat/gh-2-y', true, 'trunk'],
    ["(g'i't push origin HEAD:trunk)", 'feat/gh-2-y', true, 'trunk'],
    ['/usr/bin/git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --rep=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git -c alias.ship=push ship origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git -c remote.origin.push=HEAD:trunk push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git -c remote.origin.push=+HEAD:trunk push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git -c push.default=matching push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --delete origin trunk', 'feat/gh-2-y', true, 'trunk'],
    ['gh pr create --draft --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --repo o/r pr create --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --hostname github.example pr comment 4 -b "inline"', 'feat/gh-2-y', true],
    ['gh issue comment 5 -b "hi"', 'feat/gh-2-y', true],
    ['gh pr create --title "t" -binline', 'feat/gh-2-y', true],
    ['gh pr create -dbinline --title "t"', 'feat/gh-2-y', true],
    ['gh pr comment 4 -binline', 'feat/gh-2-y', true],
    ['gh issue comment 5 -binline', 'feat/gh-2-y', true],
    ['/usr/bin/gh issue comment 5 -b "hi"', 'feat/gh-2-y', true],
    ['gh pr create --draft --title "t" --body-file /tmp/b.md', 'feat/gh-2-y', false],
    ['gh pr review 5 --request-changes --body-file /tmp/r.md', 'main', false],
    ['gh pr ready 42', 'feat/gh-2-y', true],
    ['gh --repo o/r pr ready 42', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-ready,loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-ready', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label=LOOP-READY', 'feat/gh-2-y', true],
    ['gh pr edit 42 --add-label=loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --remove-label loop-ready', 'feat/gh-2-y', false],
    ['gh issue edit 7 --remove-label loop-delivered', 'feat/gh-2-y', false],
    ['gh label edit old-name --name loop-delivered', 'feat/gh-2-y', true],
    ['gh label edit old-name --name loop-ready', 'feat/gh-2-y', true],
    ['gh label edit old-name -nloop-delivered', 'feat/gh-2-y', true],
    ['gh label create loop-ready --description authority', 'feat/gh-2-y', true],
    ['gh label create loop-delivered --description terminal', 'feat/gh-2-y', false],
    ['gh release create v0.40.0 --notes-file /tmp/notes.md', 'feat/gh-2-y', true],
    ['gh release edit v0.40.0 --title changed', 'feat/gh-2-y', true],
    ['gh release delete v0.40.0 --yes', 'feat/gh-2-y', true],
    ['gh release upload v0.40.0 /tmp/asset.tgz', 'feat/gh-2-y', true],
    ['gh release view v0.40.0', 'feat/gh-2-y', false],
    ['gh release list', 'feat/gh-2-y', false],
    // gh api: merge/protection mutations blocked, reads pass
    ['gh api repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api repos/o/r/pulls/42/mer\\\nge -X PUT', 'feat/gh-2-y', true],
    ["gh api repos/o/r/pulls/42/$'m\\x65rge' -X PUT", 'feat/gh-2-y', true],
    ['gh api repos/o/r/merges -f base=main -f head=feat/gh-2-y', 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"})}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", 'feat/gh-2-y', true],
    ['gh api graphql --input /tmp/merge.json', 'feat/gh-2-y', true],
    ['gh api graphql --input=/tmp/merge.json', 'feat/gh-2-y', true],
    ['gh api graphql -Fquery=@/tmp/merge.graphql', 'feat/gh-2-y', true],
    ['gh api --input /tmp/merge.json graphql', 'feat/gh-2-y', true],
    ['gh api --input=/tmp/merge.json graphql', 'feat/gh-2-y', true],
    ['gh api -Fquery=@/tmp/merge.graphql graphql', 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"x\"})}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{pullRequestId:\"x\"}){pullRequest{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{addLabelsToLabelable(input:{labelableId:\"I_x\",labelIds:[\"LA_x\"]}){clientMutationId}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateIssue(input:{id:\"I_x\",labelIds:[\"LA_x\"]}){issue{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateIssue(input:{id:\"I_x\",title:\"x\"}){issue{labels{nodes{id}}}}}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop-delivered\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop-ready\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop\\u002ddelivered\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation($name:String!){updateLabel(input:{id:\"LA_x\",name:$name}){label{id}}}' -Fname=@/tmp/name.txt", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{createLabel(input:{repositoryId:\"R_x\",name:\"loop-ready\",color:\"fff\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"ordinary\"}){label{id}}}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{clearLabelsFromLabelable(input:{labelableId:\"I_x\"}){clientMutationId}}'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api /repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7/labels?per_page=100 -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ["gh api /repos/o/r/issues/7/labels?per_page=100 --jq '.[].name'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/issues/7 -X PATCH --input /tmp/issue.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7 -X PATCH -f labels[]=loop-delivered', 'feat/gh-2-y', true],
    ["gh api repos/o/r/issues/7 -X PATCH -F 'labels[]=@/tmp/label.txt'", 'feat/gh-2-y', true],
    ["gh api repos/o/r/issues/7 -X PATCH --field 'labels=@/tmp/labels.json'", 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7 -X PATCH -Flabels[]=@/tmp/label.txt', 'feat/gh-2-y', true],
    ["gh api /repos/o/r/issues/7 -X PATCH -F 'labels[]=@/tmp/label.txt'", 'feat/gh-2-y', true],
    ["gh api https://api.github.com/repos/o/r/issues/7 -X PATCH --field 'labels=@/tmp/labels.json'", 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7?state=open -X PATCH -Flabels[]=@/tmp/label.txt', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7/labels/loop-delivered -X DELETE', 'feat/gh-2-y', false],
    ['gh api repos/o/r/labels/old-name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name -X PATCH -f new_name=loop-ready', 'feat/gh-2-y', true],
    ['gh api /repos/o/r/labels/old%20name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api %72epos/o/r/labels/old-name -X PATCH -Fnew_name=@/tmp/name.txt', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name?locale=en -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/labels/old-name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name -X PATCH -f color=ffffff', 'feat/gh-2-y', false],
    ['gh api repos/o/r/labels -X POST -f name=loop-ready -f color=ffffff', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels -X POST -f name=ordinary -f color=ffffff', 'feat/gh-2-y', false],
    ['gh api repos/o/r/releases -X POST --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X PATCH --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7/assets -X POST --input /tmp/asset.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/assets/9 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/git/refs -X POST -f ref=refs/tags/v0.40.0 -f sha=abc', 'feat/gh-2-y', true],
    ['gh api repos/o/r/branches/main/protection -X DELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -XDELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -f enforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -fenforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -Frequired_status_checks=null', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X DELETE', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X PATCH -f enforcement=disabled', 'main', true],
    ["gh api graphql -f query='mutation{deleteRepositoryRuleset(input:{repositoryRulesetId:\"x\"}){clientMutationId}}'", 'main', true],
    ["gh api repos/o/r/branches/main/protection --jq '.enforce_admins.enabled'", 'main', false],
    ["gh api repos/o/r/issues/5/timeline --jq '.[]'", 'main', false],
    ['gh api repos/o/r/collaborators/alice/permission --jq .role_name', 'main', false],
    // heredoc body quoting a forbidden command must NOT trip the guard
    ['cat <<\'EOF\' > /tmp/x\ngh pr merge 42\nEOF', 'main', false],
    ['git commit -F - <<\'MSG\'\nfeat: x\nMSG', 'feat/gh-2-y', false],
    ['bash <<\'EOF\'\ngh pr merge 42\nEOF', 'feat/gh-2-y', true],
    ['sh <<\'EOF\'\ngit push origin HEAD:trunk\nEOF', 'feat/gh-2-y', true, 'trunk'],
    ['source /dev/stdin <<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ['. /dev/stdin <<\'EOF\'\ngh issue edit 7 --add-label loop-delivered\nEOF', 'feat/gh-2-y', true],
    ['source /dev/stdin \\\n<<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ['bash \\\n<<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ["printf '\\x67\\x68 pr ready 42\\n' | source /dev/stdin", 'feat/gh-2-y', true],
    ['. /dev/fd/0 < /tmp/opaque.sh', 'feat/gh-2-y', true],
    ['source scripts/reviewed.sh', 'feat/gh-2-y', false],
  ];
  let ok = true;
  for (const [cmd, branch, expect, baseBranch] of cases) {
    const got = evaluate(cmd, branch, { baseBranch }).block;
    if (got !== expect) {
      console.error(`FAIL [expect block=${expect}, got ${got}]: ${cmd.split('\n')[0]}`);
      ok = false;
    }
  }
  const argCases = [
    ['default config path', [], 'docs/agentic/STATE.md'],
    ['explicit config path', ['--config', '/repo/STATE.md'], '/repo/STATE.md'],
    ['missing config value', ['--config'], null],
    ['legacy base injection rejected', ['--base', 'main'], null],
  ];
  for (const [name, args, expectedPath] of argCases) {
    const parsed = parseArgs(args);
    const passed = expectedPath === null
      ? parsed.error !== null
      : parsed.error === null && parsed.statePath === expectedPath;
    if (!passed) {
      console.error(`FAIL [${name}]`);
      ok = false;
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
  // that a fabricated lease cannot activate the guard and that its evidence is
  // exactly a live broker bound to this process's own ancestry.
  {
    const directory = brokerLeaseDirectory();
    let created = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const foreign = join(directory, 'host-selftest-foreign.lease');
      writeFileSync(foreign, JSON.stringify({
        pid: process.pid,
        hostPid: 999_999_999,
      }));
      created = foreign;
      if (loopRunIsOpen() !== false) {
        console.error('FAIL [a lease outside this ancestry does not open a run]');
        ok = false;
      }
      writeFileSync(foreign, JSON.stringify({
        pid: 999_999_999,
        hostPid: process.ppid,
      }));
      if (loopRunIsOpen() !== false) {
        console.error('FAIL [a lease whose broker is dead does not open a run]');
        ok = false;
      }
      writeFileSync(foreign, JSON.stringify({
        pid: process.pid,
        hostPid: process.ppid,
      }));
      if (process.platform === 'linux' && loopRunIsOpen() !== true) {
        console.error('FAIL [a live lease in this ancestry opens a run]');
        ok = false;
      }
    } catch {
      // An unwritable broker directory is not a guard defect.
    } finally {
      if (created !== null) rmSync(created, { force: true });
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`command-guard: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(`command-guard: invalid hook payload; refusing command: ${error.message}`);
    process.exit(2);
  }
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string') {
    console.error('command-guard: hook payload omitted the Bash command; refusing command');
    process.exit(2);
  }

  // Ordered before configuration loading: with no run open there is nothing to
  // guard, so a configuration problem must not block a human's command either.
  if (!loopRunIsOpen()) process.exit(0);

  let baseBranch;
  try {
    baseBranch = loadConfiguredBase(parsed.statePath);
  } catch (error) {
    if (error.migrationPending === true) {
      console.error(`command-guard: ${error.message}`);
      process.exit(0);
    }
    console.error(`command-guard: cannot resolve configured base: ${error.message}`);
    process.exit(2);
  }
  const verdict = evaluate(cmd, currentBranch(), { baseBranch });
  if (verdict.block) {
    process.stderr.write(verdict.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
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
