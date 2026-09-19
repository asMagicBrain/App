import {gitExecutable, gitEnvironment} from './git-executable.mjs';
import { lstat, readdir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {createRepositoryCatalog} from './repository-import/index.mjs';
import {isPortableRelativePath} from '../../source-foundation/src/domain/path-policy.mjs';
const execute = promisify(execFile);
const maxText = 1024 * 1024;
export const MAX_REPOSITORY_ASSET_BYTES = 64 * 1024 * 1024;
const assetTypes = Object.freeze({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.webm':'video/webm','.mp4':'video/mp4'});
const assetFailure = code => {throw Object.assign(new Error(code), {code});};
const sameFile = (a,b) => ['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
function assetPath(relative) {
  return typeof relative==='string'&&relative.isWellFormed()&&isPortableRelativePath(relative)&&relative.split('/').length<=32&&!relative.split('/').some(segment=>segment.toLowerCase()==='.asmagicbrain'||segment.toLowerCase().startsWith('.asmb-'));
}
function assetSignature(bytes,mime) {
  if(mime==='image/png')return bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR';
  if(mime==='image/jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==='image/gif')return bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
  if(mime==='image/webp')return bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length;
  if(mime==='video/webm')return bytes.length>=8&&bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  if(mime==='video/mp4')return bytes.length>=16&&bytes.toString('ascii',4,8)==='ftyp'&&bytes.readUInt32BE(0)>=16&&bytes.readUInt32BE(0)<=bytes.length;
  return false;
}
async function safePath(root, relative) {
  if (typeof relative !== 'string' || /[\\\0]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(p=>p==='..'||p==='.'||p.toLowerCase()==='.git')) throw Error('Invalid path');
  let current = root;
  for (const segment of relative ? relative.split('/') : []) {
    if (!segment) throw Error('Invalid path');
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw Error('Symbolic links are unavailable');
  }
  if (await realpath(current) !== current) throw Error('Invalid path');
  return current;
}
async function textFile(root, relative) {
  const filename = await safePath(root,relative);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size > maxText) return null;
  const handle = await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    if(before.ino!==stat.ino||before.dev!==stat.dev||before.size>maxText)return null;
    const buffer=Buffer.alloc(maxText+1);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    const after=await handle.stat();
    if(bytesRead!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||await safePath(root,relative)!==filename)return null;
    const bytes=buffer.subarray(0,bytesRead);
    if(bytes.length>maxText||bytes.includes(0))return null;
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  } catch { return null; } finally { await handle.close(); }
}
async function git(root,args,raw=false,maxBuffer=2*1024*1024) {
  try {
    const gitDir=await lstat(path.join(root,'.git'));
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) return '';  const result = await execute(gitExecutable(),['--no-pager','--literal-pathspecs','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.interactive=false','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:raw==='buffer'?null:'utf8',timeout:5000,maxBuffer,env:gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''})}); return raw ? result.stdout : result.stdout.trim(); } catch (error) { if(raw||(typeof error.code==='string'&&error.code.startsWith('GIT_RUNTIME_')))throw error; return ''; }
}
/** Read-only managed media. No HTML, arbitrary filesystem roots, URLs, or decoding
 * authority crosses this boundary. The renderer owns and retires its Blob URL. */
export async function readLocalRepositoryAsset(name,relative,base,revision='',options={}) {
  if(!assetPath(relative))assetFailure('INVALID_PATH');
  if(typeof revision!=='string'||revision.length>1024||!revision.isWellFormed()||/[\x00-\x1f\x7f]/.test(revision))assetFailure('INVALID_REF');
  const mime=assetTypes[path.extname(relative).toLowerCase()];if(!mime)assetFailure('UNSUPPORTED_ASSET');
  const catalog=createRepositoryCatalog(path.resolve(base),options);catalog.assertKnown(name);
  const root=path.resolve(base,name),rootStat=await lstat(root,{bigint:true});
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await realpath(root)!==root)assetFailure('INVALID_PATH');
  let bytes;
  if(revision){
    const refs=(await git(root,['for-each-ref','--format=%(refname)','refs/heads/','refs/tags/'])).split('\n').filter(Boolean);
    if(!/^refs\/(heads|tags)\//.test(revision)||!refs.includes(revision))assetFailure('INVALID_REF');
    const oid=await git(root,['rev-parse','--verify',`${revision}^{commit}`]);if(!/^[a-f0-9]{40,64}$/.test(oid))assetFailure('INVALID_REF');
    let selected={type:'tree',sha:oid,mode:'040000'};
    for(const segment of relative.split('/')){
      if(selected.type!=='tree')assetFailure('UNSUPPORTED_ASSET');
      const entries=(await git(root,['ls-tree','-z',selected.sha],true)).split('\0').filter(Boolean).map(record=>{const tab=record.indexOf('\t'),[mode,type,sha]=record.slice(0,tab).split(' ');return {mode,type,sha,name:record.slice(tab+1)};});
      selected=entries.find(entry=>entry.name===segment);
      if(!selected||!['040000','100644','100755'].includes(selected.mode))assetFailure('UNSUPPORTED_ASSET');
    }
    if(selected.type!=='blob')assetFailure('UNSUPPORTED_ASSET');
    const size=Number(await git(root,['cat-file','-s',selected.sha]));
    if(!Number.isSafeInteger(size)||size<1||size>MAX_REPOSITORY_ASSET_BYTES)assetFailure('ASSET_TOO_LARGE');
    bytes=await git(root,['cat-file','blob',selected.sha],'buffer',MAX_REPOSITORY_ASSET_BYTES+1);
    if(!Buffer.isBuffer(bytes)||bytes.length!==size)assetFailure('CONFLICT');
  }else{
    const filename=await safePath(root,relative),before=await lstat(filename,{bigint:true});
    if(!before.isFile()||before.nlink!==1n)assetFailure('UNSUPPORTED_ASSET');
    if(before.size>BigInt(MAX_REPOSITORY_ASSET_BYTES))assetFailure('ASSET_TOO_LARGE');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      if(!sameFile(before,await handle.stat({bigint:true})))assetFailure('CONFLICT');
      bytes=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,Math.min(64*1024,bytes.length-offset),offset);if(!bytesRead)assetFailure('CONFLICT');offset+=bytesRead;}
      if(!sameFile(before,await handle.stat({bigint:true}))||await safePath(root,relative)!==filename||!sameFile(before,await lstat(filename,{bigint:true})))assetFailure('CONFLICT');
    }finally{await handle.close();}
  }
  const afterRoot=await lstat(root,{bigint:true});if(afterRoot.dev!==rootStat.dev||afterRoot.ino!==rootStat.ino||await realpath(root)!==root)assetFailure('CONFLICT');catalog.assertKnown(name);
  if(!assetSignature(bytes,mime))assetFailure('UNSUPPORTED_ASSET');
  return {mime,data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
}
function commitLog(root,revision,relative='') {
  // The repository root shows its tip; a selected path shows its own last change.
  return git(root,['log','-1','--format=%an%x00%s%x00%h%x00%cI',revision,...(relative?['--',relative]:[])]);
}
export async function readLocalRepository(name, relative='', base, revision='', options={}) {
  createRepositoryCatalog(path.resolve(base),options).assertKnown(name);
  const root=path.resolve(base,name);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root)!==root) throw Error('Invalid repository');
  if (revision) return readRevision(root,name,relative,revision);
  const target=await safePath(root,relative), stat=await lstat(target);
  if(!stat.isDirectory()&&!stat.isFile())throw Error('Unavailable entry');
  const [branch,branchText,tagText,count,head,people] = await Promise.all([
    git(root,['symbolic-ref','--short','HEAD']),git(root,['branch','--format=%(refname:short)']),git(root,['tag','--list']),git(root,['rev-list','--count','HEAD']),commitLog(root,'HEAD',relative),git(root,['log','--format=%an'])]);
  const parseCommit=value=>{if(!value)return null;const [author,message,sha,date]=value.split('\0');return {author,message,sha,date};};
  const commit=parseCommit(head);
  const entries=[];
  if(stat.isDirectory()) {
    for (const entry of await readdir(target,{withFileTypes:true})) {
      if(entry.name.toLowerCase()==='.git'||entry.name.toLowerCase()==='.asmagicbrain'||entry.name.toLowerCase().startsWith('.asmb-')||entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))continue;
      const entryPath=relative?`${relative}/${entry.name}`:entry.name;
      const last=parseCommit(await commitLog(root,'HEAD',entryPath));
      entries.push({name:entry.name,path:entryPath,type:entry.isDirectory()?'directory':'file',message:last?.message??'',date:last?.date??''});
    }
    entries.sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name));
  }
  const readmeEntry=entries.find(e=>e.type==='file'&&/^readme(?:\.md|\.markdown|\.txt)?$/i.test(e.name));
  const licenseEntry=entries.find(e=>e.type==='file'&&/^(?:license|licence)(?:\.md|\.txt)?$/i.test(e.name));
  return {name,selectedRef:'',revisionName:branch||'main',revisionKind:'worktree',type:stat.isDirectory()?'directory':'file',readmePath:readmeEntry?.path??null,licensePath:licenseEntry?.path??null,branch:branch||'main',branches:branchText?branchText.split('\n'):[],tags:tagText?tagText.split('\n'):[],commitCount:Number(count)||0,commit,entries,readme:readmeEntry?await textFile(root,readmeEntry.path):null,license:licenseEntry?await textFile(root,licenseEntry.path):null,content:stat.isFile()?await textFile(root,relative):null,contributors:[...new Set(people.split('\n').filter(Boolean))],languages:[]};
}

