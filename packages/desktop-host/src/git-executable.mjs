import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeRoot = path.join(appRoot, 'apps/native/dist-host/git');
const metadataPath = path.join(appRoot, 'native-package.json');
const fail = code => {throw Object.assign(Error(code), {code});};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const stamp = stat => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => stat[key]).join(':');
let cached;

/** Verify the entire owned closure, including internal links and corresponding
 * source. The package binds the manifest hash; no executable comes from PATH,
 * a renderer argument, repository configuration or an environment override. */
export function verifyGitRuntime(directory, {manifestSha256, platform = process.platform, arch = process.arch} = {}) {
  try {
    const root = path.resolve(directory);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail('GIT_RUNTIME_CORRUPT');
    const manifestPath = path.join(root, 'runtime-manifest.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) fail('GIT_RUNTIME_CORRUPT');
    const bytes = fs.readFileSync(manifestPath), digest = hash(bytes), manifest = JSON.parse(bytes);
    if (manifestSha256 !== undefined && digest !== manifestSha256) fail('GIT_RUNTIME_CORRUPT');
    if (manifest.schemaVersion !== 1 || manifest.distribution !== 'desktop/dugite-native' || !Array.isArray(manifest.entries)) fail('GIT_RUNTIME_CORRUPT');
    if (manifest.platform !== platform || manifest.arch !== arch) fail('GIT_RUNTIME_UNSUPPORTED_PLATFORM');
    const names = new Set(), stamps = [[manifestPath, stamp(manifestStat)], [root, stamp(fs.lstatSync(root))]];
    for (const entry of manifest.entries) {
      if (!relative(entry.path) || names.has(entry.path) || entry.path === 'runtime-manifest.json') fail('GIT_RUNTIME_CORRUPT');
      names.add(entry.path);
      const filename = path.join(root, entry.path), stat = fs.lstatSync(filename);
      if ((stat.mode & 0o777) !== entry.mode) fail('GIT_RUNTIME_CORRUPT');
      if (entry.type === 'symlink') {
        if (!stat.isSymbolicLink() || path.isAbsolute(entry.target) || fs.readlinkSync(filename) !== entry.target) fail('GIT_RUNTIME_CORRUPT');
        const target = fs.realpathSync(filename);
        if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) fail('GIT_RUNTIME_CORRUPT');
      } else if (entry.type === 'directory') {
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('GIT_RUNTIME_CORRUPT');
      } else if (entry.type === 'file') {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== entry.bytes || hash(fs.readFileSync(filename)) !== entry.sha256) fail('GIT_RUNTIME_CORRUPT');
      } else fail('GIT_RUNTIME_CORRUPT');
      stamps.push([filename, stamp(stat)]);
    }
    function walk(folder, prefix = '') {
      for (const name of fs.readdirSync(folder)) {
        const item = prefix + name;
        if (item === 'runtime-manifest.json') continue;
        if (!names.has(item)) fail('GIT_RUNTIME_CORRUPT');
        if (fs.lstatSync(path.join(folder, name)).isDirectory()) walk(path.join(folder, name), item + '/');
      }
    }
    walk(root);
    for (const required of ['bin/git', 'libexec/git-core/git', 'libexec/git-core/git-remote-https', 'licenses/Git-COPYING', 'licenses/SOURCE.md']) if (!names.has(required)) fail('GIT_RUNTIME_CORRUPT');
    const executable = path.join(root, 'bin/git');
    fs.accessSync(executable, fs.constants.X_OK);
    return {kind: 'bundled', directory: root, executable, execPath: path.join(root, 'libexec/git-core'), templatePath: path.join(root, 'share/git-core/templates'), manifestSha256: digest, gitVersion: manifest.gitVersion, release: manifest.release, entries: manifest.entries.length, stamps};
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('GIT_RUNTIME_')) throw error;
    fail(error.code === 'ENOENT' ? 'GIT_RUNTIME_MISSING' : 'GIT_RUNTIME_CORRUPT');
  }
}

/** Native startup calls this before admitting a profile or writing state.
 * Workers independently reach the same bundle through their module location. */
export function assertGitRuntime({packaged = false} = {}) {
  const hasMetadata = fs.existsSync(metadataPath);
  const inBundle = /(?:\.app\/Contents\/Resources|\/resources)\/app\/?$/.test(appRoot);
  let expected;
  if (packaged || hasMetadata || inBundle) {
    try {expected = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).bundledGit?.manifestSha256;} catch {fail('GIT_RUNTIME_MISSING');}
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail('GIT_RUNTIME_CORRUPT');
  }
  if (!expected && fs.existsSync(runtimeRoot)) {
    const filename = process.platform === 'darwin' && process.arch === 'arm64' ? 'git-runtime.json' : process.platform === 'linux' && process.arch === 'x64' ? 'git-runtime-linux-x64.json' : null;
    if (!filename) fail('GIT_RUNTIME_UNSUPPORTED_PLATFORM');
    try {expected = JSON.parse(fs.readFileSync(path.join(appRoot, 'apps/native', filename), 'utf8')).preparedManifestSha256;} catch {fail('GIT_RUNTIME_CORRUPT');}
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail('GIT_RUNTIME_CORRUPT');
  }
  if (expected) cached = verifyGitRuntime(runtimeRoot, {manifestSha256: expected});
  else {
    // Source development/tests only; packaged operation never reaches this.
    const executable = '/usr/bin/git';
    try {fs.accessSync(executable, fs.constants.X_OK);} catch {fail('GIT_UNAVAILABLE');}
    cached = {kind: 'system-development', executable, stamps: [[executable, stamp(fs.statSync(executable))]]};
  }
  const {stamps, ...descriptor} = cached;
  return Object.freeze(descriptor);
}

function runtime() {
  if (!cached) assertGitRuntime();
  try {for (const [filename, expected] of cached.stamps) if (stamp(fs.lstatSync(filename)) !== expected) fail('GIT_RUNTIME_CHANGED');}
  catch (error) {if (error.code === 'GIT_RUNTIME_CHANGED') throw error; fail('GIT_RUNTIME_CHANGED');}
  return cached;
}
export function gitExecutable() {return runtime().executable;}

/** Callers supply only their existing explicit operation-specific environment.
 * Inherited user Git/DYLD/SSH/credential settings are never copied. */
export function gitEnvironment(extra = {}) {
  const selected = runtime();
  const env = {LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '', ...extra};
  env.PATH = selected.kind === 'bundled' ? `${path.dirname(selected.executable)}:${selected.execPath}:/usr/bin:/bin` : '/usr/bin:/bin';
  if (selected.kind === 'bundled') {env.GIT_EXEC_PATH = selected.execPath; env.GIT_TEMPLATE_DIR = selected.templatePath;}
  return env;
}
