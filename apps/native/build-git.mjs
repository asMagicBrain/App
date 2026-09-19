import path from 'node:path';
import {testRoot} from '../../tools/development-paths.mjs';
import {fileURLToPath} from 'node:url';
import {prepareGitRuntime} from './git-runtime.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
await prepareGitRuntime({destination: path.join(here, 'dist-host/git'), downloads: path.join(testRoot, 'tooling-downloads'), allowDownload: false});
