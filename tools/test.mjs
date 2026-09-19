import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appRoot, testRoot} from './development-paths.mjs';

const runs = path.join(testRoot, 'runs');
fs.mkdirSync(runs, {recursive: true, mode: 0o700});
const run = fs.mkdtempSync(path.join(runs, 'source-unit-'));
const temporary = path.join(run, 'tmp');
fs.mkdirSync(temporary, {mode: 0o700});
const files = ['tools', 'ui-workshop/tests', 'ui-workshop/.storybook', 'packages/desktop-host/tests', 'packages/source-foundation/tests']
  .flatMap(directory => fs.readdirSync(path.join(appRoot, directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(directory, name)))
  .concat(['apps/native/account-build-config.test.mjs', 'apps/native/application-auth.test.mjs']);
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: appRoot, env: {...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary},
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
fs.writeFileSync(path.join(run, 'tests.log'), (result.stdout ?? '') + (result.stderr ?? ''));
fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({exitCode: result.status, tests: files, temporaryDirectory: temporary}, null, 2) + '\n');
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
console.log(`Source test evidence: ${run}`);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
