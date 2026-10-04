/** Acquire unmodified MiSans from Xiaomi; do not redistribute standalone fonts in source. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../apps/desktop/ui/fonts/',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const provenance=JSON.parse(await fs.readFile(path.join(root,'provenance.json'),'utf8'));
export function selectedFontMembers(bytes,archive){
 if(bytes.length!==archive.bytes||hash(bytes)!==archive.sha256)throw Error('Official font archive differs from pinned provenance.');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw Error('Unsupported font archive.');
 const count=bytes.readUInt16LE(end+10),central=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
 if(count>5000||central+size!==end)throw Error('Invalid font archive directory.');
 const wanted=new Map(Object.entries(archive.members).map(([out,member])=>[member,out])),result=new Map();let cursor=central;
 for(let i=0;i<count;i++){
  if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw Error('Invalid font member directory.');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),expanded=bytes.readUInt32LE(cursor+24),namesize=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
  const next=cursor+46+namesize+extra+comment;if(next>end)throw Error('Invalid font member name.');const name=bytes.subarray(cursor+46,cursor+46+namesize).toString('utf8');cursor=next;
  if(!wanted.has(name))continue;
  const output=wanted.get(name);if(result.has(output)||flags&1||expanded>16*1024*1024||offset+30>central||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Unsafe font member.');
  const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+compressed>central)throw Error('Truncated font member.');
  const packed=bytes.subarray(start,start+compressed),value=method===0?Buffer.from(packed):method===8?inflateRawSync(packed,{maxOutputLength:16*1024*1024}):null;
  if(!value||value.length!==expanded||hash(value)!==provenance.files[output])throw Error('Font member differs from pinned provenance.');result.set(output,value);
 }
 if(cursor!==end||result.size!==wanted.size)throw Error('Missing or duplicate font members.');return result;
}
async function physicalFile(filename){const st=await fs.lstat(filename);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>256*1024*1024)throw Error('Font input must be an ordinary bounded file.');return fs.readFile(filename);}
export async function checkChineseFonts(){
 const license=await physicalFile(path.join(root,'MiSans-LICENSE.txt'));if(hash(license)!==provenance.licenseSha256)throw Error('Font licence differs from provenance.');
 for(const [name,pin]of Object.entries(provenance.files)){let bytes;try{bytes=await physicalFile(path.join(root,name));}catch(e){if(e.code==='ENOENT')throw Error('MiSans build inputs missing. Run npm run fonts -- --download, or --archives=/physical/directory.');throw e;}if(hash(bytes)!==pin)throw Error('MiSans build input changed: '+name);}
}
async function download(archive,directory){
 const filename=path.join(directory,archive.filename);try{const bytes=await physicalFile(filename);if(bytes.length===archive.bytes&&hash(bytes)===archive.sha256)return bytes;throw Error('Preserve changed font cache; select a new directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const response=await fetch(archive.url,{redirect:'error',signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('Official font download failed: '+response.status);
 const partial=filename+'.partial-'+randomUUID();const handle=await fs.open(partial,'wx',0o600);let total=0;const digest=createHash('sha256');try{for await(const chunk of response.body){total+=chunk.length;if(total>archive.bytes)throw Error('Font download exceeds pinned size.');digest.update(chunk);await handle.writeFile(chunk);}await handle.sync();}finally{await handle.close();}
 if(total!==archive.bytes||digest.digest('hex')!==archive.sha256)throw Error('Official download changed; retain partial and review new provenance.');await fs.rename(partial,filename);return physicalFile(filename);
}
export async function prepareChineseFonts({archives,downloadAllowed=false}={}){
 const directory=path.resolve(archives??path.join((await import('./development-paths.mjs')).testRoot,'downloads/misans-pinned'));
 await fs.mkdir(directory,{recursive:true,mode:0o700});if(await fs.realpath(directory)!==directory)throw Error('Use a physical font-cache directory.');
 for(const archive of provenance.archives){const bytes=downloadAllowed?await download(archive,directory):await physicalFile(path.join(directory,archive.filename));for(const[name,value]of selectedFontMembers(bytes,archive)){
  const dest=path.join(root,name);try{const existing=await physicalFile(dest);if(hash(existing)!==hash(value))throw Error('Preserve changed font input: '+name);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
  const partial=dest+'.partial-'+randomUUID();await fs.writeFile(partial,value,{flag:'wx',mode:0o644});await fs.rename(partial,dest);
 }}await checkChineseFonts();
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);if(args.some(a=>a!=='--check'&&a!=='--download'&&!a.startsWith('--archives='))||args.includes('--check')&&args.length>1)throw Error('Use --check, --download, or --archives=/physical/directory.');
 if(args.includes('--check'))await checkChineseFonts();else await prepareChineseFonts({archives:args.find(a=>a.startsWith('--archives='))?.slice(11),downloadAllowed:args.includes('--download')});console.log('MiSans inputs match official pinned provenance.');
}
