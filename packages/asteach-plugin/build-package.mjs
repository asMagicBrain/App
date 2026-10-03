import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPluginPackage,inspectPluginPackage} from '../../packages/desktop-host/src/plugin-packages/format.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const bytes=createPluginPackage({manifest,compression:'store',resources:[{path:'content/about.txt',bytes:fs.readFileSync(path.join(root,'about.txt'))}]});
const output=path.resolve(process.argv[2] ?? (()=>{throw Error('Provide an output path inside the test workspace');})());
fs.writeFileSync(output,bytes,{mode:0o644});
const inspected=inspectPluginPackage(bytes);
console.log(JSON.stringify({output,digest:inspected.digest,bytes:bytes.length},null,2));
