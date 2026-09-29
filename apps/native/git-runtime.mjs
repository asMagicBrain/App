import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyGitRuntime as verifyClosure} from '../../packages/desktop-host/src/git-executable.mjs';
import {gitRuntimePaths, selectGitRuntimeSpec} from './native-runtime.mjs';
import {verifyLinuxElf} from './elf-runtime.mjs';

export const gitRuntimeSpec = selectGitRuntimeSpec();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => {throw Error(message);};
const run = (command, args) => {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
  if (result.status !== 0) fail(`${path.basename(command)} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
};
const publicDescriptor = value => {const {stamps, ...result} = value; return result;};
// Linux records every symlink as 0777. BSD tar/cp can instead apply the host
// umask to a Linux-target link; preserve the reviewed target mode explicitly
// when staging foreign inputs. Never chmod through a link to its executable.
function preserveSymlinkMode(filename, mode) {
  const stat = fs.lstatSync(filename);
  if (!stat.isSymbolicLink()) fail('Expected an owned Git runtime symlink.');
  if ((stat.mode & 0o777) !== mode) {
    if (typeof fs.lchmodSync !== 'function') fail('Cannot preserve the selected Git symlink mode on this host.');
    fs.lchmodSync(filename, mode);
    if ((fs.lstatSync(filename).mode & 0o777) !== mode) fail('Git symlink mode differs after extraction.');
  }
}
export function verifyGitRuntime(directory, options = {}) {
  const gitRuntimeSpec = selectGitRuntimeSpec(options);
  if (!/^[a-f0-9]{64}$/.test(gitRuntimeSpec.preparedManifestSha256)) fail('Git runtime output is not qualified.');
  const result = verifyClosure(directory, {manifestSha256: gitRuntimeSpec.preparedManifestSha256, platform: gitRuntimeSpec.platform, arch: gitRuntimeSpec.arch});
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8'));
  if (manifest.release !== gitRuntimeSpec.release || manifest.selectionSha256 !== gitRuntimeSpec.selectionSha256 || manifest.archiveSha256 !== gitRuntimeSpec.inputs[0].sha256) fail('Git runtime does not match the pinned distribution.');
  return publicDescriptor(result);
}
export function copyGitRuntime(source, destination, options = {}) {
  const before = verifyGitRuntime(source, options);
  if (fs.existsSync(destination)) fail('Git runtime destination already exists.');
  fs.cpSync(source, destination, {recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false});
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'runtime-manifest.json'), 'utf8'));
  // fs.cp creates directories using the receiving process's umask. Restore
  // every reviewed mode before comparing the immutable inventory, including
  // when Ubuntu's ordinary user umask is 0002 instead of macOS's 0022.
  fs.chmodSync(destination, fs.lstatSync(source).mode & 0o777);
  for (const entry of manifest.entries) {
    const filename = path.join(destination, entry.path), stat = fs.lstatSync(filename);
    if (entry.type === 'symlink') preserveSymlinkMode(filename, entry.mode);
    else {
      if (stat.isSymbolicLink() || (entry.type === 'directory' ? !stat.isDirectory() : !stat.isFile())) fail('Copied Git runtime entry type differs.');
      fs.chmodSync(filename, entry.mode);
    }
  }
  const after = verifyGitRuntime(destination, options);
  if (before.manifestSha256 !== after.manifestSha256) fail('Git runtime copy changed.');
  return after;
}

/** Explicit preparation may fetch the pinned inputs. Ordinary builds remain
 * offline and fail if inputs are absent. Existing generated runtimes are only
 * verified, never silently replaced. Archives are retained unchanged. */
export async function prepareGitRuntime({destination, downloads, allowDownload = false, platform = process.platform, arch = process.arch}) {
  const options = {platform, arch}, gitRuntimeSpec = selectGitRuntimeSpec(options), selectionPath = gitRuntimePaths(options).selection;
  const selectionBytes = fs.readFileSync(selectionPath), selection = JSON.parse(selectionBytes);
  if (platform === 'darwin' && (process.platform !== platform || process.arch !== arch)) fail('macOS Git preparation requires macOS arm64 signing tools.');
  if (hash(selectionBytes) !== gitRuntimeSpec.selectionSha256) fail('Git selection checksum mismatch.');
  if (fs.existsSync(destination)) return verifyGitRuntime(destination, options);
  fs.mkdirSync(downloads, {recursive: true, mode: 0o700});
  for (const input of gitRuntimeSpec.inputs) {
    const filename = path.join(downloads, input.filename);
    if (!fs.existsSync(filename)) {
      if (!allowDownload) fail(`Missing pinned Git input ${input.filename}; run explicit Git runtime preparation with --download first.`);
      const response = await fetch(input.url);
      if (!response.ok) fail(`Git runtime download failed (${response.status}).`);
      const temporary = `${filename}.${process.pid}.part`, fd = fs.openSync(temporary, 'wx', 0o600);
      try {for await (const bytes of response.body) fs.writeSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      if (hash(fs.readFileSync(temporary)) !== input.sha256) fail(`Git runtime checksum mismatch; retained ${temporary}.`);
      fs.renameSync(temporary, filename);
    }
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(filename)) !== input.sha256) fail(`Pinned Git input mismatch: ${input.filename}`);
  }
  const archive = path.join(downloads, gitRuntimeSpec.inputs[0].filename);
  const members = run('/usr/bin/tar', ['-tzf', archive]).trim().split('\n').map(name => name.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean);
  const expected = [...selection.included, ...selection.excluded].map(entry => entry.path).filter(name => name !== '.');
  if (new Set(members).size !== members.length || new Set(expected).size !== expected.length || members.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) || JSON.stringify([...members].sort()) !== JSON.stringify([...expected].sort())) fail('Git archive member inventory mismatch.');
  fs.mkdirSync(destination, {recursive: true, mode: 0o755});
  // Extract only the exact audited Git-core members. No optional GCM/.NET,
  // credential stores, LFS filters or upstream custom system config is copied.
  for (const entry of selection.included.filter(item => item.type === 'directory')) fs.mkdirSync(path.join(destination, entry.path), {recursive: true, mode: entry.mode});
  run('/usr/bin/tar', ['-xzf', archive, '-C', destination, '--no-recursion', '--', ...selection.included.filter(item => item.type !== 'directory').map(item => './' + item.path)]);
  for (const entry of selection.included) {
    const filename = path.join(destination, entry.path), stat = fs.lstatSync(filename);
    if (entry.type === 'file' && (!stat.isFile() || stat.size !== entry.bytes || hash(fs.readFileSync(filename)) !== entry.sha256)) fail(`Git extraction mismatch: ${entry.path}`);
    if (entry.type === 'symlink' && (!stat.isSymbolicLink() || fs.readlinkSync(filename) !== entry.target)) fail(`Git link mismatch: ${entry.path}`);
    if (stat.isSymbolicLink()) preserveSymlinkMode(filename, entry.mode);
    else fs.chmodSync(filename, entry.mode);
  }
  const licenseRoot = path.join(destination, 'licenses'); fs.mkdirSync(licenseRoot, {mode: 0o755});
  for (const input of gitRuntimeSpec.inputs.slice(1)) {
    const target = path.join(licenseRoot, input.filename);
    fs.copyFileSync(path.join(downloads, input.filename), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o644);
  }
  const gitPrefix = `git-${gitRuntimeSpec.gitCommit}`, dugitePrefix = `dugite-native-${gitRuntimeSpec.upstreamCommit}`;
  fs.writeFileSync(path.join(licenseRoot, 'Git-COPYING'), run('/usr/bin/tar', ['-xOf', path.join(downloads, gitRuntimeSpec.inputs[2].filename), `${gitPrefix}/COPYING`]), {flag: 'wx', mode: 0o644});
  fs.writeFileSync(path.join(licenseRoot, 'dugite-native-LICENSE.md'), run('/usr/bin/tar', ['-xOf', path.join(downloads, gitRuntimeSpec.inputs[1].filename), `${dugitePrefix}/LICENSE.md`]), {flag: 'wx', mode: 0o644});
  fs.writeFileSync(path.join(licenseRoot, 'sha1collisiondetection-LICENSE.txt'), run('/usr/bin/tar', ['-xOf', path.join(downloads, gitRuntimeSpec.inputs[3].filename), `sha1collisiondetection-${gitRuntimeSpec.sha1CollisionDetectionCommit}/LICENSE.txt`]), {flag: 'wx', mode: 0o644});
  const sourceNotice = platform === 'darwin'
    ? `# Bundled Git source and notices\n\nGit ${gitRuntimeSpec.gitVersion} is a separate executable from GitHub Desktop's dugite-native ${gitRuntimeSpec.release}. Git and the build recipes are supplied under their included GPL version 2 notices. Complete corresponding Git source and the exact upstream build recipes accompany this runtime in the three source archives in this directory. Extract the Git archive into the build recipe's git subdirectory, then the sha1collisiondetection archive into git/sha1collisiondetection, matching upstream CI's recursive submodule checkout; script/build-macos.sh records the upstream compiler, platform flags and system library choices. The Git source archive also retains component copyright and license notices.\n\nUpstream release: ${gitRuntimeSpec.releaseURL}\nGit source: ${gitRuntimeSpec.inputs[2].url}\nBuild recipes: ${gitRuntimeSpec.inputs[1].url}\nSHA-1 collision detection source: ${gitRuntimeSpec.inputs[3].url}\n\nThe application retains upstream Git core executables, helpers and internal links. It does not change their executable code. Packaging replaces the linker ad-hoc signature with an application-owned ad-hoc signature before recording hashes. Optional Git Credential Manager/.NET, Git LFS and the upstream system gitconfig are excluded. No Keychain credential helper is included. git-runtime-selection.json records every included and excluded archive member; provenance.json records exact source/archive pins. System frameworks and /usr/lib libraries remain macOS dependencies. This internal validation build is not Developer ID signed or notarized.\n`
    : `# Bundled Git source and notices\n\nGit ${gitRuntimeSpec.gitVersion} is a separate executable from GitHub Desktop's dugite-native ${gitRuntimeSpec.release}. Complete corresponding Git source, SHA-1 collision detection source, and exact upstream GPL version 2 build recipes accompany this runtime in three source archives. Extract Git into the build recipe's git subdirectory and SHA-1 collision detection into git/sha1collisiondetection, as in upstream CI's recursive checkout. script/build-ubuntu.sh records the compiler and system-library choices. Component notices remain in the complete source archives.\n\nUpstream release: ${gitRuntimeSpec.releaseURL}\nGit source: ${gitRuntimeSpec.inputs[2].url}\nBuild recipes: ${gitRuntimeSpec.inputs[1].url}\nSHA-1 collision detection source: ${gitRuntimeSpec.inputs[3].url}\n\nGit core, internal links, the HTTP/HTTPS helper and default templates are retained byte-for-byte. Git Credential Manager, credential-store/cache entry points, Git LFS, Scalar, external transport entry points, Perl/shell/server programs, Git web and the upstream system gitconfig/CA bundle are excluded. git-runtime-selection.json records every included and excluded archive member; provenance.json records exact input pins. No bundled ELF code is signed or changed. The runtime uses Ubuntu's glibc (at least 2.34), zlib and libcurl with the system CA trust store; these system libraries are not redistributed. Every selected ELF input must use the pinned x64 loader, contain no RPATH/RUNPATH, and name only admitted system shared libraries. Linux execution and native acceptance are separate from static preparation.\n`;
  fs.writeFileSync(path.join(licenseRoot, 'SOURCE.md'), sourceNotice, {flag: 'wx', mode: 0o644});
  const selectionTarget = path.join(licenseRoot, 'git-runtime-selection.json');
  fs.copyFileSync(fileURLToPath(selectionPath), selectionTarget, fs.constants.COPYFILE_EXCL);
  // copyFile retains checkout permissions, which can be 0664 under umask 0002.
  // The prepared closure has a fixed 0644 metadata mode on both platforms.
  fs.chmodSync(selectionTarget, 0o644);
  // The prepared output hash is tracked outside this hashed closure to avoid a cycle.
  const {preparedManifestSha256, ...upstreamProvenance} = gitRuntimeSpec;
  fs.writeFileSync(path.join(licenseRoot, 'provenance.json'), JSON.stringify(upstreamProvenance, null, 2) + '\n', {flag: 'wx', mode: 0o644});
  const machO = [], elf = [];
  for (const entry of selection.included.filter(item => item.type === 'file')) {
    const filename = path.join(destination, entry.path), bytes = fs.readFileSync(filename);
    if (platform === 'linux') {
      if (bytes.subarray(0, 4).toString('hex') === '7f454c46') elf.push({path: entry.path, sha256: entry.sha256, ...verifyLinuxElf(bytes, gitRuntimeSpec.systemDependencies)});
      else if ((entry.mode & 0o111) && !entry.path.startsWith('share/git-core/templates/')) fail(`Unapproved non-ELF Git executable: ${entry.path}`);
      continue;
    }
    if (bytes.subarray(0, 4).toString('hex') !== 'cffaedfe') continue;
    if (run('/usr/bin/lipo', ['-archs', filename]).trim() !== 'arm64') fail(`Unexpected Git architecture: ${entry.path}`);
    const dependencies = run('/usr/bin/otool', ['-L', filename]).trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
    if (dependencies.some(value => !value.startsWith('/usr/lib/') && !value.startsWith('/System/Library/'))) fail(`Non-system Git dynamic dependency: ${entry.path}`);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', `com.asmagicbrain.git.${path.basename(filename)}`, filename]);
    run('/usr/bin/codesign', ['--verify', '--strict', filename]);
    machO.push({path: entry.path, beforeSha256: entry.sha256, afterSha256: hash(fs.readFileSync(filename)), dependencies});
  }
  if (platform === process.platform && arch === process.arch) {
    const version = run(path.join(destination, 'bin/git'), ['--version']).trim();
    if (version !== `git version ${gitRuntimeSpec.gitVersion}`) fail('Unexpected bundled Git version.');
  }
  const entries = [];
  function inventory(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const filename = path.join(folder, name), stat = fs.lstatSync(filename), entry = {path: prefix + name, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777};
      if (stat.isSymbolicLink()) entry.target = fs.readlinkSync(filename);
      else if (stat.isFile()) {entry.bytes = stat.size; entry.sha256 = hash(fs.readFileSync(filename));}
      entries.push(entry);
      if (stat.isDirectory()) inventory(filename, entry.path + '/');
    }
  }
  inventory(destination);
  const manifest = {schemaVersion: 1, distribution: gitRuntimeSpec.distribution, release: gitRuntimeSpec.release, gitVersion: gitRuntimeSpec.gitVersion, platform, arch, archiveSha256: gitRuntimeSpec.inputs[0].sha256, selectionSha256: gitRuntimeSpec.selectionSha256, signing: platform === 'darwin' ? 'ad-hoc-before-inventory' : 'upstream-unchanged', ...(platform === 'darwin' ? {machO} : {elf}), entries};
  fs.writeFileSync(path.join(destination, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o644});
  return verifyGitRuntime(destination, options);
}
