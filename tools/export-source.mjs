/** Produce a reviewable source archive without carrying private Git history,
 * local dependencies, profiles or build outputs into a new public repository. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {extractZip} from '../packages/desktop-host/src/zip-import/index.mjs';
import {isPublicSourcePath} from './public-source-policy.mjs';
import {validateRelease, releaseSourceTag} from '../apps/native/release-identity.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function gitBytes(...args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
    env: {...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'},
  });
  if (result.error || result.status !== 0) throw Error('Source export Git operation failed.');
  return result.stdout;
}
const git = (...args) => gitBytes(...args).toString('utf8');
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0].startsWith('--output=') || !path.isAbsolute(args[0].slice(9))) throw Error('Usage: node tools/export-source.mjs --output=/absolute/new/directory');
const output = path.resolve(args[0].slice(9));
if (output === root || output.startsWith(root + path.sep) || root.startsWith(output + path.sep)) throw Error('Source export must be separate from the checkout.');
if (fs.existsSync(output)) throw Error('Preserve existing exports: choose a new output directory.');
let ancestor=path.dirname(output);
while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
if(!fs.lstatSync(ancestor).isDirectory()||fs.realpathSync(ancestor)!==ancestor)throw Error('Source export requires physical destination ancestors.');
const release = validateRelease(JSON.parse(fs.readFileSync(path.join(root, 'apps/native/release.json'), 'utf8')));
if (!/^\d+\.\d+\.\d+$/.test(release.version)) throw Error('Source export requires a stable numbered release.');
const commit = git('rev-parse', 'HEAD').trim(), tag = releaseSourceTag(release);
function exactSource() {
  if (git('status', '--porcelain=v1', '--untracked-files=all').trim() || git('rev-parse', 'HEAD').trim() !== commit || git('rev-parse', 'refs/tags/' + tag + '^{commit}').trim() !== commit) throw Error('Source export requires a clean checkout at the exact release tag.');
}
exactSource();
const entries = git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean).map(line => {
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);
  if (!match) throw Error('Only ordinary committed source files can be exported.');
  return {mode: parseInt(match[1], 8) & 0o777, object: match[2], path: match[3]};
}).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const names = entries.map(entry => entry.path);
for (const name of ['LICENSE', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'package-lock.json', 'ui-workshop/package-lock.json', 'docs/README.md']) {
  if (!names.includes(name)) throw Error('Required public source file missing: ' + name);
}
const files = entries.map(entry => {
  const name = entry.path;
  const filename = path.join(root, name), stat = fs.lstatSync(filename);
  if (!isPublicSourcePath(name) || !stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) throw Error('Unadmitted source path: ' + name);
  const bytes = gitBytes('cat-file', 'blob', entry.object), digest = sha(bytes);
  if (sha(fs.readFileSync(filename)) !== digest || Boolean(stat.mode & 0o111) !== Boolean(entry.mode & 0o111)) throw Error('Working file differs from release blob: ' + name);
  return {path: name, bytes: bytes.length, sha256: digest, mode: entry.mode};
});
const parent = path.dirname(output);
fs.mkdirSync(parent, {recursive: true, mode: 0o700});
if (fs.realpathSync(parent) !== parent) throw Error('Source export destination changed during creation.');
// Reserve this publication exactly once; a concurrent exporter must not adopt
// an output directory another process has already claimed.
fs.mkdirSync(output, {mode: 0o700});
if(fs.realpathSync(output)!==output)throw Error('Source export destination changed during creation.');
try {
  const archive = 'asMagicBrain-' + release.version + '-source.zip';
  git('archive', '--format=zip', '--prefix=asMagicBrain-' + release.version + '/', '--output=' + path.join(output, archive), commit);
  const archiveBytes = fs.readFileSync(path.join(output, archive));
  const extracted = path.join(output, 'source');fs.mkdirSync(extracted, {mode:0o700});
  const actual = extractZip(archiveBytes, {destination: extracted});
  const archivedNames = actual.entries.filter(item=>item.kind==='file'&&!item.skipped).map(item=>item.path).sort();
  if (actual.summary.skippedEntries || JSON.stringify(archivedNames)!==JSON.stringify(names)) throw Error('Archive attributes changed the committed source membership.');
  for (const file of files) {
    const filename=path.join(extracted,file.path);
    // The safe importer intentionally normalizes permissions to 0600/0700.
    // Git tracks the executable bit; restore its conventional source mode only
    // after membership/content checks on our own freshly extracted directory.
    if (sha(fs.readFileSync(filename))!==file.sha256 || Boolean(fs.statSync(filename).mode & 0o111)!==Boolean(file.mode & 0o111)) throw Error('Archived source differs from release blob: '+file.path);
    fs.chmodSync(filename,file.mode);
  }
  exactSource();
  for (const file of files) if (sha(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw Error('Source changed during export.');
  const manifest = {schemaVersion: 1, version: release.version, sourceCommit: commit, sourceTag: tag, license: 'MIT', archive, archiveSha256: sha(archiveBytes), files,
    publication: 'prepared-local-only', historyIncluded: false, review: 'Run secret, dependency/license and content review before publication; this export is not an automatic publication approval.'};
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'source-manifest.json'), bytes, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), manifest.archiveSha256 + '  ' + archive + '\n' + sha(bytes) + '  source-manifest.json\n', {flag: 'wx'});
  console.log(JSON.stringify({archive: path.join(output, archive), sourceCommit: commit, sourceTag: tag, files: files.length}));
} catch (error) {
  fs.writeFileSync(path.join(output, 'INCOMPLETE.txt'), 'Source export did not complete. Preserve this directory for inspection.\n', {flag: 'wx'});
  throw error;
}
