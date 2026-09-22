import {persistentIdentity, storageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {pinDirectory,checkDirectory,contains} from '../physical-roots.mjs';
import {createPrivateStore,assertOutsideGit} from '../private-store.mjs';
import {hashRawFile,openRawFile} from './raw-file.mjs';
import {isPortableRelativePath,portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

const execute=promisify(execFile),worker=fileURLToPath(new URL('./github-apply-worker.mjs',import.meta.url));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),identity=persistentIdentity;
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const oid=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const equal=(a,b)=>a===null||b===null?a===b:a.hash===b.hash&&a.mode===b.mode&&a.size===b.size;
const sameTree=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const own=(value,key)=>Object.hasOwn(value,key)?value[key]:undefined;
const stamp=s=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const safe=p=>isPortableRelativePath(p)&&p.split('/').length<=32&&!p.split('/').some(n=>n.toLowerCase()==='.asmagicbrain'||n.toLowerCase().startsWith('.asmb-'));
export const GITHUB_APPLY_LIMITS=Object.freeze({files:10000,changes:1000,metadataBytes:2*1024*1024*1024,outputBytes:16*1024*1024,timeoutMs:10*60*1000,reviewMs:5*60*1000});
const environment=()=>gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1',GIT_OPTIONAL_LOCKS:'0',GIT_ALLOW_PROTOCOL:'',...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})});
const prefix=['--no-pager','--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.interactive=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','submodule.recurse=false','-c','core.splitIndex=false'];
function sync(p){const pin=pinDirectory(p),fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);checkDirectory(pin);}finally{fs.closeSync(fd);}}
function directory(parent,name){checkDirectory(parent);const p=path.join(parent.path,name);if(!exists(p)){fs.mkdirSync(p,{mode:0o700});sync(parent.path);}return pinDirectory(p);}
function read(p){const v=hashRawFile(p,{limit:GITHUB_APPLY_LIMITS.outputBytes});const bytes=fs.readFileSync(p);if(digest(bytes)!==v.hash)fail('APPLY_STALE');return {value:v,bytes};}
function parseTree(bytes){
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('APPLY_UNSUPPORTED');}
 const files=Object.create(null),keys=new Map();for(const line of text.split('\0').filter(Boolean)){
  const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);if(!match||!safe(match[3]))fail('APPLY_UNSUPPORTED');const [,mode,sha,p]=match;
  if(Object.keys(files).length>=GITHUB_APPLY_LIMITS.files)fail('APPLY_LIMIT_EXCEEDED');
  for(let n=p;n!=='.';n=path.posix.dirname(n)){const key=portablePathKey(n);if(keys.has(key)&&keys.get(key)!==n)fail('APPLY_UNSUPPORTED');keys.set(key,n);}
  files[p]={mode,sha};
 }return files;
}
const dirs=tree=>[...new Set(Object.keys(tree).flatMap(p=>{const a=[];for(let n=path.posix.dirname(p);n!=='.';n=path.posix.dirname(n))a.push(n);return a;}))].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));

/** Offline, explicit clean-tree fast-forward. This factory has no network API.
 * Root admission and renderer/runtime draft coordination are host responsibilities;
 * raw bytes, Git index, branch, snapshot and recovery ownership are checked here. */