async function readRevision(root,name,relative,revision) {
  if (typeof relative!=='string'||/[\\\0]/.test(relative)||path.isAbsolute(relative)||relative.split('/').some(p=>p==='..'||p==='.'||p.toLowerCase()==='.git')||(relative&&relative.split('/').some(p=>!p)))throw Error('Invalid path');
  const refs=(await git(root,['for-each-ref','--format=%(refname)','refs/heads/','refs/tags/'])).split('\n').filter(Boolean);
  if(!refs.includes(revision)||!/^refs\/(heads|tags)\//.test(revision))throw Error('Unknown revision');
  const oid=await git(root,['rev-parse','--verify',`${revision}^{commit}`]);
  if(!/^[a-f0-9]{40,64}$/.test(oid))throw Error('Unavailable revision');
  const tree=async object=> (await git(root,['ls-tree','-z',object],true)).split('\0').filter(Boolean).map(record=>{
    const tab=record.indexOf('\t');const [mode,type,sha]=record.slice(0,tab).split(' ');return {mode,type,sha,name:record.slice(tab+1)};
  });
  let selected={type:'tree',sha:oid,mode:'040000'};
  for(const segment of relative?relative.split('/'):[]) {
    if(selected.type!=='tree')throw Error('Invalid path');
    selected=(await tree(selected.sha)).find(entry=>entry.name===segment);
    if(!selected||!['040000','100644','100755'].includes(selected.mode))throw Error('Unavailable entry');
  }
  const blobText=async sha=>{
    const size=Number(await git(root,['cat-file','-s',sha]));
    if(!Number.isFinite(size)||size>maxText)return null;
    const value=await git(root,['cat-file','blob',sha],'buffer');
    if(!Buffer.isBuffer(value)||value.length!==size||value.includes(0))return null;
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}catch{return null;}
  };
  const parseCommit=value=>{if(!value)return null;const [author,message,sha,date]=value.split('\0');return {author,message,sha,date};};
  const [branch,count,head,people]=await Promise.all([git(root,['symbolic-ref','--short','HEAD']),git(root,['rev-list','--count',oid]),commitLog(root,oid,relative),git(root,['log','--format=%an',oid])]);
  const rawEntries=selected.type==='tree'?(await tree(selected.sha)).filter(e=>['040000','100644','100755'].includes(e.mode)&&e.name.toLowerCase()!=='.git'):[];
  const entries=[];
  for(const entry of rawEntries){
    const entryPath=relative?`${relative}/${entry.name}`:entry.name;
    const last=parseCommit(await commitLog(root,oid,entryPath));
    entries.push({name:entry.name,path:entryPath,type:entry.type==='tree'?'directory':'file',message:last?.message??'',date:last?.date??''});
  }
  entries.sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name));
  const readmeEntry=rawEntries.find(e=>e.type==='blob'&&/^readme(?:\.md|\.markdown|\.txt)?$/i.test(e.name));
  const licenseEntry=rawEntries.find(e=>e.type==='blob'&&/^(?:license|licence)(?:\.md|\.txt)?$/i.test(e.name));
  const entryPath=entry=>entry?(relative?`${relative}/${entry.name}`:entry.name):null;
  return {name,type:selected.type==='tree'?'directory':'file',selectedRef:revision,revisionName:revision.replace(/^refs\/(heads|tags)\//,''),revisionKind:revision.startsWith('refs/heads/')?'branch':'tag',branch:branch||'main',branches:refs.filter(r=>r.startsWith('refs/heads/')).map(r=>r.slice(11)),tags:refs.filter(r=>r.startsWith('refs/tags/')).map(r=>r.slice(10)),commitCount:Number(count)||0,commit:parseCommit(head),entries,readmePath:entryPath(readmeEntry),licensePath:entryPath(licenseEntry),readme:readmeEntry?await blobText(readmeEntry.sha):null,license:licenseEntry?await blobText(licenseEntry.sha):null,content:selected.type==='blob'?await blobText(selected.sha):null,contributors:[...new Set(people.split('\n').filter(Boolean))],languages:[]};
}
