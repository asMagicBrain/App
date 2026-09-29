import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../../ui-workshop/node_modules/vite/dist/node/index.js';
import {loadOfflineAssets} from '../../packages/desktop-host/src/package-exchange/offline-assets.mjs';
const here=fileURLToPath(new URL('.',import.meta.url)),root=path.resolve(here,'../..');
const assets=loadOfflineAssets();
await build({configFile:false,root,envDir:false,envPrefix:'ASMB_PUBLIC_',define:{__ASMB_READER_ASSETS__:JSON.stringify(assets)},
 build:{outDir:path.join(here,'dist-host'),emptyOutDir:false,sourcemap:false,minify:false,target:'node24',lib:{entry:path.join(here,'offline-reader-entry.mjs'),formats:['es'],fileName:()=> 'offline-reader.mjs'},rollupOptions:{external:[/^node:/]}}});
