import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workshop = fileURLToPath(new URL('../', import.meta.url));
const app = path.dirname(workshop.replace(/\/$/, ''));
const mode = process.argv[2];
if (process.argv.length !== 3 || !['serve', 'build', 'typecheck'].includes(mode)) {
  throw Error('Use npm run storybook, build-storybook or typecheck.');
}
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin',
  STORYBOOK_DISABLE_TELEMETRY: '1', CI: 'true',
  NODE_DISABLE_COMPILE_CACHE: '1',
  XDG_CACHE_HOME: path.join(workshop, '.cache') };
for (const key of ['TMPDIR', 'TEMP', 'TMP', 'TERM', 'LANG', 'LC_ALL', 'ASMB_TEST_ROOT']) {
  if (process.env[key]) env[key] = process.env[key];
}
// Do not inherit NODE_OPTIONS, STORYBOOK_ENABLE_CRASH_REPORTS, telemetry debug,
// arbitrary build-time variables, credentials, or a browser-opening command.
let entry, args;
if (mode === 'typecheck') {
  entry = path.join(app, 'node_modules/typescript/bin/tsc');
  args = ['--noEmit', '--project', path.join(workshop, 'tsconfig.json')];
} else {
  const packageRoot = path.join(workshop, 'node_modules/storybook');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== '10.6.0' || manifest.bin !== './dist/bin/dispatcher.js') throw Error('Unexpected Storybook CLI.');
  entry = path.resolve(packageRoot, manifest.bin);
  if (!entry.startsWith(packageRoot + path.sep)) throw Error('Unexpected Storybook CLI path.');
  args = ['build', '--disable-telemetry', '--output-dir', path.join(workshop, 'storybook-static')];
}
let child, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
function run(script, scriptArgs, onSuccess, runtimeEnv = env) {
  child = spawn(process.execPath, [script, ...scriptArgs], { cwd: workshop, env: runtimeEnv, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (code === 0 && !signal && !stopping && onSuccess) onSuccess();
    else process.exitCode = code ?? 1;
  });
}
// Static build mode has no runtime-instance registry or live dev server.
run(entry, args, mode === 'serve'
  ? () => run(path.join(workshop, '.storybook/static-server.mjs'), [], undefined,
    process.env.ASMB_TEACH_REFERENCE_ROOT ? { ...env, ASMB_TEACH_REFERENCE_ROOT: process.env.ASMB_TEACH_REFERENCE_ROOT } : env) : undefined);
