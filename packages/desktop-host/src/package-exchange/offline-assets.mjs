import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
export const KATEX_READER_CSS='reader-assets/katex/katex.min.css';

/** Build/source-test input only. The native build embeds these exact bytes;
 * its compiled renderer never discovers packages or reads runtime assets. */
export function loadOfflineAssets({katexRoot=path.dirname(require.resolve('katex/package.json'))}={}){
  const css=fs.readFileSync(path.join(katexRoot,'dist/katex.min.css'));
  const text=css.toString('utf8'),references=[...text.matchAll(/url\(([^)]+)\)/g)].map(match=>match[1].replace(/^['"]|['"]$/g,''));
  if(!references.length||/@import\b/i.test(text)||references.some(value=>!/^fonts\/KaTeX_[A-Za-z0-9-]+\.(?:woff2?|ttf)$/.test(value)))throw Error('Unexpected offline KaTeX asset reference');
  const assets=[{path:KATEX_READER_CSS,base64:css.toString('base64')}];
  for(const relative of [...new Set(references)].sort()){
    const bytes=fs.readFileSync(path.join(katexRoot,'dist',relative));
    if(!bytes.length)throw Error(`Empty offline KaTeX asset: ${relative}`);
    assets.push({path:'reader-assets/katex/'+relative,base64:bytes.toString('base64')});
  }
  const notices=['markdown-it','katex'].map(name=>{
    const directory=name==='katex'?katexRoot:path.dirname(require.resolve(name+'/package.json'));
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
    const license=fs.readdirSync(directory).find(value=>/^licen[cs]e(?:\.|$)/i.test(value));
    if(!license)throw Error(`Missing offline reader notice for ${name}`);
    return `${name} ${manifest.version}\n${fs.readFileSync(path.join(directory,license),'utf8')}`;
  });
  const fontNotice=fs.readFileSync(new URL('./offline-font-license.txt',import.meta.url),'utf8');
  if(!fontNotice.includes('SIL OPEN FONT LICENSE Version 1.1'))throw Error('Missing offline font license');
  notices.push(fontNotice);
  return {assets,notices:notices.join('\n\n')};
}