export function createGitHubApply({sourceRoot,sourceBindingRoot,privateRoot,snapshots,hooks={}}){
 const source=pinDirectory(sourceRoot),root=pinDirectory(privateRoot),git=pinDirectory(path.join(source.path,'.git'));
 const objects=pinDirectory(path.join(git.path,'objects')),objectPacks=pinDirectory(path.join(objects.path,'pack')),refs=pinDirectory(path.join(git.path,'refs')),heads=pinDirectory(path.join(refs.path,'heads'));
 if(contains(source.path,root.path)||contains(root.path,source.path)||(fs.statSync(root.path).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');assertOutsideGit(root.path);
 const journal=directory(root,'journal'),transactions=directory(root,'transactions'),binding=digest(JSON.stringify({root:sourceBindingRoot??source.path,identity:source.identity,git:git.identity}));
 const store=createPrivateStore({privateRoot:journal.path,bindingHash:binding});let scan,state,busy=false,workerFaultUsed=false,deadline=null;const reviews=new Map();
 const remaining=()=>{const value=deadline===null?GITHUB_APPLY_LIMITS.timeoutMs:deadline-Date.now();if(value<=0)fail('APPLY_TIMEOUT');return value;};
 function check(){for(const p of [source,git,objects,objectPacks,refs,heads,root,transactions])checkDirectory(p);assertOutsideGit(root.path);}
 function load(){check();scan=store.ensureDurable(store.scan());state=scan.events.at(-1)?.payload??{schemaVersion:1,pending:null,cleanup:null,receipts:[]};if(scan.blocked||state.schemaVersion!==1||!Array.isArray(state.receipts)||state.receipts.length>64||state.pending!==null&&(!uuid(state.pending.requestId)||!uuid(state.pending.checkId)))fail('APPLY_RECOVERY_REQUIRED');}
 function persist(next){if(scan.tailRecords>=20||scan.coveredFiles.length)scan=store.compact(scan,state);scan=store.append(scan,'draft',next);if(scan.blocked)fail('APPLY_RECOVERY_REQUIRED');state=structuredClone(next);}
 load();
 async function command(gitDir,args,{env={},input}={}){
  check();const pin=pinDirectory(gitDir);try{const result=await execute(gitExecutable(),[...prefix,`--git-dir=${gitDir}`,...args],{env:{...environment(),...env},cwd:gitDir,encoding:'buffer',timeout:remaining(),maxBuffer:GITHUB_APPLY_LIMITS.outputBytes,...(input?{input}:{})});check();checkDirectory(pin);return result.stdout;}catch(error){fail(error.code==='ETIMEDOUT'||error.code==='APPLY_TIMEOUT'?'APPLY_TIMEOUT':'APPLY_GIT_FAILED');}
 }
 // Git plumbing that consumes stdin/streams uses explicit child drains. execFile
 // does not accept stdin as an option, so no input-bearing command uses it.
 async function streamGit(gitDir,args,{input,output,env={}}={}){
  check();const wait=remaining(),pin=pinDirectory(gitDir),child=spawn(gitExecutable(),[...prefix,`--git-dir=${gitDir}`,...args],{cwd:gitDir,env:{...environment(),...env},stdio:['pipe','pipe','pipe'],detached:true});child.stderr.resume();child.stdin.on('error',()=>{});let failure=null,total=0;
  const stop=code=>{failure??=code;try{process.kill(-child.pid,'SIGKILL');}catch{}};const timer=setTimeout(()=>stop('APPLY_TIMEOUT'),wait);
  const done=new Promise((resolve,reject)=>{child.once('error',()=>stop('APPLY_GIT_FAILED'));child.once('close',code=>{clearTimeout(timer);if(failure||code!==0)reject(Object.assign(new Error(failure??'APPLY_GIT_FAILED'),{code:failure??'APPLY_GIT_FAILED'}));else resolve();});});
  const bound=new Transform({transform(chunk,enc,cb){total+=chunk.length;if(total>GITHUB_APPLY_LIMITS.metadataBytes)cb(Object.assign(new Error('APPLY_LIMIT_EXCEEDED'),{code:'APPLY_LIMIT_EXCEEDED'}));else cb(null,chunk);}});
  const jobs=[done];if(output)jobs.push(pipeline(child.stdout,bound,output));else child.stdout.resume();if(input?.pipe)jobs.push(pipeline(input,child.stdin));else child.stdin.end(input);
  const settled=await Promise.allSettled(jobs.map(p=>p.catch(e=>{stop(e.code??'APPLY_FAILED');throw e;})));const bad=settled.find(p=>p.status==='rejected');if(bad)throw bad.reason;check();checkDirectory(pin);
 }
 async function mutate(parent,commandName,fields={},fd){
  check();checkDirectory(parent);const wait=remaining(),child=spawn(process.execPath,[worker],{cwd:parent.path,env:{...environment(),...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','pipe',...(fd===undefined?[]:[fd])]});let data='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},wait);child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.on('data',b=>{data+=b;if(data.length>65536)child.kill('SIGKILL');});
  // Trusted constructor-only syscall fault seam; never part of a request DTO.
  const stopAfter=commandName==='publish'&&!workerFaultUsed?hooks.workerStopAfter:undefined;if(stopAfter)workerFaultUsed=true;
  child.stdin.end(JSON.stringify(storageWorkerEnvelope({parentIdentity:parent.identity,command:commandName,...fields,...(stopAfter?{stopAfter}:{})})));const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));if(timedOut)fail('APPLY_TIMEOUT');check();checkDirectory(parent);let result;try{result=JSON.parse(data);}catch{fail('APPLY_RECOVERY_REQUIRED');}if(code!==0||!result.ok)fail(result.code??'APPLY_RECOVERY_REQUIRED');return result.value;
 }
 function inspectMetadata(){
  check();for(const p of ['commondir','objects/info/alternates','objects/info/http-alternates','shallow','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'])if(exists(path.join(git.path,p)))fail('APPLY_UNSUPPORTED');
  let entries=0,bytes=0;const walk=p=>{for(const n of fs.readdirSync(p)){const q=path.join(p,n),s=fs.lstatSync(q);if(++entries>100000||s.isSymbolicLink()||!s.isDirectory()&&!s.isFile()||s.isFile()&&s.nlink!==1)fail('APPLY_UNSUPPORTED');if(s.isDirectory())walk(q);else{bytes+=s.size;if(bytes>GITHUB_APPLY_LIMITS.metadataBytes)fail('APPLY_LIMIT_EXCEEDED');}}};walk(git.path);check();
 }
 async function context(snapshot,{ownedLock=null}={}){
  inspectMetadata();const headText=read(path.join(git.path,'HEAD')).bytes.toString('utf8');if(headText!==`ref: refs/heads/${snapshot.result.branch}\n`)fail('APPLY_STALE');
  const head=(await command(git.path,['rev-parse','--verify','HEAD^{commit}'])).toString().trim();if(!oid(head))fail('APPLY_STALE');
  const lock=exists(path.join(git.path,'index.lock'));if(lock&&identity(lock)!==ownedLock)fail('APPLY_RECOVERY_REQUIRED');
  return {head,branch:snapshot.result.branch,index:read(path.join(git.path,'index'))};
 }
 function inventory({ignore=[]}={}){
  check();const files=Object.create(null),directories=[],ignored=new Set(ignore);let count=0;
  const walk=(parent,relative)=>{checkDirectory(parent);const keys=new Set();for(const name of fs.readdirSync(parent.path).sort()){
   const p=relative?`${relative}/${name}`:name;if(p==='.git'||ignored.has(p))continue;if(++count>GITHUB_APPLY_LIMITS.files*2||!safe(p))fail('APPLY_UNSUPPORTED');const key=portablePathKey(name);if(keys.has(key))fail('APPLY_UNSUPPORTED');keys.add(key);
   const full=path.join(parent.path,name),s=fs.lstatSync(full);if(s.isSymbolicLink())fail('APPLY_UNSUPPORTED');if(s.isDirectory()){directories.push(p);walk(pinDirectory(full),p);}else if(s.isFile()&&s.nlink===1)files[p]=hashRawFile(full,{limit:Number.MAX_SAFE_INTEGER});else fail('APPLY_UNSUPPORTED');
  }checkDirectory(parent);};walk(source,'');return {files,directories:directories.sort()};
 }
 function matches(inv,tree,allowDirs=dirs(tree)){
  if(Object.keys(inv.files).length!==Object.keys(tree).length||inv.directories.some(p=>!allowDirs.includes(p)))return false;
  return Object.entries(tree).every(([p,v])=>own(inv.files,p)?.sha===v.sha&&own(inv.files,p)?.mode===v.mode);
 }
 async function validate(snapshot,{ownedLock=null,targetHead=false}={}){
  const result=snapshot.result;if(result.relation!=='remote-ahead'||result.ahead!==0||!oid(result.localHead)||!oid(result.remoteHead))fail('APPLY_NOT_FAST_FORWARD');if(result.entries.length>GITHUB_APPLY_LIMITS.changes)fail('APPLY_PARTIAL');
  const oldTree=parseTree(await command(snapshot.gitDir,['ls-tree','-rz','--full-tree',result.localHead])),newTree=parseTree(await command(snapshot.gitDir,['ls-tree','-rz','--full-tree',result.remoteHead]));
  for(const p of Object.keys(oldTree))if(dirs(newTree).includes(p))fail('APPLY_UNSUPPORTED');for(const p of Object.keys(newTree))if(dirs(oldTree).includes(p))fail('APPLY_UNSUPPORTED');
  await command(snapshot.gitDir,['merge-base','--is-ancestor',result.localHead,result.remoteHead]);
  const current=await context(snapshot,{ownedLock});if(current.head!==(targetHead?result.remoteHead:result.localHead))fail('APPLY_STALE');
  const index=(await command(snapshot.gitDir,['ls-files','--stage','-z'],{env:{GIT_INDEX_FILE:path.join(git.path,'index')}})).toString('utf8').split('\0').filter(Boolean),indexed=Object.create(null);
  for(const row of index){const m=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/s.exec(row);if(!m||!safe(m[3]))fail('APPLY_SAVED_CHANGES');indexed[m[3]]={mode:m[1],sha:m[2]};}if(!sameTree(Object.fromEntries(Object.entries(indexed).sort()),Object.fromEntries(Object.entries(oldTree).sort())))fail('APPLY_SAVED_CHANGES');
  const inv=inventory();if(!matches(inv,oldTree))fail('APPLY_SAVED_CHANGES');
  return {oldTree,newTree,inv,index:current.index};
 }
 async function hostReady(validateContext){
  const c=validateContext?await validateContext():{};if(c.recoveryRequired)fail('APPLY_RECOVERY_REQUIRED');if(c.draftCount)fail('APPLY_DRAFTS');if(c.dirtyFileCount)fail('APPLY_SAVED_CHANGES');return c;
 }
 const reason=code=>({'APPLY_DRAFTS':'drafts','APPLY_SAVED_CHANGES':'saved-changes','APPLY_NOT_FAST_FORWARD':'not-fast-forward','APPLY_STALE':'stale','COMPARISON_EXPIRED':'stale','APPLY_PARTIAL':'partial','APPLY_UNSUPPORTED':'unsupported','APPLY_LIMIT_EXCEEDED':'unsupported','APPLY_RECOVERY_REQUIRED':'recovery-required'}[code]);
 async function review({checkId},{validateContext}={}){
  if(!uuid(checkId))fail('INVALID_REQUEST');if(busy)fail('APPLY_BUSY');load();return snapshots.withSnapshot(checkId,async snapshot=>{
   const r=snapshot.result,c=validateContext?await validateContext():{},base={checkId,reviewId:null,canApply:false,localHead:r.localHead,remoteHead:r.remoteHead,branch:r.branch,totalFiles:r.entries.length,behind:r.behind,expiresAt:null,dirtyFileCount:c.dirtyFileCount??0,draftCount:c.draftCount??0};
   try{if(state.pending||state.cleanup)fail('APPLY_RECOVERY_REQUIRED');await hostReady(()=>c);const checked=await validate(snapshot);const reviewId=randomUUID(),expiresAt=Date.now()+GITHUB_APPLY_LIMITS.reviewMs;reviews.clear();reviews.set(reviewId,{checkId,expiresAt,snapshotIdentity:snapshot.identity,indexHash:checked.index.value.hash,inventoryHash:digest(JSON.stringify(checked.inv)),localHead:r.localHead,remoteHead:r.remoteHead});return {...base,canApply:true,reviewId,expiresAt};}catch(e){if(reason(e.code))return {...base,reason:reason(e.code),dirtyFileCount:e.code==='APPLY_SAVED_CHANGES'?Math.max(1,base.dirtyFileCount):base.dirtyFileCount};throw e;}
  });
 }
 function pendingCheck(p){
  if(!p||p.sourceIdentity!==source.identity||p.gitIdentity!==git.identity||!uuid(p.requestId)||!uuid(p.checkId)||!uuid(p.reviewId)||!oid(p.previousHead)||!oid(p.head)||typeof p.branch!=='string'||!Array.isArray(p.files)||p.files.length>GITHUB_APPLY_LIMITS.changes||!Array.isArray(p.directories)||!Array.isArray(p.removedDirectories)||!Array.isArray(p.allowedDirectories))fail('APPLY_RECOVERY_REQUIRED');
  const validSide=s=>s===null||s&&/^[a-f0-9]{64}$/.test(s.hash)&&Number.isSafeInteger(s.size)&&s.size>=0&&['100644','100755'].includes(s.mode);
  for(const [i,f] of p.files.entries())if(!safe(f.path)||f.stage!==`.asmb-apply-${p.requestId}-${i}`||f.previous!==f.stage+'-previous'||!validSide(f.before)||!validSide(f.after))fail('APPLY_RECOVERY_REQUIRED');
  if([...p.directories,...p.removedDirectories].some(d=>!safe(d.path))||p.allowedDirectories.some(d=>!safe(d))||Object.keys(p.oldTree).some(d=>!safe(d))||Object.keys(p.newTree).some(d=>!safe(d))||!validSide(p.beforeIndex)||!validSide(p.afterIndex)||!validSide(p.pack))fail('APPLY_RECOVERY_REQUIRED');
  const tx=pinDirectory(path.join(transactions.path,p.requestId));if(tx.identity!==p.transactionIdentity)fail('APPLY_RECOVERY_REQUIRED');
  for(const [name,wanted] of [['objects.pack',p.pack],['old-index',p.beforeIndex],['target-index',p.afterIndex]])if(!equal(hashRawFile(path.join(tx.path,name),{limit:Number.MAX_SAFE_INTEGER}),wanted))fail('APPLY_RECOVERY_REQUIRED');
  return tx;
 }
 const side=(v)=>v?{hash:v.hash,size:v.size,mode:v.mode}:null;
 function artifacts(p){return p.files.flatMap(f=>[path.posix.join(path.posix.dirname(f.path),f.stage),path.posix.join(path.posix.dirname(f.path),f.previous)]);}
 async function copy(parent,name,filename,expected){const file=openRawFile(filename,Number.MAX_SAFE_INTEGER);try{return await mutate(parent,'copy',{name,expected,stamp:stamp(fs.fstatSync(file.fd,{bigint:true}))},file.fd);}finally{file.close();}}
 async function cleanup(p){
  pendingCheck(p);
  for(const f of p.files){const folder=path.dirname(path.join(source.path,f.path));if(!exists(folder)&&p.removedDirectories.some(d=>folder===path.join(source.path,d.path)||contains(path.join(source.path,d.path),folder)))continue;const parent=pinDirectory(folder);if(parent.identity!==f.parentIdentity)fail('APPLY_RECOVERY_REQUIRED');if(f.before)await mutate(parent,'remove',{name:f.previous,expected:f.before});}
  for(const d of p.removedDirectories){const filename=path.join(source.path,d.path);if(!exists(filename))continue;const parent=pinDirectory(path.dirname(filename));await mutate(parent,'rmdir',{name:path.basename(filename),identity:d.identity});}
  persist({...state,cleanup:null});
 }
 async function settle(p,{recovering=false,onProgress=()=>{}}={}){
  const tx=pendingCheck(p),snapshot={gitDir:path.join(tx.path,'repository.git'),result:{branch:p.branch,localHead:p.previousHead,remoteHead:p.head}},lockPath=path.join(git.path,'index.lock');
  const hostHead=await context(snapshot,{ownedLock:p.lockIdentity});if(![p.previousHead,p.head].includes(hostHead.head)||![p.beforeIndex.hash,p.afterIndex.hash].includes(hostHead.index.value.hash))fail('APPLY_RECOVERY_REQUIRED');
  // A stopped worker may have linked the known candidate but not removed its
  // private staging name yet. Normalize only that exact, owned inode pair.
  for(const f of p.files){const filename=path.join(source.path,f.path),stage=path.join(path.dirname(filename),f.stage),a=exists(filename),b=exists(stage);if(f.after&&a&&b&&identity(a)===identity(b)&&identity(b)===f.stageIdentity&&a.nlink===2){const parent=pinDirectory(path.dirname(filename));if(parent.identity!==f.parentIdentity)fail('APPLY_RECOVERY_REQUIRED');await mutate(parent,'publish',{name:path.basename(filename),stage:f.stage,previous:f.previous,before:f.before,after:f.after});}}
  // Every current leaf must be old or new; unknown external work is never
  // replayed over. Include untouched leaves and unexpected/ignored paths.
  const observed=inventory({ignore:artifacts(p)}),expectedPaths=new Set([...Object.keys(p.oldTree),...Object.keys(p.newTree)]);
  for(const name of Object.keys(observed.files))if(!expectedPaths.has(name))fail('APPLY_RECOVERY_REQUIRED');
  for(const name of expectedPaths){const file=p.files.find(f=>f.path===name),actual=own(observed.files,name)??null;if(file){if(!equal(actual,file.before)&&!equal(actual,file.after)&&!(actual===null&&file.before&&equal(hashRawFile(path.join(source.path,path.posix.dirname(name),file.previous),{limit:Number.MAX_SAFE_INTEGER}),file.before)))fail('APPLY_RECOVERY_REQUIRED');}else if(actual?.sha!==own(p.oldTree,name).sha||actual?.mode!==own(p.oldTree,name).mode)fail('APPLY_RECOVERY_REQUIRED');}
  if(observed.directories.some(d=>!p.allowedDirectories.includes(d)))fail('APPLY_RECOVERY_REQUIRED');
  for(const d of p.directories)if(d.identity&&pinDirectory(path.join(source.path,d.path)).identity!==d.identity)fail('APPLY_RECOVERY_REQUIRED');
  // Validate source state before adding any objects during restart recovery.
  await streamGit(snapshot.gitDir,['index-pack','--stdin','--strict'],{input:fs.createReadStream(path.join(tx.path,'objects.pack')),env:{GIT_OBJECT_DIRECTORY:objects.path}});hooks.at?.('apply-staged');
  if(!p.lockIdentity){if(exists(lockPath))fail('APPLY_RECOVERY_REQUIRED');const fd=fs.openSync(lockPath,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o644);try{const bytes=read(path.join(tx.path,'target-index')).bytes;fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);p.lockIdentity=identity(fs.fstatSync(fd));}finally{fs.closeSync(fd);}sync(git.path);persist({...state,pending:p});}
  else if(hostHead.index.value.hash!==p.afterIndex.hash){const lock=exists(lockPath);if(!lock||identity(lock)!==p.lockIdentity||!equal(hashRawFile(lockPath,{limit:GITHUB_APPLY_LIMITS.outputBytes}),p.afterIndex))fail('APPLY_RECOVERY_REQUIRED');}
  for(const item of p.directories){const filename=path.join(source.path,item.path);if(item.identity){const pin=pinDirectory(filename);if(pin.identity!==item.identity)fail('APPLY_RECOVERY_REQUIRED');}else{if(exists(filename))fail('APPLY_RECOVERY_REQUIRED');const parent=pinDirectory(path.dirname(filename)),made=await mutate(parent,'mkdir',{name:path.basename(filename)});item.identity=made.identity;persist({...state,pending:p});}}
  onProgress({phase:'applying'});
  for(let i=0;i<p.files.length;i++){
   const f=p.files[i],filename=path.join(source.path,f.path),parent=pinDirectory(path.dirname(filename));if(f.parentIdentity&&f.parentIdentity!==parent.identity)fail('APPLY_RECOVERY_REQUIRED');if(!f.parentIdentity){f.parentIdentity=parent.identity;persist({...state,pending:p});}
   const actual=exists(filename)?hashRawFile(filename,{limit:Number.MAX_SAFE_INTEGER}):null,stage=path.join(parent.path,f.stage);
   if(!equal(actual,f.after)&&f.after&&!exists(stage)){await copy(parent,f.stage,path.join(tx.path,`blob-${i}`),f.after);f.stageIdentity=identity(fs.lstatSync(stage));persist({...state,pending:p});}
   if(exists(stage)&&f.stageIdentity&&identity(fs.lstatSync(stage))!==f.stageIdentity)fail('APPLY_RECOVERY_REQUIRED');
   hooks.at?.('apply-before-file',i);await mutate(parent,'publish',{name:path.basename(filename),stage:f.stage,previous:f.previous,before:f.before,after:f.after});hooks.at?.('apply-after-file',i);
   f.done=true;persist({...state,pending:p});
  }
  const finalInventory=inventory({ignore:artifacts(p)});if(!matches(finalInventory,p.newTree,p.allowedDirectories))fail('APPLY_RECOVERY_REQUIRED');
  let current=await context(snapshot,{ownedLock:p.lockIdentity});if(![p.previousHead,p.head].includes(current.head)||![p.beforeIndex.hash,p.afterIndex.hash].includes(current.index.value.hash))fail('APPLY_RECOVERY_REQUIRED');
  hooks.at?.('apply-before-ref');
  current=await context(snapshot,{ownedLock:p.lockIdentity});if(![p.previousHead,p.head].includes(current.head)||![p.beforeIndex.hash,p.afterIndex.hash].includes(current.index.value.hash)||!matches(inventory({ignore:artifacts(p)}),p.newTree,p.allowedDirectories))fail('APPLY_RECOVERY_REQUIRED');
  if(current.head===p.previousHead)await command(git.path,['update-ref',`refs/heads/${p.branch}`,p.head,p.previousHead]);hooks.at?.('apply-after-ref');
  current=await context(snapshot,{ownedLock:p.lockIdentity});if(current.head!==p.head||!matches(inventory({ignore:artifacts(p)}),p.newTree,p.allowedDirectories))fail('APPLY_RECOVERY_REQUIRED');
  // History-only fast-forwards can have identical old/new index bytes. The
  // owned inode distinguishes an unpublished lock from a published index;
  // hashes alone cannot identify this crash boundary.
  const indexLock=exists(lockPath);
  if(indexLock){if(identity(indexLock)!==p.lockIdentity||current.index.value.hash!==p.beforeIndex.hash)fail('APPLY_RECOVERY_REQUIRED');await mutate(git,'publish-index',{name:'index',stage:'index.lock',identity:p.lockIdentity,before:p.beforeIndex,after:p.afterIndex});}
  else if(current.index.value.hash!==p.afterIndex.hash||identity(fs.lstatSync(path.join(git.path,'index')))!==p.lockIdentity)fail('APPLY_RECOVERY_REQUIRED');
  hooks.at?.('apply-after-index');current=await context(snapshot,{ownedLock:p.lockIdentity});if(current.head!==p.head||current.index.value.hash!==p.afterIndex.hash||!matches(inventory({ignore:artifacts(p)}),p.newTree,p.allowedDirectories))fail('APPLY_RECOVERY_REQUIRED');
  const result={status:'applied',requestId:p.requestId,checkId:p.checkId,previousHead:p.previousHead,head:p.head,branch:p.branch};
  // Retained originals are cleared only after the durable completed receipt.
  persist({...state,pending:null,cleanup:p,receipts:[...state.receipts,{reviewId:p.reviewId,result}].slice(-64)});hooks.at?.('apply-complete');await cleanup(p);
  return result;
 }
 async function apply({checkId,reviewId,requestId},{validateContext,onAdmission=async()=>{},onProgress=()=>{}}={}){
  if(![checkId,reviewId,requestId].every(uuid))fail('INVALID_REQUEST');if(busy)fail('APPLY_BUSY');busy=true;deadline=Date.now()+GITHUB_APPLY_LIMITS.timeoutMs;
  try{load();if(state.cleanup)fail('APPLY_RECOVERY_REQUIRED');const receipt=state.receipts.find(v=>v.result.requestId===requestId);if(receipt){if(receipt.reviewId!==reviewId||receipt.result.checkId!==checkId)fail('APPLY_REQUEST_REUSED');return receipt.result;}if(state.pending)fail('APPLY_RECOVERY_REQUIRED');const approved=reviews.get(reviewId);if(!approved||approved.checkId!==checkId||approved.expiresAt<Date.now())fail('APPLY_REVIEW_EXPIRED');
   return await snapshots.withSnapshot(checkId,async snapshot=>{
    onProgress({phase:'preparing'});await hostReady(validateContext);const checked=await validate(snapshot);if(snapshot.identity!==approved.snapshotIdentity||checked.index.value.hash!==approved.indexHash||digest(JSON.stringify(checked.inv))!==approved.inventoryHash)fail('APPLY_STALE');
    const tx=directory(transactions,requestId);if(fs.readdirSync(tx.path).length)fail('APPLY_REQUEST_REUSED');const bare=directory(tx,'repository.git');for(const n of ['objects','refs'])directory(bare,n);fs.writeFileSync(path.join(bare.path,'HEAD'),'ref: refs/heads/unused\n',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(bare.path,'config'),'[core]\n repositoryformatversion = 0\n bare = true\n',{flag:'wx',mode:0o600});
    const pack=path.join(tx.path,'objects.pack');await streamGit(snapshot.gitDir,['pack-objects','--revs','--stdout'],{input:snapshot.result.remoteHead+'\n',output:fs.createWriteStream(pack,{flags:'wx',mode:0o600})});await streamGit(bare.path,['index-pack','--stdin','--strict'],{input:fs.createReadStream(pack)});const packState=hashRawFile(pack,{limit:Number.MAX_SAFE_INTEGER,sync:true});
    const indexPath=path.join(tx.path,'target-index');await command(bare.path,['read-tree',snapshot.result.remoteHead],{env:{GIT_INDEX_FILE:indexPath}});const afterIndex=read(indexPath).value;fs.writeFileSync(path.join(tx.path,'old-index'),checked.index.bytes,{flag:'wx',mode:0o600});
    const changed=[];for(const p of [...new Set([...Object.keys(checked.oldTree),...Object.keys(checked.newTree)])].sort())if(!sameTree(own(checked.oldTree,p),own(checked.newTree,p)))changed.push(p);if(changed.length!==snapshot.result.entries.length||changed.some(p=>!snapshot.result.entries.some(e=>e.path===p)))fail('APPLY_STALE');
    const files=[];let stagedBytes=0;for(let i=0;i<changed.length;i++){const p=changed[i],target=own(checked.newTree,p);let after=null;if(target){const output=path.join(tx.path,`blob-${i}`);await streamGit(bare.path,['cat-file','blob',target.sha],{output:fs.createWriteStream(output,{flags:'wx',mode:0o600})});fs.chmodSync(output,target.mode==='100755'?0o755:0o644);after=hashRawFile(output,{limit:Number.MAX_SAFE_INTEGER,sync:true});if(after.sha!==target.sha)fail('APPLY_STALE');stagedBytes+=after.size;if(stagedBytes>GITHUB_APPLY_LIMITS.metadataBytes)fail('APPLY_LIMIT_EXCEEDED');}files.push({path:p,before:side(own(checked.inv.files,p)??null),after:side(after),stage:`.asmb-apply-${requestId}-${i}`,previous:`.asmb-apply-${requestId}-${i}-previous`,parentIdentity:null,stageIdentity:null,done:false});}
    const p={schemaVersion:1,requestId,checkId,reviewId,sourceIdentity:source.identity,gitIdentity:git.identity,transactionIdentity:tx.identity,previousHead:snapshot.result.localHead,head:snapshot.result.remoteHead,branch:snapshot.result.branch,beforeIndex:side(checked.index.value),afterIndex:side(afterIndex),pack:side(packState),lockIdentity:null,files,oldTree:checked.oldTree,newTree:checked.newTree,allowedDirectories:[...new Set([...dirs(checked.oldTree),...dirs(checked.newTree)])],directories:dirs(checked.newTree).filter(d=>!checked.inv.directories.includes(d)).map(path=>({path,identity:null})),removedDirectories:dirs(checked.oldTree).filter(d=>!dirs(checked.newTree).includes(d)).reverse().map(p=>({path:p,identity:pinDirectory(path.join(source.path,p)).identity}))};
    // Flush private object closure, index and retained preimages before any
    // working Git/source publication. Recovery is independent of check expiry.
    const flush=folder=>{for(const n of fs.readdirSync(folder)){const f=path.join(folder,n),s=fs.lstatSync(f);if(s.isDirectory())flush(f);else{const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}sync(folder);};flush(tx.path);
    await hostReady(validateContext);const final=await validate(snapshot);if(final.index.value.hash!==approved.indexHash||digest(JSON.stringify(final.inv))!==approved.inventoryHash)fail('APPLY_STALE');await onAdmission();
    persist({...state,pending:p});hooks.at?.('apply-intent');
    return settle(p,{onProgress});
   });
  }catch(e){load();if(state.pending||state.cleanup)fail('APPLY_RECOVERY_REQUIRED');throw e;}finally{busy=false;deadline=null;}
 }
 async function recover(){if(busy)fail('APPLY_BUSY');busy=true;deadline=Date.now()+GITHUB_APPLY_LIMITS.timeoutMs;try{load();if(!state.pending&&!state.cleanup)return {status:'idle'};const requestId=(state.pending??state.cleanup).requestId;try{if(state.cleanup)await cleanup(state.cleanup);else{const p=state.pending;pendingCheck(p);await settle(p,{recovering:true});}return {status:'recovered',requestId};}catch{return {status:'held',requestId,reason:'recovery-required'};}}finally{busy=false;deadline=null;}}
 return Object.freeze({review,apply,recover,inspect(){load();const p=state.pending??state.cleanup;return {recoveryRequired:p!==null,...(p?{requestId:p.requestId}:{})};}});
}
