import {build} from '../../ui-workshop/node_modules/vite/dist/node/index.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const appRoot = path.resolve(here, '../..');
if (process.argv.slice(2).some(argument => argument !== '--source-only')) throw Error('Use build.mjs [--source-only].');
const sourceOnly = process.argv.includes('--source-only');
await import('./build-account-config.mjs');
// Host dependency closure is compiled separately; renderer never receives Auth
// SDK code, credentials or tenant configuration. The package manifest hashes it.
await import('./build-sdk.mjs');
await import('./build-offline-reader.mjs');
if (!sourceOnly) {
  await import('./build-search.mjs');
  await import('./build-git.mjs');
}
await build({configFile: false, root: path.join(here, 'renderer'), base: './', envDir: false, envPrefix: 'ASMB_PUBLIC_', cacheDir: path.join(here, '.cache'),
  resolve: {alias: [
    {find: /^react(?=\/|$)/, replacement: path.join(appRoot, 'node_modules/react')},
    {find: /^react-dom(?=\/|$)/, replacement: path.join(appRoot, 'node_modules/react-dom')},
    {find: /^@codemirror\//, replacement: path.join(appRoot, 'node_modules/@codemirror/')},
    {find: /^@lezer\//, replacement: path.join(appRoot, 'node_modules/@lezer/')},
  ], dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view']},
  build: {outDir: path.join(here, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022', reportCompressedSize: false,
    // Native CSP permits same-origin fonts only, including small KaTeX sizes.
    assetsInlineLimit: filePath => /\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined,
  },
});
