import path from 'node:path';
import {testRoot} from '../../tools/development-paths.mjs';
import {fileURLToPath} from 'node:url';
import {prepareGitRuntime} from './git-runtime.mjs';

if (process.argv.slice(2).join(' ') !== '--download') throw Error('Use prepare-git.mjs --download to acquire the exact pinned Git distribution and source archives.');
const here = fileURLToPath(new URL('.', import.meta.url));
const runtime = await prepareGitRuntime({destination: path.join(here, 'dist-host/git'), downloads: path.join(testRoot, 'tooling-downloads'), allowDownload: true});
console.log(JSON.stringify({gitVersion: runtime.gitVersion, release: runtime.release, manifestSha256: runtime.manifestSha256}));
