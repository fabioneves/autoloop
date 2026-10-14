// Read-only content context for owner-observed planning relationships. No authority.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { boundedGit } from './git-budget.mjs';
import { readGitContentOids, readGitStatus } from './git-observation.mjs';
import { hashValue } from './checkout-contract.mjs';
import { canonicalBoundary, inLane } from './lane-contract.mjs';

function requireContext(ok, code = 'EVIDENCE_CHANGED') {
  if (!ok) throw Object.assign(new Error('The worktree content context cannot be verified.'), { code });
}
const bytesDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function text(bytes) {
  const value = bytes.toString('utf8');
  requireContext(Buffer.from(value, 'utf8').equals(bytes));
  return value;
}
function optionalStat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safePath(path) {
  requireContext(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/u.test(path)
    && path === posix.normalize(path) && path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
  return path;
}
function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every((key) => left[key] === right[key]);
}
function regularFingerprint(path, optional = false) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const before = fstatSync(fd, { bigint: true }); requireContext(before.isFile());
    const digest = createHash('sha256');
    const oid1 = createHash('sha1').update(`blob ${before.size}\0`);
    const oid256 = createHash('sha256').update(`blob ${before.size}\0`);
    const chunk = Buffer.alloc(64 * 1024);
    let size = 0n;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const bytes = chunk.subarray(0, count); size += BigInt(count);
      digest.update(bytes); oid1.update(bytes); oid256.update(bytes);
    }
    requireContext(size === before.size && sameFile(before, fstatSync(fd, { bigint: true })));
    return { kind: 'file', mode: before.mode & 0o111n ? '100755' : '100644', digest: digest.digest('hex'),
      oid: oid1.digest('hex'), oid256: oid256.digest('hex') };
  } finally { closeSync(fd); }
}
function uninitializedGitlink(path, oid, present) {
  return { path, kind: 'gitlink', mode: '160000', oid, oid256: oid, digest: hashValue({ initialized: false, present }) };
}
function workingEntry(root, path, gitlinkOid = null) {
  const parts = safePath(path).split('/'); let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part); const stat = optionalStat(parent);
    if (stat === null) return gitlinkOid === null ? { path, kind: 'absent' } : uninitializedGitlink(path, gitlinkOid, false);
    requireContext(stat.isDirectory() && !stat.isSymbolicLink());
  }
  const native = join(root, path); const stat = optionalStat(native);
  if (gitlinkOid !== null) {
    requireContext(stat === null || stat.isDirectory() && !stat.isSymbolicLink());
    const marker = optionalStat(join(native, '.git'));
    if (marker === null) {
      requireContext(stat === null || readdirSync(native).length === 0);
      return uninitializedGitlink(path, gitlinkOid, stat !== null);
    }
    requireContext(!marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory()) && realpathSync(native) === native);
    const nested = reader(native);
    requireContext(text(nested.bytes(['rev-parse', '--show-toplevel'])).trim() === native);
    const headOid = text(nested.bytes(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const context = readPlanningWorktreeContext(native, [], [], headOid);
    return { path, kind: 'gitlink', mode: '160000', oid: headOid, oid256: headOid,
      digest: hashValue({ headOid: context.headOid, treeOid: context.treeOid, worktreeStatusDigest: context.worktreeStatusDigest }) };
  }
  if (stat === null) return { path, kind: 'absent' };
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(native, { encoding: 'buffer' });
    return { path, kind: 'link', mode: '120000', digest: bytesDigest(target),
      oid: createHash('sha1').update(`blob ${target.length}\0`).update(target).digest('hex'),
      oid256: createHash('sha256').update(`blob ${target.length}\0`).update(target).digest('hex') };
  }
  requireContext(stat.isFile());
  return { path, ...regularFingerprint(native) };
}
function boundaryFiles(root, boundary, files) {
  const visit = (path) => {
    const stat = optionalStat(join(root, path)); if (stat === null) return;
    requireContext(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const name of readdirSync(join(root, path)).sort()) visit(safePath(`${path}/${name}`));
    else { requireContext(stat.isFile()); files.add(safePath(path)); }
  };
  for (const entry of boundary) visit(entry.replace(/\/$/u, ''));
}

