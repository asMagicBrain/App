import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {parseSync} from '../../ui-workshop/node_modules/oxc-parser/src-js/index.js';
import {resolveBuildConfiguration} from './build-channel.mjs';
import {nativeProfilePaths} from './profile-paths.mjs';

const launchURL = new URL('./launch.mjs', import.meta.url), source = fs.readFileSync(launchURL, 'utf8');
const parsed = parseSync(launchURL.pathname, source); assert.equal(parsed.errors.length, 0);
let executableSource = source;
for (const statement of [...parsed.program.body].reverse()) {
  if (statement.type === 'ImportDeclaration') executableSource = executableSource.slice(0, statement.start) + executableSource.slice(statement.end);
}
executableSource = executableSource.replaceAll('import.meta.url', JSON.stringify(launchURL.href));

function launch({platform, arch, args = []}) {
  const spawned = [], directories = [], testRoot = '/fixture/asMagicBrain-Test', child = new EventEmitter();
  const process = {platform, arch, argv: ['node', '/fixture/launch.mjs', ...args], env: {
    PATH: '/fixture/bin', DISPLAY: ':7', WAYLAND_DISPLAY: 'wayland-7', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
    XDG_CONFIG_HOME: '/fixture/xdg', TMPDIR: '/outside', NODE_OPTIONS: '--require=untrusted', NODE_PATH: '/untrusted', ELECTRON_RUN_AS_NODE: '1',
  }};
  let selected = 0;
  vm.runInNewContext(executableSource, {
    process, path, URL, fileURLToPath, console, testRoot, resolveBuildConfiguration, nativeProfilePaths,
    fs: {existsSync: () => true, mkdirSync: filename => directories.push(filename)},
    runtimeSpec: () => {selected++; return {platform, arch, executable: `.tooling/electron-${platform}-${arch}/${platform === 'linux' ? 'electron' : 'Electron.app/Contents/MacOS/Electron'}`};},
    spawn: (...values) => {spawned.push(values); return child;},
  }, {filename: fileURLToPath(launchURL)});
  return {spawned, directories, testRoot, child, process, selected};
}

test('source launcher selects the Linux runtime, preserves desktop access and removes Node injection overrides', () => {
  const h = launch({platform: 'linux', arch: 'x64'}), [command, args, options] = h.spawned[0];
  assert.equal(h.selected, 1);
  assert.equal(command, fileURLToPath(new URL('../../.tooling/electron-linux-x64/electron', import.meta.url)));
  assert.deepEqual(Array.from(args), [fileURLToPath(new URL('./main.mjs', import.meta.url)), '--channel=development', '--test-data-root=/fixture/asMagicBrain-Test/native-preview/data']);
  assert.equal(options.env.DISPLAY, ':7'); assert.equal(options.env.WAYLAND_DISPLAY, 'wayland-7');
  assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/fixture/bus'); assert.equal(options.env.XDG_CONFIG_HOME, '/fixture/xdg');
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(Object.hasOwn(options.env, name), false);
  assert.equal(options.env.TMPDIR, '/fixture/asMagicBrain-Test/native-preview/tmp');
  assert.ok(!args.includes('--no-sandbox'));
  h.child.emit('exit', 3); assert.equal(h.process.exitCode, 3);
});

test('source launcher keeps macOS runtime selection and requires an isolated preview home', () => {
  const h = launch({platform: 'darwin', arch: 'arm64'});
  assert.match(h.spawned[0][0], /electron-darwin-arm64\/Electron\.app\/Contents\/MacOS\/Electron$/);
  assert.throws(() => launch({platform: 'linux', arch: 'x64', args: ['--channel=preview']}), /explicit --test-user-home/);
  assert.throws(() => launch({platform: 'linux', arch: 'x64', args: ['--no-sandbox']}), /Use launch/);
  const preview = launch({platform: 'linux', arch: 'x64', args: ['--channel=preview', '--test-user-home=/fixture/asMagicBrain-Test/runs/isolated-home']});
  assert.deepEqual(Array.from(preview.spawned[0][1]).slice(1), ['--channel=preview', '--test-user-home=/fixture/asMagicBrain-Test/runs/isolated-home']);
  assert.throws(() => launch({platform: 'linux', arch: 'x64', args: ['--channel=preview', '--test-user-home=/home/person']}), /inside/);
});
