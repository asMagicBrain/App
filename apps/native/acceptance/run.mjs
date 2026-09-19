import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (process.argv.length !== 2) throw Error('Native acceptance takes configuration from the documented environment variables.');
const campaigns = process.platform === 'linux'
  ? [['operations.mjs'], ['public-docs.mjs', '--run-isolated'], ['linux-desktop.mjs', '--run-isolated']]
  : process.platform === 'darwin' ? [['operations.mjs'], ['import-modes.mjs']] : null;
if (!campaigns) throw Error('Native acceptance is available on macOS and Linux.');
for (const [file, ...args] of campaigns) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) {process.exitCode = result.status ?? 1; break;}
}
