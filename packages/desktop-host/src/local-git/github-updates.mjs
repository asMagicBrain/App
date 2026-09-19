import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {pinDirectory,checkDirectory,contains} from '../physical-roots.mjs';
import {createPrivateStore,assertOutsideGit} from '../private-store.mjs';
import {canonicalGitHubUrl} from './github-clone.mjs';
import {isInspectableRelativePath} from '../../../source-foundation/src/domain/path-policy.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exists=filename=>{try{return fs.lstatSync(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const GITHUB_UPDATE_LIMITS=Object.freeze({timeoutMs:10*60*1000,metadataBytes:2*1024*1024*1024,metadataEntries:100000,outputBytes:16*1024*1024,files:10000,displayFiles:1000,previewBytes:4*1024*1024});
// Same authority boundary as cloning: explicit HTTPS URL, no inherited Git
// configuration/credentials/hooks, and no network in object-comparison work.
const environment=()=>gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1',GIT_OPTIONAL_LOCKS:'0',GIT_ALLOW_PROTOCOL:'',...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})});
const prefix=['--no-pager','--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.pager=cat','-c','credential.helper=','-c','credential.interactive=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','http.followRedirects=false','-c','http.sslVerify=true','-c','submodule.recurse=false'];
function sync(directory){const pin=pinDirectory(directory),fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);checkDirectory(pin);}finally{fs.closeSync(fd);}}
function directory(parent,name){checkDirectory(parent);const filename=path.join(parent.path,name);if(!exists(filename)){fs.mkdirSync(filename,{mode:0o700});sync(parent.path);}const pin=pinDirectory(filename);if((fs.statSync(filename).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');return pin;}
function safePath(value){return isInspectableRelativePath(value)&&value.split('/').length<=32&&!value.split('/').some(part=>part.toLowerCase()==='.asmagicbrain'||part.toLowerCase().startsWith('.asmb-'));}
function readFile(filename,limit=GITHUB_UPDATE_LIMITS.outputBytes){
 const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)fail('RECOVERY_REQUIRED');
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd);if(before.dev!==stat.dev||before.ino!==stat.ino)fail('RECOVERY_REQUIRED');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),live=fs.lstatSync(filename);if(bytes.length!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||live.dev!==before.dev||live.ino!==before.ino)fail('RECOVERY_REQUIRED');return bytes;}finally{fs.closeSync(fd);}
}
function inspectTree(root,{flush=false}={}){
 const pin=pinDirectory(root);let entries=0,bytes=0;
 const walk=folder=>{for(const name of fs.readdirSync(folder)){const filename=path.join(folder,name),stat=fs.lstatSync(filename);if(++entries>GITHUB_UPDATE_LIMITS.metadataEntries)fail('UPDATES_LIMIT_EXCEEDED');if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||(stat.isFile()&&stat.nlink!==1))fail('UNSAFE_GIT_METADATA');if(stat.isDirectory())walk(filename);else{bytes+=stat.size;if(bytes>GITHUB_UPDATE_LIMITS.metadataBytes)fail('UPDATES_LIMIT_EXCEEDED');if(flush){const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}}if(flush)sync(folder);};walk(root);checkDirectory(pin);return {entries,bytes};
}
function sourceObjects(source){
 checkDirectory(source);const git=pinDirectory(path.join(source.path,'.git'));inspectTree(git.path);
 for(const name of ['commondir','objects/info/alternates','objects/info/http-alternates','shallow'])if(exists(path.join(git.path,name)))fail('UNSUPPORTED_GIT_DIRECTORY');
 return {git,objects:pinDirectory(path.join(git.path,'objects'))};
}

/** Trusted host factory. Fetch is isolated from the user's repository. The
 * snapshot receives local-only objects only AFTER the last network command.
 * hooks.acquire is an internal fixture transport, never exposed over IPC. */
