import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pinDirectory,checkDirectory,checkSourceSpelling,contains} from '../physical-roots.mjs';
import {assertOutsideGit} from '../private-store.mjs';
import {isPortableRelativePath,portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';
import {hashRawFile,openRawFile} from './raw-file.mjs';

const MAX_FILE=4*1024*1024,MAX_OUTPUT=16*1024*1024,MAX_FILES=10000,MAX_SELECTED=256;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exists=filename=>{try{return fs.lstatSync(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const oid=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=bytes=>{if(bytes===null||bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return null;}};
const records=bytes=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).split('\0').filter(Boolean);}catch{fail('UNSUPPORTED_FILENAME');}};
function syncDirectory(directory){const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeExclusive(filename,bytes){const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(filename));}

/** Trusted host factory. Roots, executable and hooks are never renderer inputs.
 * Git touches only local objects/index/refs; source bytes and private drafts are not written.
 */
export function createLocalGit({sourceRoot,privateRoot,sourceBindingRoot,hooks={}}){
 const source=pinDirectory(sourceRoot),privatePin=pinDirectory(privateRoot);
 if(contains(source.path,privatePin.path)||contains(privatePin.path,source.path))fail('INVALID_PRIVATE_ROOT');
 assertOutsideGit(privatePin.path);
 if((fs.statSync(privateRoot).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');
 const executable=fs.statSync(gitExecutable());if(!executable.isFile())fail('GIT_UNAVAILABLE');
 const gitPath=path.join(source.path,'.git'),journalPath=path.join(privatePin.path,'pending.json');
 let gitPin=null,serial=Promise.resolve();
 const queued=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
 if(sourceBindingRoot!==undefined&&(typeof sourceBindingRoot!=='string'||!path.isAbsolute(sourceBindingRoot)||path.normalize(sourceBindingRoot)!==sourceBindingRoot))fail('INVALID_IDENTITY');
 const binding={sourceRoot:sourceBindingRoot??source.path,sourceIdentity:source.identity};
 const bindingPath=path.join(privatePin.path,'binding.json'),bindingBytes=Buffer.from(JSON.stringify(binding));
 if(exists(bindingPath)){const recorded=readBytes(bindingPath);if(!recorded.equals(bindingBytes))fail('RECOVERY_REQUIRED');}else writeExclusive(bindingPath,bindingBytes);
 function check(){checkDirectory(source);checkDirectory(privatePin);assertOutsideGit(privatePin.path);if((fs.statSync(privatePin.path).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');}
 function safe(relative){
  if(!isPortableRelativePath(relative)||!relative.isWellFormed()||relative.split('/').some(part=>part.toLowerCase()==='.asmagicbrain'||part.toLowerCase().startsWith('.asmb-')))fail('INVALID_PATH');
  return relative;
 }
 function gitDirectory(){
  check();const stat=exists(gitPath);if(!stat)return false;
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSUPPORTED_GIT_DIRECTORY');
  if(gitPin)checkDirectory(gitPin);else gitPin=pinDirectory(gitPath);
  let count=0;
  const walk=directory=>{for(const name of fs.readdirSync(directory)){if(++count>100000)fail('LIMIT_EXCEEDED');const target=path.join(directory,name),item=fs.lstatSync(target);if(item.isSymbolicLink()||(!item.isDirectory()&&!item.isFile()))fail('UNSAFE_GIT_METADATA');if(item.isDirectory())walk(target);}};
  walk(gitPath);
  for(const name of ['commondir','objects/info/alternates','objects/info/http-alternates','shallow'])if(exists(path.join(gitPath,name)))fail('UNSUPPORTED_GIT_DIRECTORY');
  return true;
 }
 function run(args,{input,env={},allow=[0],initializing=false}={}){
  check();const currentExecutable=fs.statSync(gitExecutable());if(currentExecutable.dev!==executable.dev||currentExecutable.ino!==executable.ino)fail('GIT_EXECUTABLE_CHANGED');if(!initializing&&!gitDirectory())fail('GIT_NOT_INITIALIZED');
  const argsPrefix=['--no-pager',...(args[0]==='check-ignore'?[]:['--literal-pathspecs']),'--no-replace-objects','-c','credential.helper=','-c','credential.interactive=false','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.splitIndex=false','-c','core.pager=cat','-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never'];
  if(!initializing)argsPrefix.push(`--git-dir=${gitPath}`,`--work-tree=${source.path}`);
  const cleanEnv=gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_ALLOW_PROTOCOL:'',...env});
  const streaming=input&&typeof input.pipe==='function';let child;
  const completion=new Promise((resolve,reject)=>{
   child=execFile(gitExecutable(),[...argsPrefix,...args],{cwd:source.path,env:cleanEnv,encoding:'buffer',timeout:streaming?0:15000,maxBuffer:MAX_OUTPUT},(error,stdout)=>{
    const code=error?.code??0;
    if(!allow.includes(code)){reject(Object.assign(new Error(error?.killed?'GIT_TIMEOUT':'GIT_FAILED'),{code:error?.killed?'GIT_TIMEOUT':'GIT_FAILED'}));return;}
    try{check();resolve({bytes:stdout,code});}catch(failure){reject(failure);}
   });
  });
  child.stdin.on('error',()=>{});
  const transfer=streaming?pipeline(input,child.stdin):Promise.resolve(child.stdin.end(input));
  return Promise.allSettled([completion,transfer]).then(results=>{const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;return results[0].value;});
 }
 async function string(args,options){return (await run(args,options)).bytes.toString('utf8').trim();}
 function readBytes(filename,limit=MAX_OUTPUT){
  const stat=exists(filename);if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)fail('UNSAFE_FILE');
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const before=fs.fstatSync(fd);if(before.dev!==stat.dev||before.ino!==stat.ino||before.size>limit)fail('CONFLICT');const buffer=Buffer.alloc(before.size+1);let count=0;while(count<buffer.length){const read=fs.readSync(fd,buffer,count,buffer.length-count,count);if(!read)break;count+=read;}const bytes=buffer.subarray(0,count),after=fs.fstatSync(fd),live=fs.lstatSync(filename);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||live.dev!==before.dev||live.ino!==before.ino)fail('CONFLICT');return bytes;}finally{fs.closeSync(fd);}
 }
 function sourceFile(relative){
  check();safe(relative);
  try{checkSourceSpelling(source.path,relative);}catch(error){if(error.code==='PARTIAL'||error.code==='ENOENT')return {bytes:null,hash:null,mode:null};throw error;}
  const filename=path.join(source.path,relative),bytes=readBytes(filename,MAX_FILE),stat=fs.lstatSync(filename);
  check();return {bytes,hash:hash(bytes),mode:stat.mode&0o111?'100755':'100644'};
 }
 function sourceDigest(relative,objectFormat){
  check();safe(relative);
  try{checkSourceSpelling(source.path,relative);}catch(error){if(error.code==='PARTIAL'||error.code==='ENOENT')return {hash:null,sha:null,mode:null};throw error;}
  const file=hashRawFile(path.join(source.path,relative),{objectFormat,limit:Number.MAX_SAFE_INTEGER});
  check();checkSourceSpelling(source.path,relative);return file;
 }
 function indexHash(){const bytes=readBytes(path.join(gitPath,'index'));return bytes===null?null:hash(bytes);}
 async function metadata(){
  const initialized=gitDirectory();
  if(!initialized)return {initialized:false,head:null,branch:null,staged:false,recoveryRequired:exists(journalPath)!==null,busy:false};
  const [head,ref,objectFormat]=await Promise.all([string(['rev-parse','--verify','HEAD'],{allow:[0,128]}),string(['symbolic-ref','-q','HEAD'],{allow:[0,1]}),string(['rev-parse','--show-object-format'])]);
  if(head&&!oid(head))fail('INVALID_GIT_HEAD');
  if(!['sha1','sha256'].includes(objectFormat))fail('UNSUPPORTED_OBJECT_FORMAT');
  return {initialized:true,head:head||null,branch:ref.startsWith('refs/heads/')?ref.slice(11):null,objectFormat,staged:false,recoveryRequired:exists(journalPath)!==null,busy:exists(path.join(gitPath,'index.lock'))!==null};
 }
 async function tree(head){
  if(!head)return new Map();
  const rows=records((await run(['ls-tree','-rz','--full-tree',head])).bytes),result=new Map();
  for(const record of rows){const tab=record.indexOf('\t'),[mode,type,sha]=record.slice(0,tab).split(' '),name=record.slice(tab+1);safe(name);if(type!=='blob'||!['100644','100755'].includes(mode)||!oid(sha))fail('UNSUPPORTED_GIT_ENTRY');result.set(name,{mode,sha});}
  return result;
 }
 async function index(){
  const rows=records((await run(['ls-files','--stage','-z'])).bytes),result=new Map();
  for(const record of rows){const tab=record.indexOf('\t'),[mode,sha,stage]=record.slice(0,tab).split(' '),name=record.slice(tab+1);safe(name);if(stage!=='0'||!['100644','100755'].includes(mode)||!oid(sha))fail('UNSUPPORTED_GIT_INDEX');result.set(name,{mode,sha});}
  return result;
 }
 const same=(a,b)=>a?.sha===b?.sha&&a?.mode===b?.mode;
 async function snapshot(){
  const meta=await metadata();if(!meta.initialized)return {...meta,headTree:new Map(),indexTree:new Map(),expectedIndexHash:null};
  const before=indexHash(),[headTree,indexTree]=await Promise.all([tree(meta.head),index()]);
  if(indexHash()!==before)fail('INDEX_CHANGED');
  const staged=[...new Set([...headTree.keys(),...indexTree.keys()])].some(name=>!same(headTree.get(name),indexTree.get(name)));
  return {...meta,staged,headTree,indexTree,expectedIndexHash:before};
 }
 function writable(meta){
  if(!meta.initialized)fail('GIT_NOT_INITIALIZED');if(meta.recoveryRequired)fail('RECOVERY_REQUIRED');if(meta.busy)fail('GIT_BUSY');if(!meta.branch)fail('DETACHED_HEAD');if(meta.staged)fail('STAGED_CHANGES');
  for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'])if(exists(path.join(gitPath,name)))fail('GIT_OPERATION_IN_PROGRESS');
 }
 function paths(input){if(!Array.isArray(input)||!input.length||input.length>MAX_SELECTED)fail('INVALID_SELECTION');const keys=new Set();return input.map(name=>{safe(name);const key=portablePathKey(name);if(keys.has(key))fail('INVALID_SELECTION');keys.add(key);return name;});}
 function objectHash(bytes,algorithm){return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
 function fileStatus(name,file,meta){const before=meta.headTree.get(name);if(!before)return file.hash===null?'unchanged':'added';if(file.hash===null)return 'deleted';return before.sha===(file.sha??objectHash(file.bytes,meta.objectFormat))&&before.mode===file.mode?'unchanged':'modified';}
 async function selected(meta,names,includeText){
  const files=[];let previewBytes=0;
  for(const name of names){
   const file=sourceDigest(name,meta.objectFormat),entry=meta.headTree.get(name);
   const beforeSize=entry?Number(await string(['cat-file','-s',entry.sha])):null,afterSize=file.hash===null?null:file.size;
   if(beforeSize!==null&&(!Number.isSafeInteger(beforeSize)||beforeSize<0))fail('GIT_FAILED');
   const previewOmitted=(beforeSize??0)>MAX_FILE||(afterSize??0)>MAX_FILE||previewBytes+(beforeSize??0)+(afterSize??0)>MAX_OUTPUT;
   let beforeBytes=null,afterBytes=null;
   if(includeText&&!previewOmitted){
    previewBytes+=(beforeSize??0)+(afterSize??0);
    if(entry)beforeBytes=(await run(['cat-file','blob',entry.sha])).bytes;
    if(file.hash!==null){afterBytes=sourceFile(name).bytes;if(afterBytes===null||hash(afterBytes)!==file.hash)fail('CONFLICT');}
   }
   const before=text(beforeBytes),after=text(afterBytes);
   files.push({path:name,expectedSourceHash:file.hash,expectedSourceMode:file.mode,status:fileStatus(name,file,meta),...(includeText?{before,after,beforeSize,afterSize,previewOmitted,beforeMode:entry?.mode??null,afterMode:file.mode,binary:!previewOmitted&&((beforeBytes!==null&&before===null)||(afterBytes!==null&&after===null))}:{})});
  }
  return files;
 }
 async function review({paths:selection}){
  const names=paths(selection),meta=await snapshot();writable(meta);await rejectIgnored(meta,names);const files=await selected(meta,names,true);
  const end=await metadata();if(end.head!==meta.head||end.branch!==meta.branch||indexHash()!==meta.expectedIndexHash)fail('CONFLICT');
  return {head:meta.head,branch:meta.branch,expectedHead:meta.head,expectedIndexHash:meta.expectedIndexHash,files,staged:false,recoveryRequired:false};
 }
 async function rejectIgnored(meta,names){const untracked=names.filter(name=>!meta.headTree.has(name)&&!meta.indexTree.has(name));if(untracked.length&&(await run(['check-ignore','--no-index','-z','--stdin'],{input:Buffer.from(untracked.join('\0')+'\0'),allow:[0,1]})).bytes.length)fail('IGNORED_PATH');}
 async function status(){
  const meta=await snapshot();if(!meta.initialized)return {...meta,headTree:undefined,indexTree:undefined,files:[]};
  const disk=[];
  const walk=(relative='',depth=0)=>{if(depth>32)fail('LIMIT_EXCEEDED');for(const entry of fs.readdirSync(path.join(source.path,relative),{withFileTypes:true})){if(entry.name.toLowerCase()==='.git'||entry.name.toLowerCase()==='.asmagicbrain'||entry.name.toLowerCase().startsWith('.asmb-'))continue;const name=relative?`${relative}/${entry.name}`:entry.name;safe(name);if(entry.isDirectory())walk(name,depth+1);else{if(!entry.isFile())fail('UNSAFE_FILE');disk.push(name);if(disk.length>MAX_FILES)fail('LIMIT_EXCEEDED');}}};walk();
  const untracked=disk.filter(name=>!meta.headTree.has(name)&&!meta.indexTree.has(name));
  const ignored=new Set(untracked.length?(await run(['check-ignore','--no-index','-z','--stdin'],{input:Buffer.from(untracked.join('\0')+'\0'),allow:[0,1]})).bytes.toString('utf8').split('\0').filter(Boolean):[]);
  const names=[...new Set([...meta.headTree.keys(),...meta.indexTree.keys(),...disk.filter(name=>!ignored.has(name))])].sort();
  // Status hashes one fixed-size chunk at a time. Large unchanged attachments
  // never consume the interactive review/commit byte budget.
  const files=[];
  for(const name of names){const file=sourceDigest(name,meta.objectFormat),state=fileStatus(name,file,meta);if(state!=='unchanged'||!same(meta.headTree.get(name),meta.indexTree.get(name)))files.push({path:name,expectedSourceHash:file.hash,expectedSourceMode:file.mode,status:state});}
  const end=await metadata();if(end.head!==meta.head||end.branch!==meta.branch||indexHash()!==meta.expectedIndexHash)fail('CONFLICT');
  return {initialized:true,head:meta.head,branch:meta.branch,staged:meta.staged,files,recoveryRequired:meta.recoveryRequired,busy:meta.busy,expectedIndexHash:meta.expectedIndexHash};
 }
 async function initialize({branch='main'}={}){
  check();if(branch!=='main')fail('INVALID_BRANCH');if(exists(journalPath))fail('RECOVERY_REQUIRED');if(gitDirectory())return metadata();
  // Do not create a nested checkout under an existing parent repository.
  let parent=path.dirname(source.path);while(parent!==path.dirname(parent)){if(exists(path.join(parent,'.git')))fail('NESTED_REPOSITORY');parent=path.dirname(parent);}
  const template=fs.mkdtempSync(path.join(privatePin.path,'empty-template-'));fs.chmodSync(template,0o700);
  try{await run(['init','--initial-branch=main',`--template=${template}`,source.path],{initializing:true});gitDirectory();return metadata();}finally{fs.rmdirSync(template);}
 }
 async function commit(request){
  if(!exact(request,['expectedHead','expectedIndexHash','files','message','author'])||!(request.expectedHead===null||oid(request.expectedHead))||!(request.expectedIndexHash===null||digest(request.expectedIndexHash))||!exact(request.author,['name','email'])||!Array.isArray(request.files))fail('INVALID_REQUEST');
  if(typeof request.message!=='string'||!request.message.trim()||!request.message.isWellFormed()||request.message.includes('\0')||Buffer.byteLength(request.message)>16384)fail('INVALID_MESSAGE');
  for(const key of ['name','email'])if(typeof request.author[key]!=='string'||!request.author[key].trim()||request.author[key].length>256||/[\x00-\x1f\x7f<>]/.test(request.author[key]))fail('INVALID_AUTHOR');
  const names=paths(request.files.map(file=>{if(!exact(file,['path','expectedSourceHash','expectedSourceMode'])||!(file.expectedSourceHash===null||digest(file.expectedSourceHash))||![null,'100644','100755'].includes(file.expectedSourceMode)||(file.expectedSourceHash===null)!==(file.expectedSourceMode===null))fail('INVALID_REQUEST');return file.path;}));
  const meta=await snapshot();writable(meta);
  if(meta.head!==request.expectedHead)fail('HEAD_CHANGED');if(meta.expectedIndexHash!==request.expectedIndexHash)fail('INDEX_CHANGED');
  await rejectIgnored(meta,names);
  const originals=names.map((name,i)=>{const file=sourceDigest(name,meta.objectFormat);if(file.hash!==request.files[i].expectedSourceHash||file.mode!==request.files[i].expectedSourceMode)fail('CONFLICT');return file;});
  if(!originals.some((file,i)=>fileStatus(names[i],file,meta)!=='unchanged'))fail('NO_CHANGES');
  const id=randomUUID(),temporary=path.join(privatePin.path,`index-${id}`),lockPath=path.join(gitPath,'index.lock');let lock,lockIdentity,journal=false,published=false;
  try{
   try{lock=fs.openSync(lockPath,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}catch(error){if(error.code==='EEXIST')fail('GIT_BUSY');throw error;}
   const stat=fs.fstatSync(lock);lockIdentity={dev:stat.dev,ino:stat.ino};
   if(indexHash()!==meta.expectedIndexHash)fail('INDEX_CHANGED');
   const env={GIT_INDEX_FILE:temporary};
   await run(meta.head?['read-tree',meta.head]:['read-tree','--empty'],{env});
   const records=[];
   for(let i=0;i<names.length;i++){
    const original=originals[i];let sha='0'.repeat(meta.objectFormat==='sha256'?64:40);
    if(original.hash!==null){
     checkSourceSpelling(source.path,names[i]);const file=openRawFile(path.join(source.path,names[i]),Number.MAX_SAFE_INTEGER);
     try{
      if(file.size!==original.size||file.mode!==original.mode)fail('CONFLICT');
      const input=file.size?fs.createReadStream(null,{fd:file.fd,autoClose:false,start:0,end:file.size-1,highWaterMark:64*1024}):Buffer.alloc(0);
      sha=await string(['hash-object','-w','--stdin'],{input});file.verify();checkSourceSpelling(source.path,names[i]);
      if(sha!==original.sha)fail('CONFLICT');
     }finally{file.close();}
    }
    records.push(`${original.hash===null?'0':original.mode} ${sha}\t${names[i]}\0`);
   }
   await run(['update-index','-z','--index-info'],{env,input:Buffer.from(records.join(''))});
   const treeId=await string(['write-tree'],{env});
   const authorEnv={GIT_AUTHOR_NAME:request.author.name,GIT_AUTHOR_EMAIL:request.author.email,GIT_COMMITTER_NAME:request.author.name,GIT_COMMITTER_EMAIL:request.author.email};
   const newHead=await string(['commit-tree',treeId,...(meta.head?['-p',meta.head]:[])],{input:Buffer.from(request.message),env:authorEnv});if(!oid(newHead))fail('GIT_FAILED');
   const nextIndex=readBytes(temporary);if(nextIndex===null)fail('GIT_FAILED');
   const current=await metadata();if(current.head!==meta.head||current.branch!==meta.branch||indexHash()!==meta.expectedIndexHash)fail('CONFLICT');
   for(let i=0;i<names.length;i++){const file=sourceDigest(names[i],meta.objectFormat);if(file.hash!==originals[i].hash||file.mode!==originals[i].mode)fail('CONFLICT');}
   writeExclusive(journalPath,Buffer.from(JSON.stringify({schemaVersion:1,id,binding,branch:meta.branch,beforeHead:meta.head,afterHead:newHead,beforeIndexHash:meta.expectedIndexHash,afterIndexHash:hash(nextIndex),temporary:path.basename(temporary),lockIdentity,paths:names})));journal=true;
   hooks.at?.('after-intent');
   const beforePublish=await metadata();if(beforePublish.head!==meta.head||beforePublish.branch!==meta.branch)fail('CONFLICT');
   for(let i=0;i<names.length;i++){const file=sourceDigest(names[i],meta.objectFormat);if(file.hash!==originals[i].hash||file.mode!==originals[i].mode)fail('CONFLICT');}
   await run(['update-ref',`refs/heads/${meta.branch}`,newHead,meta.head??'0'.repeat(newHead.length)]);published=true;
   hooks.at?.('after-ref');
   const afterPublish=await metadata();if(afterPublish.head!==newHead||afterPublish.branch!==meta.branch)fail('RECOVERY_REQUIRED');
   if(indexHash()!==meta.expectedIndexHash)fail('INDEX_CHANGED');const live=fs.lstatSync(lockPath);if(live.dev!==lockIdentity.dev||live.ino!==lockIdentity.ino)fail('RECOVERY_REQUIRED');
   fs.writeFileSync(lock,nextIndex);fs.fsyncSync(lock);fs.renameSync(lockPath,path.join(gitPath,'index'));syncDirectory(gitPath);
   hooks.at?.('after-index');
   fs.renameSync(journalPath,path.join(privatePin.path,`completed-${id}.json`));syncDirectory(privatePin.path);journal=false;
   fs.unlinkSync(temporary);
   return {status:'committed',head:newHead,branch:meta.branch,paths:names};
  }catch(error){
   if(journal||published)fail('RECOVERY_REQUIRED');
   if(lockIdentity){const live=exists(lockPath);if(live?.dev===lockIdentity.dev&&live?.ino===lockIdentity.ino)fs.unlinkSync(lockPath);}
   if(exists(temporary))fs.unlinkSync(temporary);
   throw error;
  }finally{if(lock!==undefined)fs.closeSync(lock);}
 }
 return Object.freeze({inspect:()=>queued(async()=>{const {headTree,indexTree,...meta}=await snapshot();return meta;}),initialize:request=>queued(()=>initialize(request)),status:()=>queued(status),review:request=>queued(()=>review(request)),commit:request=>queued(()=>commit(request))});
}
