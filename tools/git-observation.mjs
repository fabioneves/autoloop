// Fixed, root-bound Git observations. No argv, environment or writer API.
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { boundedGit } from './git-budget.mjs';

function requireObservation(ok) {
  if (!ok) throw observationError();
}
function observationError() {
  return Object.assign(new Error('The read-only Git observation cannot be verified.'), { code: 'GIT_OBSERVATION_FAILED' });
}
function utf8(bytes) {
  requireObservation(Buffer.isBuffer(bytes));
  const text = bytes.toString('utf8');
  requireObservation(Buffer.from(text, 'utf8').equals(bytes));
  return text;
}
function stat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function relativeFile(path) {
  requireObservation(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\x00-\x1f\x7f]/u.test(path)
    && Buffer.from(path, 'utf8').toString('utf8') === path
    && path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
  return path;
}
function submodulePath(root, path) {
  relativeFile(path);
  let directory = root;
  for (const part of path.split('/')) {
    directory = join(directory, part); const found = stat(directory);
    if (found === null) return join(root, path);
    requireObservation(found.isDirectory() && !found.isSymbolicLink());
  }
  return directory;
}
function uninitializedState(path) {
  const found = stat(path); const marker = stat(join(path, '.git'));
  requireObservation(marker === null && (found === null || found.isDirectory() && !found.isSymbolicLink()));
  return { path, present: found !== null, dev: found?.dev ?? null, ino: found?.ino ?? null };
}
// Kept private: callers can select only the fixed observations exported below.
function observationProfile(root, ignoreSubmodules = false) {
  requireObservation(typeof root === 'string' && isAbsolute(root) && !/[\x00-\x1f\x7f]/u.test(root));
  const requested = realpathSync(resolve(root));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // The option also makes older Git refuse; an ignored environment variable
  // alone must not permit a remote helper or an implicit object-store write.
  const fixed = ['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const overrides = [];
  const result = (directory, args, input) => boundedGit([...fixed, '-C', directory, ...overrides, ...args],
    { env, input, encoding: null, maxBuffer: Number.MAX_SAFE_INTEGER });
  const bytes = (directory, args, input) => {
    const value = result(directory, args, input); requireObservation(value.status === 0 && !value.error); return value.stdout;
  };
  const identity = (directory) => ({
    root: realpathSync(utf8(bytes(directory, ['rev-parse', '--show-toplevel'])).trim()),
    gitDir: realpathSync(utf8(bytes(directory, ['rev-parse', '--absolute-git-dir'])).trim()),
    commonDir: realpathSync(utf8(bytes(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()),
  });
  const before = identity(requested); const suffix = relative(before.root, requested);
  requireObservation(suffix === '' || !suffix.startsWith('..') && !isAbsolute(suffix));
  const scopes = []; const absent = []; const seen = new Set();
  const discover = (directory) => {
    const scope = identity(directory);
    requireObservation(scope.root === directory && !seen.has(scope.gitDir)); seen.add(scope.gitDir);
    const index = bytes(directory, ['ls-files', '--stage', '-z']);
    scopes.push({ ...scope, index });
    if (ignoreSubmodules) return;
    for (const row of utf8(index).split('\0').filter(Boolean)) {
      if (!row.startsWith('160000 ')) continue;
      const match = /^160000 (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t(.+)$/u.exec(row);
      requireObservation(match);
      const path = submodulePath(directory, match[1]); const marker = stat(join(path, '.git'));
      if (marker === null) { absent.push(uninitializedState(path)); continue; }
      requireObservation(!marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory()) && realpathSync(path) === path);
      discover(path);
    }
  };
  discover(before.root);
  const drivers = new Set();
  for (const scope of scopes) {
    const configured = result(scope.root, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$']);
    requireObservation(!configured.error && [0, 1].includes(configured.status));
    for (const key of utf8(configured.stdout).split('\0').filter(Boolean)) {
      const match = /^filter\.(.+)\.(?:clean|process|required)$/u.exec(key);
      requireObservation(match && !/[=\x00-\x1f\x7f]/u.test(match[1])); drivers.add(match[1]);
    }
  }
  // Git propagates these overrides into nested status commands. Include every
  // initialized scope, not only the parent. Built-in conversions remain active.
  for (const driver of [...drivers].sort()) overrides.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
  const verify = () => {
    for (const scope of scopes) {
      const after = identity(scope.root);
      requireObservation(['root', 'gitDir', 'commonDir'].every((key) => scope[key] === after[key])
        && scope.index.equals(bytes(scope.root, ['ls-files', '--stage', '-z'])));
    }
    for (const state of absent) requireObservation(JSON.stringify(uninitializedState(state.path)) === JSON.stringify(state));
    requireObservation(JSON.stringify(identity(requested)) === JSON.stringify(before) && realpathSync(root) === requested);
  };
  return { requested, bytes, verify };
}
export function readGitStatus(root, options = {}) {
  try {
    requireObservation(options !== null && typeof options === 'object' && !Array.isArray(options)
      && [Object.prototype, null].includes(Object.getPrototypeOf(options)));
    const allowed = ['zeroTerminated', 'includeIgnored', 'ignoreSubmodules'];
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      requireObservation(allowed.includes(key) && descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'boolean');
    }
    const profile = observationProfile(root, options.ignoreSubmodules);
    const args = ['status', '--porcelain=v1'];
    if (options.zeroTerminated) args.push('-z');
    args.push('--untracked-files=all');
    if (options.includeIgnored) args.push('--ignored');
    if (options.ignoreSubmodules) args.push('--ignore-submodules=all');
    const observed = profile.bytes(profile.requested, args); profile.verify(); return observed;
  } catch (error) {
    if (error?.code === 'GIT_OBSERVATION_FAILED') throw error;
    throw observationError();
  }
}
export function readGitContentOids(root, relativePaths) {
  try {
    requireObservation(Array.isArray(relativePaths) && Object.getPrototypeOf(relativePaths) === Array.prototype
      && Reflect.ownKeys(relativePaths).length === relativePaths.length + 1);
    const paths = [];
    for (let index = 0; index < relativePaths.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(relativePaths, String(index));
      requireObservation(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
      paths.push(relativeFile(descriptor.value));
    }
    const profile = observationProfile(root);
    for (const path of paths) {
      const parts = path.split('/'); let parent = profile.requested;
      for (const part of parts.slice(0, -1)) { parent = join(parent, part); const found = stat(parent);
        requireObservation(found?.isDirectory() && !found.isSymbolicLink()); }
      const file = stat(join(profile.requested, path)); requireObservation(file?.isFile() && !file.isSymbolicLink());
    }
    if (paths.length === 0) { profile.verify(); return []; }
    // Git's stdin-paths parser accepts C-quoted paths. JSON quoting uses the
    // same escapes for the allowed path characters; no shell parses this data.
    const input = Buffer.from(paths.map((path) => JSON.stringify(path)).join('\n') + '\n', 'utf8');
    const output = utf8(profile.bytes(profile.requested, ['hash-object', '--stdin-paths'], input)).trim().split('\n');
    requireObservation(output.length === paths.length && output.every((oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)));
    profile.verify(); return output;
  } catch (error) {
    if (error?.code === 'GIT_OBSERVATION_FAILED') throw error;
    throw observationError();
  }
}