export function createGitHubUpdates({sourceRoot,sourceBindingRoot,privateRoot,sourceUrl,branch,hooks={}}){
 const source=pinDirectory(sourceRoot),root=pinDirectory(privateRoot),url=canonicalGitHubUrl(sourceUrl);
 if(contains(source.path,root.path)||contains(root.path,source.path)||(fs.statSync(root.path).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');assertOutsideGit(root.path);
 if(typeof branch!=='string'||!branch.length||branch.length>1024||/[\x00-\x20\x7f]/.test(branch))fail('UPDATES_UNAVAILABLE');
 const snapshots=directory(root,'snapshots'),journal=directory(root,'journal'),bindingHash=digest(Buffer.from(JSON.stringify({sourceRoot:sourceBindingRoot??source.path,identity:source.identity,url,branch})));
 const store=createPrivateStore({privateRoot:journal.path,bindingHash});let scan,state,active=false;const readers=new Set();
 function check(){checkDirectory(source);checkDirectory(root);checkDirectory(snapshots);assertOutsideGit(root.path);}
 const locator=value=>exact(value,['id','identity'])&&id(value.id)&&typeof value.identity==='string'&&/^\d+:\d+$/.test(value.identity);
 function load(){check();scan=store.ensureDurable(store.scan());state=scan.events.at(-1)?.payload??{schemaVersion:1,latest:null,pending:null,cleanup:[],seen:[]};
  if(scan.blocked||!exact(state,['schemaVersion','latest','pending','cleanup','seen'])||state.schemaVersion!==1||state.latest!==null&&(!exact(state.latest,['id','identity','hash'])||!locator({id:state.latest.id,identity:state.latest.identity})||!/^[a-f0-9]{64}$/.test(state.latest.hash))||state.pending!==null&&!locator(state.pending)||!Array.isArray(state.cleanup)||!state.cleanup.every(locator)||state.cleanup.length>4||!Array.isArray(state.seen)||state.seen.length>64||!state.seen.every(id))fail('RECOVERY_REQUIRED');}
 function persist(next){if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,state);scan=store.append(scan,'draft',next);if(scan.blocked)fail('RECOVERY_REQUIRED');state=structuredClone(next);}
 function removeOwned(value){check();const filename=path.join(snapshots.path,value.id),stat=exists(filename);if(!stat)return;const pin=pinDirectory(filename);if(pin.identity!==value.identity)fail('RECOVERY_REQUIRED');inspectTree(filename);checkDirectory(pin);fs.rmSync(filename,{recursive:true});sync(snapshots.path);}
 function settle(){load();if(state.pending){removeOwned(state.pending);persist({...state,pending:null});}if(state.cleanup.length){for(const item of state.cleanup)removeOwned(item);persist({...state,cleanup:[]});}}
 settle();
 function readResult(){load();if(!state.latest)return null;const pin=pinDirectory(path.join(snapshots.path,state.latest.id));if(pin.identity!==state.latest.identity)fail('RECOVERY_REQUIRED');const bytes=readFile(path.join(pin.path,'result.json'));if(digest(bytes)!==state.latest.hash)fail('RECOVERY_REQUIRED');let result;try{result=JSON.parse(bytes);}catch{fail('RECOVERY_REQUIRED');}if(result.checkId!==state.latest.id||result.sourceUrl!==url||result.branch!==branch||!Array.isArray(result.entries))fail('RECOVERY_REQUIRED');return {result,pin};}
 function summary(result,localHead,localBranch){const {entries,...rest}=result;return {...rest,stale:localHead!==result.localHead||localBranch!==branch,files:entries.slice(0,GITHUB_UPDATE_LIMITS.displayFiles).map(({path,status})=>({path,status})),totalFiles:entries.length,truncated:entries.length>GITHUB_UPDATE_LIMITS.displayFiles};}
 function runner({gitDir,signal,credential,deadline=Date.now()+GITHUB_UPDATE_LIMITS.timeoutMs}){
  const gitPin=pinDirectory(gitDir),executable=fs.statSync(gitExecutable()),children=new Set();let reason=null;
  const stop=code=>{reason??=code;for(const child of children)try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
  function guard(){check();checkDirectory(gitPin);if(signal?.aborted)fail('UPDATES_CANCELLED');if(reason)fail(reason);if(Date.now()>deadline)fail('UPDATES_TIMEOUT');const now=fs.statSync(gitExecutable());if(now.ino!==executable.ino||now.dev!==executable.dev)fail('GIT_EXECUTABLE_CHANGED');}
  function start(args,{network=false,input,capture=true,allow=[0],env:extra={}}={}){
   guard();if(network)hooks.at?.('updates-network-command',{args,gitDir});
   const env={...environment(),...extra};if(network){env.GIT_ALLOW_PROTOCOL='https';if(credential){env.GIT_CONFIG_COUNT='1';env.GIT_CONFIG_KEY_0=`http.${url}.extraHeader`;env.GIT_CONFIG_VALUE_0=`Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString('base64')}`;}}
   const child=spawn(gitExecutable(),[...prefix,...(network?['-c','protocol.https.allow=always']:[]),`--git-dir=${gitDir}`,...args],{cwd:gitDir,env,stdio:['pipe','pipe','pipe'],detached:true});children.add(child);
   let chunks=[],length=0;child.stdin.on('error',()=>{});child.stderr.resume();if(capture)child.stdout.on('data',bytes=>{length+=bytes.length;if(length>GITHUB_UPDATE_LIMITS.outputBytes)stop('UPDATES_LIMIT_EXCEEDED');else chunks.push(bytes);});
   const abort=()=>stop('UPDATES_CANCELLED'),timer=setTimeout(()=>stop('UPDATES_TIMEOUT'),Math.max(1,deadline-Date.now()));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const done=new Promise((resolve,reject)=>{child.once('error',()=>{reason??='GIT_UNAVAILABLE';});child.once('close',code=>{children.delete(child);clearTimeout(timer);signal?.removeEventListener('abort',abort);if(reason||!allow.includes(code)){reject(Object.assign(new Error(reason??'UPDATES_FAILED'),{code:reason??'UPDATES_FAILED'}));return;}try{guard();resolve({bytes:Buffer.concat(chunks),code});}catch(error){reject(error);}});});
   if(input!==undefined)child.stdin.end(input);return {child,done};
  }
  async function run(args,options={}){const operation=start(args,{...options,input:options.input??Buffer.alloc(0)});return operation.done;}
  const string=async(args,options)=>(await run(args,options)).bytes.toString('utf8').trim();
  async function importLocal(head){
   const local=sourceObjects(source);hooks.at?.('updates-before-local-import',{head,gitDir});
   const packing=start(['pack-objects','--revs','--stdout'],{input:Buffer.from(head+'\n'),capture:false,env:{GIT_OBJECT_DIRECTORY:local.objects.path,GIT_ALTERNATE_OBJECT_DIRECTORIES:''}});
   const indexing=start(['index-pack','--stdin','--strict']);let bytes=0;
   const bound=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>GITHUB_UPDATE_LIMITS.metadataBytes)callback(Object.assign(new Error('UPDATES_LIMIT_EXCEEDED'),{code:'UPDATES_LIMIT_EXCEEDED'}));else callback(null,chunk);}});
   const transfer=pipeline(packing.child.stdout,bound,indexing.child.stdin);
   const settled=await Promise.allSettled([packing.done,indexing.done,transfer].map(promise=>promise.catch(error=>{stop(error.code??'UPDATES_FAILED');throw error;})));
   const failed=settled.find(value=>value.status==='rejected');if(failed)throw failed.reason;checkDirectory(local.git);checkDirectory(local.objects);await run(['update-ref','refs/asmb-check/local',head]);
  }
  return {run,string,importLocal,guard};
 }
 async function checkUpdates({requestId,localHead,localBranch},{signal,credential,onProgress=()=>{}}={}){
  if(!id(requestId)||!(localHead===null||oid(localHead))||localBranch!==branch)fail('INVALID_REQUEST');
  if(credential!==undefined&&(!credential||typeof credential.token!=='string'||!credential.token.length||credential.token.length>4096||/[\x00-\x20\x7f]/.test(credential.token)))fail('INVALID_CREDENTIAL');
  if(active)fail('UPDATES_BUSY');
  active=true;let pendingPin,published=false;
  try{
   await Promise.allSettled([...readers]);load();const previous=readResult();if(previous?.result.checkId===requestId)return summary(previous.result,localHead,localBranch);if(state.seen.includes(requestId))fail('COMPARISON_EXPIRED');
   if(signal?.aborted)fail('UPDATES_CANCELLED');settle();
   const filename=path.join(snapshots.path,requestId);if(exists(filename))fail('RECOVERY_REQUIRED');fs.mkdirSync(filename,{mode:0o700});sync(snapshots.path);pendingPin=pinDirectory(filename);persist({...state,pending:{id:requestId,identity:pendingPin.identity}});hooks.at?.('updates-intent');
   const git=directory(pendingPin,'repository.git');
   for(const name of ['objects','refs'])directory(git,name);
   fs.writeFileSync(path.join(git.path,'HEAD'),'ref: refs/heads/unused\n',{flag:'wx',mode:0o600});
   fs.writeFileSync(path.join(git.path,'config'),'[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tlogallrefupdates = false\n',{flag:'wx',mode:0o600});
   const task=runner({gitDir:git.path,signal,credential});await task.run(['check-ref-format',`refs/heads/${branch}`]);onProgress({phase:'connecting'});
   let remoteHead;
   if(hooks.acquire){remoteHead=await hooks.acquire({gitDir:git.path,sourceUrl:url,branch,signal});task.guard();}
   else{
    const advertised=await task.run(['ls-remote','--exit-code','--heads','--',url,`refs/heads/${branch}`],{network:true,allow:[0,2]});
    if(advertised.code===2)remoteHead=null;
    else{onProgress({phase:'receiving'});await task.run(['fetch','--atomic','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--no-write-commit-graph','--no-recurse-submodules','--refmap=','--',url,`refs/heads/${branch}:refs/asmb-check/remote`],{network:true});remoteHead=await task.string(['rev-parse','--verify','refs/asmb-check/remote^{commit}']);}
   }
   credential=undefined;if(remoteHead!==null&&!oid(remoteHead))fail('UPDATES_FAILED');inspectTree(git.path);task.guard();onProgress({phase:'comparing'});
   // From here onwards every process is offline, including local object import.
   if(localHead)await task.importLocal(localHead);if(remoteHead)await task.run(['update-ref','refs/asmb-check/remote',remoteHead]);
   let relation='remote-branch-missing',ahead=null,behind=null,entries=[];
   if(remoteHead){
    if(!localHead){relation='local-empty';ahead=0;behind=Number(await task.string(['rev-list','--count',remoteHead]));}
    else{[ahead,behind]=(await task.string(['rev-list','--left-right','--count',`${localHead}...${remoteHead}`])).split(/\s+/).map(Number);const base=await task.run(['merge-base',localHead,remoteHead],{allow:[0,1]});relation=localHead===remoteHead?'up-to-date':base.code===1?'unrelated':!ahead?'remote-ahead':!behind?'local-ahead':'diverged';}
    const before=localHead??await task.string(['hash-object','-w','-t','tree','--stdin']);
    const raw=(await task.run(['diff','--raw','-z','--no-abbrev','--no-renames','--no-ext-diff','--no-textconv',before,remoteHead,'--'])).bytes;
    let records;try{records=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw).split('\0');}catch{fail('UPDATES_UNSUPPORTED_ENTRY');}
    if(records.at(-1)==='')records.pop();if(records.length%2||records.length/2>GITHUB_UPDATE_LIMITS.files)fail('UPDATES_LIMIT_EXCEEDED');
    for(let index=0;index<records.length;index+=2){const [beforeMode,afterMode,beforeOid,afterOid,status]=records[index].slice(1).split(' '),name=records[index+1];if(!records[index].startsWith(':')||!safePath(name)||!oid(beforeOid)||!oid(afterOid)||!['A','M','D','T'].includes(status))fail('UPDATES_UNSUPPORTED_ENTRY');entries.push({path:name,status:{A:'added',M:'modified',D:'deleted',T:'type-changed'}[status],beforeMode,afterMode,beforeOid,afterOid});}
   }
   const result={checkId:requestId,sourceUrl:url,branch,checkedAt:Date.now(),localHead,remoteHead,relation,ahead,behind,entries};
   if([ahead,behind].some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0)))fail('UPDATES_FAILED');
   const bytes=Buffer.from(JSON.stringify(result));if(bytes.length>GITHUB_UPDATE_LIMITS.outputBytes)fail('UPDATES_LIMIT_EXCEEDED');fs.writeFileSync(path.join(pendingPin.path,'result.json'),bytes,{flag:'wx',mode:0o600});inspectTree(pendingPin.path,{flush:true});task.guard();hooks.at?.('updates-before-publish');task.guard();
   const old=state.latest;persist({...state,latest:{id:requestId,identity:pendingPin.identity,hash:digest(bytes)},pending:null,cleanup:old?[{id:old.id,identity:old.identity}]:[],seen:[...state.seen,requestId].slice(-64)});published=true;hooks.at?.('updates-published');
   // Once the complete pointer is durable, cancellation cannot erase it.
   if(state.cleanup.length){for(const item of state.cleanup)removeOwned(item);persist({...state,cleanup:[]});}
   return summary(result,localHead,localBranch);
  }catch(error){if(!published&&pendingPin){checkDirectory(pendingPin);load();if(state.pending?.id===requestId){removeOwned(state.pending);persist({...state,pending:null});}}throw error;}
  finally{credential=undefined;active=false;}
 }
 async function readPreview({checkId,path:relative}){
  if(!id(checkId)||!safePath(relative))fail('INVALID_REQUEST');const current=readResult();if(!current||current.result.checkId!==checkId)fail('COMPARISON_EXPIRED');const entry=current.result.entries.find(item=>item.path===relative);if(!entry)fail('INVALID_REQUEST');
  const task=runner({gitDir:path.join(current.pin.path,'repository.git')}),sides=[];let unsupported=false,previewOmitted=false;
  for(const side of ['before','after']){const mode=entry[side+'Mode'],sha=entry[side+'Oid'];if(mode==='000000'){sides.push({mode:null,size:null,bytes:null});continue;}if(!['100644','100755','120000'].includes(mode)){unsupported=true;sides.push({mode,size:null,bytes:null});continue;}const size=Number(await task.string(['cat-file','-s',sha]));if(!Number.isSafeInteger(size)||size<0)fail('RECOVERY_REQUIRED');const omitted=size>GITHUB_UPDATE_LIMITS.previewBytes;previewOmitted||=omitted;sides.push({mode,size,bytes:omitted?null:(await task.run(['cat-file','blob',sha])).bytes});}
  const text=value=>{if(value===null)return null;if(value.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}catch{return null;}};
  const [before,after]=sides.map(value=>text(value.bytes)),binary=sides.some((value,index)=>value.bytes!==null&&[before,after][index]===null);
  const latest=readResult();if(!latest||latest.result.checkId!==checkId)fail('COMPARISON_EXPIRED');checkDirectory(current.pin);
  return {checkId,path:relative,status:entry.status,before,after,beforeSize:sides[0].size,afterSize:sides[1].size,beforeMode:sides[0].mode,afterMode:sides[1].mode,binary,previewOmitted,unsupported};
 }
 // Host-only lease: a check cannot retire this snapshot until the callback
 // settles. Paths and plumbing capabilities never cross the renderer bridge.
 function withSnapshot(checkId,callback){
  if(active)fail('UPDATES_BUSY');if(!id(checkId)||typeof callback!=='function')fail('INVALID_REQUEST');
  const current=readResult();if(!current||current.result.checkId!==checkId)fail('COMPARISON_EXPIRED');
  const promise=Promise.resolve().then(async()=>{checkDirectory(current.pin);const value=await callback(Object.freeze({result:structuredClone(current.result),gitDir:path.join(current.pin.path,'repository.git'),identity:current.pin.identity}));checkDirectory(current.pin);return value;});
  readers.add(promise);void promise.finally(()=>readers.delete(promise)).catch(()=>{});return promise;
 }
 return Object.freeze({get:({localHead,localBranch})=>{const current=readResult();return current?summary(current.result,localHead,localBranch):null;},check:checkUpdates,withSnapshot,readFile:request=>{if(active)return Promise.reject(Object.assign(new Error('UPDATES_BUSY'),{code:'UPDATES_BUSY'}));const promise=readPreview(request);readers.add(promise);void promise.finally(()=>readers.delete(promise)).catch(()=>{});return promise;}});
}
