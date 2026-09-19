import {spawnSync} from 'node:child_process';
import {appRoot} from './development-paths.mjs';

// This builds shared JavaScript and the UI. Platform runtime preparation and
// native qualification are explicit, separate platform commands.
for (const args of [['apps/native/build.mjs', '--source-only'], ['ui-workshop/.storybook/run.mjs', 'build']]) {
  const result = spawnSync(process.execPath, args, {cwd: appRoot, stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) {process.exitCode = result.status ?? 1; break;}
}
