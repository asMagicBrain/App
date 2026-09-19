import fs from 'node:fs';
import {testRoot} from '../../tools/development-paths.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runtimeSpec} from './native-runtime.mjs';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !/^--(platform|arch)=[a-z0-9]+$/.test(arg)) || new Set(args.map(arg => arg.split('=')[0])).size !== args.length) throw Error('Use prepare-runtime.mjs [--platform=linux --arch=x64].');
const options = Object.fromEntries(args.map(arg => arg.slice(2).split('=')));
const spec = runtimeSpec(options);
const destination = path.join(appRoot, '.tooling', `electron-${spec.version}-${spec.platform}-${spec.arch}`);
if (fs.existsSync(destination)) throw Error('Runtime directory already exists. Preserve/review it before preparing another copy.');
const downloads = path.join(testRoot, 'tooling-downloads');
fs.mkdirSync(downloads, {recursive: true, mode: 0o700});
const archive = path.join(downloads, spec.archive);
if (!fs.existsSync(archive)) {
  const response = await fetch(spec.downloadURL);
  if (!response.ok) throw Error(`Runtime download failed (${response.status}).`);
  const temporary = `${archive}.${process.pid}.part`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {for await (const bytes of response.body) fs.writeSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  const actual = createHash('sha256').update(fs.readFileSync(temporary)).digest('hex');
  if (actual !== spec.archiveSha256) throw Error(`Runtime checksum mismatch; partial file retained at ${temporary}.`);
  fs.renameSync(temporary, archive);
}
if (!fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink() || createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== spec.archiveSha256) throw Error('Cached runtime checksum mismatch.');
const listing = spawnSync('/usr/bin/unzip', ['-Z1', archive], {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
if (listing.status !== 0 || listing.stdout.trim().split('\n').some(name => name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..'))) throw Error('Unsafe or unreadable Electron archive members.');
fs.mkdirSync(destination, {recursive: true, mode: 0o700});
const result = process.platform === 'darwin' && spec.platform === 'darwin'
  ? spawnSync('/usr/bin/ditto', ['-x', '-k', archive, destination], {stdio: 'inherit'})
  : spawnSync('/usr/bin/unzip', ['-q', archive, '-d', destination], {stdio: 'inherit'});
if (result.status !== 0) throw Error('Runtime extraction failed; partial directory retained for inspection.');
if (fs.readFileSync(path.join(destination, 'version'), 'utf8').trim() !== spec.version || !fs.lstatSync(path.join(appRoot, spec.executable)).isFile()) throw Error('Extracted runtime identity mismatch.');
console.log(`Prepared Electron ${spec.version} ${spec.platform}-${spec.arch}; official pinned SHA-256 verified. Native execution is a separate check.`);