// Only fixed identity/index/tree reads use this private reader. Status, which
// can invoke filters, uses the shared fixed-status observation policy.
function reader(root) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const base = ['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  return { bytes(args) {
    const result = boundedGit([...base, ...args], { env, encoding: null, maxBuffer: Number.MAX_SAFE_INTEGER });
    requireContext(result.status === 0 && !result.error); return result.stdout;
  } };
}
function entries(bytes, kind) {
  return text(bytes).split('\0').filter(Boolean).map((row) => {
    const match = kind === 'index' ? /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([^\0]+)$/u.exec(row)
      : /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/u.exec(row);
    requireContext(match && ['100644', '100755', '120000', '160000'].includes(match[1]));
    return { mode: match[1], oid: match[2], stage: kind === 'index' ? Number(match[3]) : 0,
      path: safePath(match[kind === 'index' ? 4 : 3]) };
  });
}
function statusPaths(bytes) {
  const rows = text(bytes).split('\0').filter(Boolean); const paths = []; let ignored = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]; requireContext(row.length > 3 && row[2] === ' ');
    if (row.startsWith('!! ')) { ignored = true; continue; }
    paths.push(safePath(row.slice(3)));
    if (/[RC]/u.test(row.slice(0, 2))) { index += 1; requireContext(index < rows.length); paths.push(safePath(rows[index])); }
  }
  return { paths, ignored };
}
export function readPlanningWorktreeContext(root, retainedBoundary, proposedBoundary = retainedBoundary, baseOid = null) {
  try {
    requireContext(typeof root === 'string' && isAbsolute(root) && realpathSync(root) === root);
    const retained = canonicalBoundary(root, retainedBoundary);
    const proposed = canonicalBoundary(root, [...retainedBoundary, ...proposedBoundary]);
    requireContext(JSON.stringify(retained.boundary) === JSON.stringify(retainedBoundary)
      && JSON.stringify(proposed.boundary) === JSON.stringify(proposedBoundary), 'BOUNDARY_PATH_INVALID');
    const git = reader(root);
    requireContext(text(git.bytes(['rev-parse', '--show-toplevel'])).trim() === root);
    const headOid = text(git.bytes(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const treeOid = text(git.bytes(['rev-parse', '--verify', 'HEAD^{tree}'])).trim();
    const comparisonBase = baseOid ?? headOid;
    requireContext(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(comparisonBase)
      && text(git.bytes(['rev-parse', '--verify', `${comparisonBase}^{commit}`])).trim() === comparisonBase);
    const indexPath = text(git.bytes(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    requireContext(realpathSync(dirname(indexPath)) === dirname(indexPath));
    const indexBefore = regularFingerprint(indexPath, true);
    const indexBytes = git.bytes(['ls-files', '--stage', '-z']); const index = entries(indexBytes, 'index');
    const head = entries(git.bytes(['ls-tree', '-r', '-z', comparisonBase]), 'head');
    const status = readGitStatus(root, { zeroTerminated: true, includeIgnored: true });
    const observedStatus = statusPaths(status); const changed = new Set();
    const files = new Set([...head, ...index].map((entry) => entry.path));
    for (const path of text(git.bytes(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) files.add(safePath(path));
    boundaryFiles(root, proposed.boundary, files);
    // Porcelain can report a stat-only modification whose built-in converted
    // content equals the index. The content/index checks below decide tracked
    // changes; status-only unknown paths still fail closed.
    for (const path of observedStatus.paths) if (!files.has(path)) changed.add(path);
    const baseByPath = new Map(head.map((entry) => [entry.path, entry]));
    const indexByPath = new Map(index.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]));
    const working = [...files].sort().map((path) => {
      const entry = indexByPath.get(path) ?? baseByPath.get(path);
      return workingEntry(root, path, entry?.mode === '160000' ? entry.oid : null);
    });
    const trackedFiles = working.filter((entry) => entry.kind === 'file' && indexByPath.has(entry.path));
    const converted = readGitContentOids(root, trackedFiles.map((entry) => entry.path));
    for (const [position, entry] of trackedFiles.entries()) {
      const checked = workingEntry(root, entry.path);
      requireContext(checked.kind === entry.kind && checked.mode === entry.mode && checked.digest === entry.digest);
      entry.normalizedOid = converted[position];
    }
    for (const entry of index) if (entry.stage !== 0) changed.add(entry.path);
    for (const entry of working) {
      const staged = indexByPath.get(entry.path); const base = baseByPath.get(entry.path);
      if (JSON.stringify(staged ?? null) !== JSON.stringify(base ?? null)) changed.add(entry.path);
      if (staged ? entry.kind === 'absent' || entry.mode !== staged.mode
        || (entry.normalizedOid ?? entry[staged.oid.length === 40 ? 'oid' : 'oid256']) !== staged.oid
        : entry.kind !== 'absent') changed.add(entry.path);
    }
    const changedPaths = canonicalBoundary(root, [...changed].sort()).boundary;
    requireContext(changedPaths.every((path) => inLane(path, retained.boundary)), 'BOUNDARY_EDIT_BEFORE_ADMISSION');
    const indexAfter = regularFingerprint(indexPath, true);
    requireContext((indexBefore?.digest ?? null) === (indexAfter?.digest ?? null)
      && status.equals(readGitStatus(root, { zeroTerminated: true, includeIgnored: true })) && indexBytes.equals(git.bytes(['ls-files', '--stage', '-z']))
      && headOid === text(git.bytes(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
      && treeOid === text(git.bytes(['rev-parse', '--verify', 'HEAD^{tree}'])).trim());
    return { headOid, treeOid, changedPaths, initialClean: !observedStatus.ignored && changedPaths.length === 0,
      worktreeStatusDigest: hashValue({ baseOid: comparisonBase, statusDigest: bytesDigest(status),
        indexDigest: indexBefore?.digest ?? null, index, working }) };
  } catch (error) {
    if (/^(?:BOUNDARY_|EVIDENCE_CHANGED$)/u.test(error?.code ?? '')) throw error;
    throw Object.assign(new Error('The worktree content context cannot be verified.'), { code: 'EVIDENCE_CHANGED' });
  }
}
