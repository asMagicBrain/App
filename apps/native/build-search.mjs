import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from '../../ui-workshop/node_modules/vite/dist/node/index.js';
import {searchRuntimeSpec, verifySearchRuntimeBinary} from './search-runtime.mjs';

const here = fileURLToPath(new URL('.', import.meta.url)), root = path.resolve(here, '../..');
const spec = searchRuntimeSpec(), packageName = `@vscode/ripgrep-${spec.platform}-${spec.arch}`;
const binary = path.join(root, 'node_modules', packageName, 'bin/rg');
if (fs.realpathSync(binary) !== binary || !fs.lstatSync(binary).isFile()) throw Error('Physical pinned ripgrep input required.');
for (const name of [spec.package, packageName]) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (metadata.version !== spec.version || metadata.name !== name) throw Error('Unexpected ripgrep package identity.');
}
// Verify the immutable input before executing it; npm_config_arch and PATH do
// not participate in target selection.
const bytes = fs.readFileSync(binary), runtime = verifySearchRuntimeBinary(bytes);
const version = spawnSync(binary, ['--version'], {encoding: 'utf8', timeout: 3000, env: {PATH: '/usr/bin:/bin', LANG: 'C'}});
if (version.status !== 0 || !/^ripgrep 15\.0\.0(?:\s|$)/.test(version.stdout)) throw Error('Unexpected ripgrep binary version.');
await build({configFile: false, root, envDir: false, envPrefix: 'ASMB_PUBLIC_', build: {outDir: path.join(here, 'dist-host'), emptyOutDir: false, sourcemap: false, minify: false, target: 'node24', lib: {entry: path.join(here, 'search-ignore-entry.mjs'), formats: ['es'], fileName: () => 'search-ignore.mjs'}}});
const destination = path.join(here, 'dist-host/rg');
fs.writeFileSync(destination, bytes, {mode: 0o755}); fs.chmodSync(destination, 0o755);
fs.writeFileSync(path.join(here, 'dist-host/search-runtime.json'), JSON.stringify(runtime) + '\n');
