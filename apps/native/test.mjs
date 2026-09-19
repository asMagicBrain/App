import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {testRoot} from '../../tools/development-paths.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const runs = path.join(testRoot, 'runs');
fs.mkdirSync(runs, {recursive: true, mode: 0o700});
const run = fs.mkdtempSync(path.join(runs, 'native-unit-'));
const tmp = path.join(run, 'asMagicBrain-Test', 'tmp'); fs.mkdirSync(tmp, {recursive: true, mode: 0o700});
// Closure tests must also work from a fresh checkout without a previous build.
await import('./build-account-config.mjs');
await import('./build-sdk.mjs');
await import('./build-search.mjs');
// Native checks must use the pinned runtime, without a developer Git fallback.
await import('./build-git.mjs');
const files = ['apps/native/native-runtime.test.mjs', 'apps/native/search-runtime.test.mjs', 'apps/native/linux-package-policy.test.mjs', 'apps/native/linux-runtime-temp.test.mjs', 'apps/native/launch.test.mjs', 'apps/native/bundled-docs.test.mjs', 'apps/native/host-bundled-docs.test.mjs', 'apps/native/account-build-config.test.mjs', 'apps/native/external-package.test.mjs', 'apps/native/external-delivery.test.mjs', 'apps/native/external-delivery-verify.test.mjs', 'apps/native/git-runtime.test.mjs', 'apps/native/startup-host.test.mjs', 'apps/native/startup.test.mjs', 'apps/native/build-channel.test.mjs', 'apps/native/main-window.test.mjs', 'apps/native/host-repository-management.test.mjs', 'apps/native/repository-search.test.mjs', 'apps/native/repository-pins.test.mjs', 'apps/native/package-support.test.mjs', 'apps/native/profile-paths.test.mjs', 'apps/native/host-service.test.mjs', 'apps/native/host-create.test.mjs', 'apps/native/host-clone.test.mjs', 'apps/native/host-updates.test.mjs', 'apps/native/host-apply-core.test.mjs', 'apps/native/host-apply-review.test.mjs', 'apps/native/clone-coordinator.test.mjs', 'apps/native/update-coordinator.test.mjs', 'apps/native/apply-coordinator.test.mjs', 'apps/native/account-vault.test.mjs', 'apps/native/github-auth.test.mjs', 'apps/native/application-auth.test.mjs', 'apps/native/application-callback.test.mjs', 'apps/native/github-account-coordinator.test.mjs', 'apps/native/github-registration.test.mjs', 'apps/native/host-rename.test.mjs', 'apps/native/host-assets.test.mjs', 'apps/native/host-operations.test.mjs', 'apps/native/host-external-files.test.mjs', 'apps/native/host-reveal.test.mjs', 'apps/native/renderer/renderer-adapter.test.mjs', 'apps/native/renderer/build-configuration.test.mjs'];
const child = spawn(process.execPath, ['--test', ...files], {cwd: appRoot, env: {PATH: process.env.PATH ?? '/usr/bin:/bin', ASMB_TEST_ROOT: testRoot, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: 'en_US.UTF-8'}, stdio: ['inherit', 'pipe', 'pipe']});
const log = fs.createWriteStream(path.join(run, 'tests.log'), {flags: 'wx'});
child.stdout.on('data', value => {process.stdout.write(value); log.write(value);});
child.stderr.on('data', value => {process.stderr.write(value); log.write(value);});
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('close', code => {log.end(); fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({exitCode: code, tests: files, temporaryDirectory: tmp}, null, 2)+'\n'); console.log(`Native test evidence: ${run}`); process.exitCode = code ?? 1;});
