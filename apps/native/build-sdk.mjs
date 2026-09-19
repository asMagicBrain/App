import {build} from '../../ui-workshop/node_modules/vite/dist/node/index.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const appRoot = path.resolve(here, '../..');
// Official SDK is a separate host artifact. Renderer code never imports it.
await build({configFile: false, root: appRoot, envDir: false, envPrefix: 'ASMB_PUBLIC_',
  // Other verified host assets share this directory. Rebuild only this SDK;
  // do not remove the Git runtime while source tools may still be using it.
  build: {outDir: path.join(here, 'dist-host'), emptyOutDir: false, sourcemap: false, minify: false, target: 'node24',
    lib: {entry: path.join(here, 'application-sdk-entry.mjs'), formats: ['es'], fileName: () => 'application-sdk.mjs'},
  },
});
