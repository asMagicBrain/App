import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {pinDirectory, checkDirectory, checkSourceSpelling} from '../physical-roots.mjs';
import {isPortableRelativePath, portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';
import {hashRawFile, openRawFile} from './raw-file.mjs';

const MAX_FILES = 10000, MAX_OUTPUT = 16 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const oid = value => /^[a-f0-9]{40}$/.test(value);
const exists = filename => { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function safe(relative) {
  if (!isPortableRelativePath(relative) || !relative.isWellFormed()
    || relative.split('/').length > 32
    || relative.split('/').some(part => part.toLowerCase() === '.asmagicbrain' || part.toLowerCase().startsWith('.asmb-'))) fail('INVALID_PATH');
  return relative;
}
function requestedMode(value) {
  if (value === undefined) return null;
  if (value === '100644' || value === '100755') return value;
  if (Number.isInteger(value) && value >= 0 && value <= 0o100777) return value & 0o111 ? '100755' : '100644';
  fail('INVALID_REQUEST');
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Trusted host-only initializer for a newly extracted, unpublished directory.
 * Never accepts an existing .git, resolves ignore rules, or runs source hooks,
 * filters or network operations. The importer owns failure retention/publication.
 */
export async function createImportedGitSnapshot({sourceRoot, files, initializeHistory = true, author = {name: 'asMagicBrain', email: 'local@asmagicbrain.invalid'}} = {}) {
  const source = pinDirectory(sourceRoot), gitPath = path.join(source.path, '.git');
  if (!Array.isArray(files) || files.length > MAX_FILES || typeof initializeHistory !== 'boolean') fail('INVALID_REQUEST');
  if (!author || Object.keys(author).length !== 2 || !Object.hasOwn(author, 'name') || !Object.hasOwn(author, 'email')) fail('INVALID_AUTHOR');
  for (const key of ['name', 'email']) if (typeof author[key] !== 'string' || !author[key].trim() || !author[key].isWellFormed()
    || author[key].length > 256 || /[\x00-\x1f\x7f<>]/.test(author[key])) fail('INVALID_AUTHOR');
  const manifest = new Map(), keys = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || !Object.hasOwn(file, 'path') || Object.keys(file).some(key => !['path', 'mode'].includes(key))) fail('INVALID_REQUEST');
    const name = safe(file.path), key = portablePathKey(name);
    if (keys.has(key)) fail('INVALID_REQUEST');
    keys.add(key); manifest.set(name, requestedMode(file.mode));
  }
  if (exists(gitPath)) fail('GIT_ALREADY_INITIALIZED');
  for (let parent = path.dirname(source.path);;) {
    if (exists(path.join(parent, '.git'))) fail('NESTED_REPOSITORY');
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  // Verify the complete extracted file set before creating any Git metadata.
  function enumerate(initial = false) {
    checkDirectory(source);
    const found = new Set(), directories = [];
    function walk(relative = '') {
      const directory = path.join(source.path, relative), names = new Set();
      directories.push(directory);
      for (const name of fs.readdirSync(directory)) {
        if (!relative && name === '.git' && !initial) continue;
        const key = portablePathKey(name);
        if (names.has(key)) fail('INVALID_PATH');
        names.add(key);
        const relativeName = safe(relative ? `${relative}/${name}` : name), stat = fs.lstatSync(path.join(directory, name));
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(relativeName);
        else {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_FILE');
          if (!manifest.has(relativeName) || found.size >= MAX_FILES) fail('IMPORT_MANIFEST_MISMATCH');
          found.add(relativeName);
        }
      }
    }
    walk();
    if (found.size !== manifest.size) fail('IMPORT_MANIFEST_MISMATCH');
    return directories;
  }
  enumerate(true);
  const expected = new Map();
  for (const [name, mode] of manifest) {
    checkSourceSpelling(source.path, name);
    const state = hashRawFile(path.join(source.path, name), {sync: true});
    if (mode !== null && mode !== state.mode) fail('CONFLICT');
    expected.set(name, state);
  }
  checkDirectory(source);
  // mkdir is exclusive: a competing/repeated initializer cannot rewrite a repo.
  try { fs.mkdirSync(gitPath, {mode: 0o700}); } catch (error) { if (error.code === 'EEXIST') fail('GIT_ALREADY_INITIALIZED'); throw error; }
  const git = pinDirectory(gitPath), executable = fs.statSync(gitExecutable());
  if (!executable.isFile()) fail('GIT_UNAVAILABLE');
  function check() { checkDirectory(source); checkDirectory(git); }
  async function run(args, {input = Buffer.alloc(0), env = {}} = {}) {
    check();
    const liveExecutable = fs.statSync(gitExecutable());
    if (liveExecutable.dev !== executable.dev || liveExecutable.ino !== executable.ino) fail('GIT_EXECUTABLE_CHANGED');
    const prefix = ['--no-pager', '--literal-pathspecs', '--no-replace-objects',
      '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.splitIndex=false', '-c', 'core.pager=cat', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
      `--git-dir=${gitPath}`, `--work-tree=${source.path}`];
    const cleanEnv = gitEnvironment({PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '', ...env});
    let child;
    const completion = new Promise((resolve, reject) => {
      child = execFile(gitExecutable(), [...prefix, ...args], {cwd: source.path, env: cleanEnv, encoding: 'buffer', timeout: 30000, maxBuffer: MAX_OUTPUT}, (error, stdout) => {
        if (error) { reject(Object.assign(new Error(error.killed ? 'GIT_TIMEOUT' : 'GIT_FAILED'), {code: error.killed ? 'GIT_TIMEOUT' : 'GIT_FAILED'})); return; }
        resolve(stdout.toString('utf8').trim());
      });
    });
    child.stdin.on('error', () => {});
    const transfer = Buffer.isBuffer(input) ? Promise.resolve(child.stdin.end(input)) : pipeline(input, child.stdin);
    const results = await Promise.allSettled([completion, transfer]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    check(); return results[0].value;
  }
  await run(['init', '--initial-branch=main', '--object-format=sha1', '--template=', source.path]);
  let head = null;
  if (initializeHistory) {
  await run(['read-tree', '--empty']);
  const records = [];
  for (const [name, state] of expected) {
    checkSourceSpelling(source.path, name);
    const file = openRawFile(path.join(source.path, name));
    try {
      if (file.size !== state.size || file.mode !== state.mode) fail('CONFLICT');
      const input = file.size ? fs.createReadStream(null, {fd: file.fd, autoClose: false, start: 0, end: file.size - 1, highWaterMark: 64 * 1024}) : Buffer.alloc(0);
      const sha = await run(['hash-object', '-w', '--stdin'], {input});
      file.verify();
      if (!oid(sha) || sha !== state.sha) fail('CONFLICT');
      records.push(`${state.mode} ${sha}\t${name}\0`);
    } finally { file.close(); }
  }
  if (records.length) await run(['update-index', '-z', '--index-info'], {input: Buffer.from(records.join(''))});
  const tree = await run(['write-tree']);
  if (!oid(tree)) fail('GIT_FAILED');
  head = await run(['commit-tree', tree], {input: Buffer.from('Import project\n'), env: {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  }});
  if (!oid(head)) fail('GIT_FAILED');
  }
  for (const [name, state] of expected) {
    checkSourceSpelling(source.path, name);
    const current = hashRawFile(path.join(source.path, name), {sync: true});
    if (current.hash !== state.hash || current.mode !== state.mode) fail('CONFLICT');
  }
  const directories = enumerate();
  if (initializeHistory) {
    await run(['update-ref', 'refs/heads/main', head, '0'.repeat(40)]);
    if (await run(['rev-parse', '--verify', 'HEAD']) !== head) fail('CONFLICT');
  }
  if (await run(['symbolic-ref', 'HEAD']) !== 'refs/heads/main') fail('CONFLICT');
  // Flush every Git object, index and ref before the caller can publish this dir.
  function syncGit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail('UNSAFE_GIT_METADATA');
      if (stat.isDirectory()) syncGit(filename);
      else { const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    }
    syncDirectory(directory);
  }
  check(); syncGit(gitPath);
  for (const directory of directories.reverse()) syncDirectory(directory);
  check();
  return {head, branch: 'main', fileCount: expected.size};
}
