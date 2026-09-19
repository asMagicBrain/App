import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {appRoot} from './development-paths.mjs';

// The workshop has its own reviewed lockfile. Install it whenever the root is
// installed, so one npm ci prepares the complete source toolchain.
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required.');
const executable = process.env.npm_execpath;
if (!executable) throw Error('Run npm run bootstrap (or npm ci) from the source root.');
const result = spawnSync(process.execPath, [executable, 'ci', '--no-audit', '--no-fund'], {
  cwd: path.join(appRoot, 'ui-workshop'), stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
