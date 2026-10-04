import fs from 'node:fs';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function chineseFontAssets(){
 const root=new URL('./',import.meta.url),provenance=JSON.parse(fs.readFileSync(new URL('provenance.json',root),'utf8'));
 const assets=Object.entries(provenance.files).map(([name,hash])=>{const bytes=fs.readFileSync(new URL(name,root));if(sha(bytes)!==hash)throw Error('Chinese font bytes differ from pinned provenance.');return {path:'reader-assets/cjk/'+name,base64:bytes.toString('base64')};});
 const license=fs.readFileSync(new URL('MiSans-LICENSE.txt',root));if(sha(license)!==provenance.licenseSha256)throw Error('Chinese font licence differs from pinned provenance.');
 const css=fs.readFileSync(new URL('cjk-fonts.css',root),'utf8').split('/*')[0].replaceAll("url('./","url('reader-assets/cjk/");
 return {assets,license:license.toString('utf8'),css};
}
