import {persistentIdentity, currentStorageIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {pinDirectory,checkDirectory} from '../physical-roots.mjs';
import {portablePathKey,isPortableRelativePath} from '../../../source-foundation/src/domain/path-policy.mjs';
import {copyLocalRepository} from './copy-repository.mjs';
import {initializeEmptyRepository} from '../local-git/initialize-empty.mjs';
import {cloneGitHubRepository,canonicalGitHubUrl} from '../local-git/github-clone.mjs';

export const BUILTIN_REPOSITORIES=Object.freeze([
 {name:'Workspace',privateRepo:true},{name:'asTeach-App',privateRepo:false},
 {name:'asTeach-Founders',privateRepo:true},{name:'asTeach-v01-Acceptance-01',privateRepo:true},{name:'asTeach-Docs',privateRepo:true}
].map(Object.freeze));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const identity=persistentIdentity;
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const sync=directory=>{const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
export function validRepositoryName(name){return typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)&&isPortableRelativePath(name);}
function readRecord(filename){
 let stat=exists(filename);if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>16384)fail('CATALOG_UNAVAILABLE');
 if(stat.nlink!==1){
  const prefix=path.basename(filename)+'.',directory=path.dirname(filename);
  const aliases=fs.readdirSync(directory).filter(name=>name.startsWith(prefix)&&/^[a-f0-9-]{36}\.tmp$/.test(name.slice(prefix.length))).map(name=>path.join(directory,name)).filter(name=>{const candidate=fs.lstatSync(name);return candidate.isFile()&&!candidate.isSymbolicLink()&&identity(candidate)===identity(stat);});
  if(aliases.length!==stat.nlink-1)fail('CATALOG_UNAVAILABLE');
  // Atomic no-replace publication may have completed just before a crash.
  // Retire only our exact duplicate temporary names, preserving final bytes.
  for(const alias of aliases){if(identity(fs.lstatSync(alias))!==identity(stat))fail('CATALOG_UNAVAILABLE');fs.unlinkSync(alias);}sync(directory);stat=fs.lstatSync(filename);
  if(stat.nlink!==1)fail('CATALOG_UNAVAILABLE');
 }
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(fd);if(identity(before)!==identity(stat))fail('CATALOG_UNAVAILABLE');const raw=fs.readFileSync(fd,'utf8');const after=fs.fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||identity(fs.lstatSync(filename))!==identity(before))fail('CATALOG_UNAVAILABLE');return JSON.parse(raw);}finally{fs.closeSync(fd);}
}
function writeRecord(filename,value){
 const bytes=Buffer.from(JSON.stringify(value)),temporary=`${filename}.${randomUUID()}.tmp`;
 const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{fs.linkSync(temporary,filename);if(exists(temporary))fs.unlinkSync(temporary);sync(path.dirname(filename));}catch(e){if(exists(temporary))fs.unlinkSync(temporary);throw e;}
}
function lockActive(lockPath){
 if(!exists(lockPath))return false;
 let value;try{value=readRecord(lockPath);}catch{fail('IMPORT_BUSY');}
 if(value.schemaVersion!==1||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.token!=='string')fail('IMPORT_BUSY');
 try{process.kill(value.pid,0);return true;}catch(error){if(error.code!=='ESRCH')return true;}
 // The recorded process no longer exists. Recheck exact file before retiring
 // this known-owner lock; unknown/empty locks are never broken automatically.
 const before=fs.lstatSync(lockPath),again=readRecord(lockPath);
 if(JSON.stringify(again)!==JSON.stringify(value)||identity(fs.lstatSync(lockPath))!==identity(before))fail('IMPORT_BUSY');
 fs.unlinkSync(lockPath);sync(path.dirname(lockPath));return false;
}
export const validCreationId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function validRecord(record){
 const common=validRepositoryName(record?.name)&&typeof record.identity==='string'&&/^\d+:\d+$/.test(record.identity)&&Number.isSafeInteger(record.files)&&record.files>=0&&Number.isSafeInteger(record.bytes)&&record.bytes>=0;
 return common&&(record.schemaVersion===1&&/^[a-f0-9]{40}$/.test(record.head)&&/^[a-f0-9]{64}$/.test(record.archiveSha256)
  ||record.schemaVersion===2&&record.source==='local'&&validCreationId(record.creationId)&&validCreationId(record.stageId)&&validRepositoryName(record.requestName)&&record.head===null&&record.files===0&&record.bytes===0
  ||record.schemaVersion===4&&record.source==='local-copy'&&typeof record.copySourceIdentity==='string'&&/^\d+:\d+$/.test(record.copySourceIdentity)&&validRepositoryName(record.copySourceName)&&validCreationId(record.creationId)&&validCreationId(record.stageId)&&validRepositoryName(record.requestName)&&(record.head===null||/^[a-f0-9]{40}$/.test(record.head))
  ||record.schemaVersion===3&&record.source==='github'&&validCreationId(record.creationId)&&validCreationId(record.stageId)&&validRepositoryName(record.requestName)&&(record.head===null||/^[a-f0-9]{40}$/.test(record.head))&&typeof record.branch==='string'&&record.branch.length>0&&record.branch.length<1024&&typeof record.sourceUrl==='string'&&(()=>{try{return canonicalGitHubUrl(record.sourceUrl)===record.sourceUrl;}catch{return false;}})());
}

/** Host-owned org root, never a renderer-provided path. Imported names are
 * admitted only by durable records bound to their published physical folder. */
export function createRepositoryCatalog(base,{builtinRepositories=BUILTIN_REPOSITORIES}={}){
 if(!Array.isArray(builtinRepositories)||builtinRepositories.length>100||builtinRepositories.some(r=>!r||!validRepositoryName(r.name)||typeof r.privateRepo!=='boolean')||new Set(builtinRepositories.map(r=>portablePathKey(r.name))).size!==builtinRepositories.length)fail('INVALID_CATALOG');
 const builtins=builtinRepositories.map(r=>Object.freeze({name:r.name,privateRepo:r.privateRepo,...(r.builtin==='documentation'&&r.readOnly===true?{builtin:'documentation',readOnly:true}:{})}));
 const root=pinDirectory(path.resolve(base)),directory=path.join(root.path,'.asmb-catalog');
 const check=()=>checkDirectory(root);
 function catalogPin(create=false){check();let s=exists(directory);if(!s){if(!create)return null;fs.mkdirSync(directory,{mode:0o700});sync(root.path);s=exists(directory);}if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700)fail('CATALOG_UNAVAILABLE');return pinDirectory(directory);}
 function ensure(){return catalogPin(true);}
 function records(){
  const pin=catalogPin();if(!pin)return [];
  const result=[],keys=new Set(builtins.map(r=>portablePathKey(r.name))),creations=new Set();
  for(const file of fs.readdirSync(pin.path).filter(n=>n.endsWith('.repo.json'))){
   const record=readRecord(path.join(pin.path,file));if(!validRecord(record)||file!==`${record.name}.repo.json`||keys.has(portablePathKey(record.name)))fail('CATALOG_UNAVAILABLE');
   if(record.schemaVersion>=2){if(creations.has(record.creationId))fail('CATALOG_UNAVAILABLE');creations.add(record.creationId);}
   const source=pinDirectory(path.join(root.path,record.name));if(source.identity!==record.identity)fail('REPOSITORY_CHANGED');
   keys.add(portablePathKey(record.name));result.push(record);
  }
  checkDirectory(pin);check();return result;
 }
 function list(){return [...builtins.filter(r=>r.builtin!=='documentation'),...records().sort((a,b)=>a.name.localeCompare(b.name)).map(r=>({name:r.name,privateRepo:true})),...builtins.filter(r=>r.builtin==='documentation')];}
 function assertKnown(name){if(!validRepositoryName(name)||!list().some(r=>r.name===name))fail('UNKNOWN_REPOSITORY');check();}
 function provenance(name){assertKnown(name);const record=records().find(value=>value.name===name);return record?.source==='github'?structuredClone(record):null;}
 function assertAvailable(name){
  if(!validRepositoryName(name))fail('INVALID_REPOSITORY_NAME');const key=portablePathKey(name);
  if(list().some(r=>portablePathKey(r.name)===key)||fs.readdirSync(root.path).some(n=>portablePathKey(n)===key))fail('NAME_EXISTS');
 }
 function register(record){if(!validRecord(record))fail('CATALOG_UNAVAILABLE');const pin=ensure();check();const source=pinDirectory(path.join(root.path,record.name));if(source.identity!==record.identity)fail('REPOSITORY_CHANGED');writeRecord(path.join(pin.path,`${record.name}.repo.json`),record);checkDirectory(pin);}
 function created(requestId,name,source='local',sourceUrl=null){
  const matches=records().filter(item=>item.schemaVersion>=2&&item.creationId===requestId);
  if(matches.length>1)fail('CATALOG_UNAVAILABLE');
  if(matches.length&&(matches[0].requestName!==name||matches[0].source!==source||(source==='github'&&matches[0].sourceUrl!==sourceUrl)))fail('REQUEST_CONFLICT');
  return matches[0]??null;
 }
 // Reuse ZIP publication's durable ready record and exclusive destination
 // reservation. An unrecorded destination is never adopted, even when empty.
 function finishCreation(record,{at=()=>{}}={}){
  if(!validRecord(record)||record.schemaVersion<2)fail('CATALOG_UNAVAILABLE');
  const admitted=created(record.creationId,record.requestName,record.source,record.sourceUrl);
  if(admitted){if(JSON.stringify({...record,name:admitted.name})!==JSON.stringify(admitted))fail('CATALOG_UNAVAILABLE');return admitted;}
  const pin=ensure(),id=record.creationId,staging=path.join(root.path,`.asmb-import-${record.stageId}`),destination=path.join(root.path,record.name);
  const receiptPath=path.join(pin.path,`${id}.reservation.json`);let target=exists(destination);
  if(!target){
   if(exists(receiptPath))fail('RECOVERY_REQUIRED');
   const stage=pinDirectory(staging);if(stage.identity!==record.identity)fail('REPOSITORY_CHANGED');
   assertAvailable(record.name);checkDirectory(stage);checkDirectory(pin);check();
   fs.mkdirSync(destination,{mode:0o700});sync(root.path);target=exists(destination);at('create-reserved-before-receipt');
   writeRecord(receiptPath,{schemaVersion:1,name:record.name,identity:identity(target)});at('create-reserved');
  }
  if(identity(target)!==record.identity){
   if(!exists(receiptPath))fail('RECOVERY_REQUIRED');
   const receipt=readRecord(receiptPath),reserved=pinDirectory(destination),stage=pinDirectory(staging);
   if(receipt.schemaVersion!==1||receipt.name!==record.name||receipt.identity!==reserved.identity||stage.identity!==record.identity||fs.readdirSync(destination).length)fail('RECOVERY_REQUIRED');
   checkDirectory(pin);checkDirectory(reserved);checkDirectory(stage);check();at('create-before-publish');
   fs.renameSync(staging,destination);sync(root.path);at('create-published');
  }
  const final=path.join(pin.path,`${record.name}.repo.json`);at('create-before-register');
  if(!exists(final))register(record);else if(JSON.stringify(readRecord(final))!==JSON.stringify(record))fail('CATALOG_UNAVAILABLE');
  at('create-cataloged');return record;
 }
 // The native host owns the durable rename intent and has already moved the
 // exact source folder. Publish the new registration before retiring the old
 // one; both states can be completed idempotently after an interrupted write.
 function renameRegistration({repository,name,identity:expectedIdentity}){
  if(!validRepositoryName(repository)||!validRepositoryName(name)||portablePathKey(repository)===portablePathKey(name)||!/^\d+:\d+$/.test(expectedIdentity))fail('INVALID_REPOSITORY_NAME');
  const pin=ensure(),source=pinDirectory(path.join(root.path,name));if(source.identity!==expectedIdentity||exists(path.join(root.path,repository)))fail('REPOSITORY_CHANGED');
  const oldFile=path.join(pin.path,`${repository}.repo.json`),newFile=path.join(pin.path,`${name}.repo.json`);
  const before=exists(oldFile)?readRecord(oldFile):null,after=exists(newFile)?readRecord(newFile):null;
  if(before&&(!validRecord(before)||before.name!==repository||before.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(after&&(!validRecord(after)||after.name!==name||after.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(!before&&!after)fail('CATALOG_UNAVAILABLE');
  const next=before?{...before,name}:after;
  if(after&&JSON.stringify(after)!==JSON.stringify(next))fail('CATALOG_UNAVAILABLE');
  checkDirectory(source);checkDirectory(pin);check();
  if(!after)writeRecord(newFile,next);
  if(before){if(JSON.stringify(readRecord(oldFile))!==JSON.stringify(before))fail('CATALOG_UNAVAILABLE');fs.unlinkSync(oldFile);sync(pin.path);}
  checkDirectory(source);checkDirectory(pin);check();
 }
 // Repository Trash retains catalog provenance independently of active names.
 function retiredRecords(){
  const pin=catalogPin();if(!pin)return [];
  return fs.readdirSync(pin.path).filter(n=>/^trash-[a-f0-9-]{36}\.json$/.test(n)).map(n=>{
   const entry=readRecord(path.join(pin.path,n));
   if(entry.schemaVersion!==1||!validCreationId(entry.trashId)||n!==`trash-${entry.trashId}.json`||!validRecord(entry.record))fail('CATALOG_UNAVAILABLE');
   return entry;
  });
 }
 function retireRegistration({repository,trashId,identity:expectedIdentity}){
  if(!validRepositoryName(repository)||!validCreationId(trashId))fail('INVALID_REQUEST');
  const pin=ensure(),from=path.join(pin.path,`${repository}.repo.json`),to=path.join(pin.path,`trash-${trashId}.json`);
  const old=exists(from)?readRecord(from):null,retired=exists(to)?readRecord(to):null;
  if(old&&(!validRecord(old)||old.name!==repository||old.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(retired&&(retired.schemaVersion!==1||retired.trashId!==trashId||!validRecord(retired.record)||retired.record.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(!old&&!retired)fail('CATALOG_UNAVAILABLE');
  if(old&&retired&&JSON.stringify(old)!==JSON.stringify(retired.record))fail('CATALOG_UNAVAILABLE');
  if(pinDirectory(path.join(root.path,`.asmb-repository-trash-${trashId}`)).identity!==expectedIdentity||exists(path.join(root.path,repository)))fail('REPOSITORY_CHANGED');
  checkDirectory(pin);check();if(!retired)writeRecord(to,{schemaVersion:1,trashId,record:old});
  if(old){if(JSON.stringify(readRecord(from))!==JSON.stringify(old))fail('CATALOG_UNAVAILABLE');fs.unlinkSync(from);sync(pin.path);}
 }
 function restoreRegistration({trashId,name,identity:expectedIdentity}){
  if(!validRepositoryName(name)||!validCreationId(trashId))fail('INVALID_REQUEST');
  const pin=ensure(),from=path.join(pin.path,`trash-${trashId}.json`),to=path.join(pin.path,`${name}.repo.json`);
  const retired=exists(from)?readRecord(from):null,active=exists(to)?readRecord(to):null;
  if(retired&&(retired.schemaVersion!==1||retired.trashId!==trashId||!validRecord(retired.record)||retired.record.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(active&&(!validRecord(active)||active.name!==name||active.identity!==expectedIdentity))fail('CATALOG_UNAVAILABLE');
  if(!retired&&!active)fail('CATALOG_UNAVAILABLE');
  const next=retired?{...retired.record,name}:active;
  if(active&&JSON.stringify(active)!==JSON.stringify(next))fail('CATALOG_UNAVAILABLE');
  if(pinDirectory(path.join(root.path,name)).identity!==expectedIdentity||exists(path.join(root.path,`.asmb-repository-trash-${trashId}`)))fail('REPOSITORY_CHANGED');
  checkDirectory(pin);check();if(!active)writeRecord(to,next);
  if(retired){if(JSON.stringify(readRecord(from))!==JSON.stringify(retired))fail('CATALOG_UNAVAILABLE');fs.unlinkSync(from);sync(pin.path);}
 }
 // Only finish catalog publication for a complete, already-published folder
 // whose identity matches our durable ready record. Never overwrite or delete.
 function recover(){
  const pin=catalogPin();if(!pin)return;
  if(lockActive(path.join(pin.path,'import.lock')))return;
  const retired=retiredRecords();
  const admittedCreations=new Map(records().filter(record=>record.schemaVersion>=2).map(record=>[record.creationId,record]));
  for(const file of fs.readdirSync(pin.path).filter(n=>n.endsWith('.ready.json'))){
   const record=readRecord(path.join(pin.path,file));if(!validRecord(record))fail('CATALOG_UNAVAILABLE');
   if(retired.some(entry=>entry.record.identity===record.identity))continue;
   if(record.schemaVersion>=2){
    if(file!==`${record.creationId}.ready.json`)fail('CATALOG_UNAVAILABLE');
    const admitted=admittedCreations.get(record.creationId);
    if(admitted){if(JSON.stringify({...record,name:admitted.name})!==JSON.stringify(admitted))fail('CATALOG_UNAVAILABLE');}
    else admittedCreations.set(record.creationId,finishCreation(record));
    continue;
   }
   const destination=path.join(root.path,record.name);let target=exists(destination);
   const reservationPath=path.join(pin.path,file.replace('.ready.json','.reservation.json'));
   if(target&&identity(target)!==record.identity&&exists(reservationPath)){
    const reservation=readRecord(reservationPath),staging=path.join(root.path,`.asmb-import-${file.slice(0,-'.ready.json'.length)}`);
    if(reservation.schemaVersion===1&&reservation.name===record.name&&reservation.identity===identity(target)&&exists(staging)&&identity(fs.lstatSync(staging))===record.identity){
     const reservedPin=pinDirectory(destination),stagePin=pinDirectory(staging);check();checkDirectory(pin);
     if(fs.readdirSync(destination).length===0){checkDirectory(reservedPin);checkDirectory(stagePin);fs.renameSync(staging,destination);sync(root.path);target=exists(destination);}
    }
   }
   if(!target||identity(target)!==record.identity)continue;
   const final=path.join(pin.path,`${record.name}.repo.json`);
   if(!exists(final))register(record);else if(JSON.stringify(readRecord(final))!==JSON.stringify(record))fail('CATALOG_UNAVAILABLE');
  }
 }
 return {root:root.path,directory,ensure,list,assertKnown,provenance,assertAvailable,register,created,finishCreation,renameRegistration,retireRegistration,restoreRegistration,recover,check,writeRecord};
}

function runWorker(archivePath,destination){return new Promise((resolve,reject)=>{
 const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{archivePath,destination,storageIdentity:currentStorageIdentity()}});let result;
 worker.once('message',message=>{result=message;});worker.once('error',reject);
 worker.once('exit',code=>{if(code!==0||!result)reject(Object.assign(new Error('IMPORT_FAILED'),{code:'IMPORT_FAILED'}));else if(!result.ok)reject(Object.assign(new Error(result.code),{code:result.code}));else resolve(result.value);});
});}

export function createRepositoryImporter({base,builtinRepositories,hooks={}}){
 const catalog=createRepositoryCatalog(base,{builtinRepositories});catalog.ensure();catalog.recover();
 async function createRepository({name,requestId}){
  if(!validRepositoryName(name))fail('INVALID_REPOSITORY_NAME');if(!validCreationId(requestId))fail('INVALID_REQUEST');
  const at=point=>hooks.at?.(point),pin=catalog.ensure(),lockPath=path.join(pin.path,'import.lock');
  if(lockActive(lockPath))fail('IMPORT_BUSY');
  try{writeRecord(lockPath,{schemaVersion:1,pid:process.pid,token:randomUUID()});}catch(error){if(error.code==='EEXIST')fail('IMPORT_BUSY');throw error;}
  // A process can stop before it records the stage identity. Each attempt gets
  // a new stage; retries preserve such unowned remnants instead of adopting or
  // deleting them, and are not blocked by the previous attempt's directory.
  const stageId=randomUUID(),lockIdentity=identity(fs.lstatSync(lockPath)),staging=path.join(catalog.root,`.asmb-import-${stageId}`),readyPath=path.join(pin.path,`${requestId}.ready.json`);let stagePin,ready=false;
  try{
   let record=catalog.created(requestId,name);
   if(!record&&exists(readyPath)){record=readRecord(readyPath);if(!validRecord(record)||record.schemaVersion!==2||record.creationId!==requestId||record.requestName!==name)fail('REQUEST_CONFLICT');ready=true;}
   if(!record){
    catalog.assertAvailable(name);fs.mkdirSync(staging,{mode:0o700});stagePin=pinDirectory(staging);sync(catalog.root);at('create-staging');
    await initializeEmptyRepository(staging);checkDirectory(stagePin);checkDirectory(pin);catalog.assertAvailable(name);at('create-initialized');
    record={schemaVersion:2,source:'local',creationId:requestId,stageId,requestName:name,name,identity:stagePin.identity,head:null,files:0,bytes:0,createdAt:new Date().toISOString()};
    at('create-before-ready');writeRecord(readyPath,record);ready=true;at('create-ready');
   }
   const result=catalog.finishCreation(record,{at});return {name:result.name,organization:'asMagicBrain',head:null,files:0,bytes:0};
  }catch(error){
   // Before readiness, only this operation's exact staging tree can be removed.
   // Durable or uncertain state remains for recovery; never remove a destination.
   if(stagePin&&!ready&&!exists(readyPath)){try{checkDirectory(stagePin);fs.rmSync(staging,{recursive:true});sync(catalog.root);}catch{}}
   throw error;
  }finally{const live=exists(lockPath);if(live&&identity(live)===lockIdentity)fs.unlinkSync(lockPath);sync(pin.path);}
 }
 async function cloneRepository({name,url,requestId},{signal,credential,onProgress=()=>{}}={}){
  if(!validRepositoryName(name))fail('INVALID_REPOSITORY_NAME');if(!validCreationId(requestId))fail('INVALID_REQUEST');const sourceUrl=canonicalGitHubUrl(url);
  const at=point=>hooks.at?.(point.replace(/^create-/,'clone-')),pin=catalog.ensure(),lockPath=path.join(pin.path,'import.lock');
  if(lockActive(lockPath))fail('IMPORT_BUSY');
  try{writeRecord(lockPath,{schemaVersion:1,pid:process.pid,token:randomUUID()});}catch(error){if(error.code==='EEXIST')fail('IMPORT_BUSY');throw error;}
  const stageId=randomUUID(),lockIdentity=identity(fs.lstatSync(lockPath)),staging=path.join(catalog.root,`.asmb-import-${stageId}`),readyPath=path.join(pin.path,`${requestId}.ready.json`);let stagePin,ready=false;
  try{
   let record=catalog.created(requestId,name,'github',sourceUrl);
   if(!record&&exists(readyPath)){record=readRecord(readyPath);if(!validRecord(record)||record.schemaVersion!==3||record.creationId!==requestId||record.requestName!==name||record.sourceUrl!==sourceUrl)fail('REQUEST_CONFLICT');ready=true;}
   if(!record){
    if(signal?.aborted)fail('CLONE_CANCELLED');catalog.assertAvailable(name);fs.mkdirSync(staging,{mode:0o700});stagePin=pinDirectory(staging);sync(catalog.root);at('clone-staging');
    const result=await cloneGitHubRepository({sourceRoot:staging,url:sourceUrl,signal,credential,onProgress,acquire:hooks.cloneAcquire});checkDirectory(stagePin);checkDirectory(pin);catalog.assertAvailable(name);at('clone-initialized');
    record={schemaVersion:3,source:'github',creationId:requestId,stageId,requestName:name,name,identity:stagePin.identity,...result,createdAt:new Date().toISOString()};
    at('clone-before-ready');if(signal?.aborted)fail('CLONE_CANCELLED');writeRecord(readyPath,record);ready=true;at('clone-ready');
   }
   // From the durable ready point onwards publication wins the cancel race.
   // The caller receives the registered result instead of an ambiguous abort.
   onProgress({phase:'publishing'});const result=catalog.finishCreation(record,{at});
   return {name:result.name,organization:'asMagicBrain',head:result.head,files:result.files,bytes:result.bytes,branch:result.branch,sourceUrl:result.sourceUrl};
  }catch(error){
   if(stagePin&&!ready&&!exists(readyPath)){try{checkDirectory(stagePin);fs.rmSync(staging,{recursive:true});sync(catalog.root);}catch{}}
   throw error;
  }finally{const live=exists(lockPath);if(live&&identity(live)===lockIdentity)fs.unlinkSync(lockPath);sync(pin.path);}
 }
 async function duplicateRepository({sourceRoot,name,requestId,head}){
  if(!validRepositoryName(name)||!validCreationId(requestId))fail('INVALID_REQUEST');
  const at=point=>hooks.at?.(point.replace(/^create-/,'duplicate-')),pin=catalog.ensure(),lockPath=path.join(pin.path,'import.lock');
  if(lockActive(lockPath))fail('IMPORT_BUSY');
  try{writeRecord(lockPath,{schemaVersion:1,pid:process.pid,token:randomUUID()});}catch(error){if(error.code==='EEXIST')fail('IMPORT_BUSY');throw error;}
  const lockIdentity=identity(fs.lstatSync(lockPath)),stageId=randomUUID(),staging=path.join(catalog.root,`.asmb-import-${stageId}`),readyPath=path.join(pin.path,`${requestId}.ready.json`);let stagePin,ready=false;
  try{
   const original=pinDirectory(sourceRoot);let record=catalog.created(requestId,name,'local-copy');
   if(record&&(record.copySourceIdentity!==original.identity))fail('REQUEST_CONFLICT');
   if(!record&&exists(readyPath)){record=readRecord(readyPath);if(!validRecord(record)||record.schemaVersion!==4||record.creationId!==requestId||record.requestName!==name||record.copySourceIdentity!==original.identity)fail('REQUEST_CONFLICT');ready=true;}
   if(!record){
    catalog.assertAvailable(name);fs.mkdirSync(staging,{mode:0o700});stagePin=pinDirectory(staging);sync(catalog.root);at('duplicate-staging');
    const result=await copyLocalRepository({sourceRoot,destination:staging});checkDirectory(stagePin);checkDirectory(pin);catalog.assertAvailable(name);
    record={schemaVersion:4,source:'local-copy',copySourceIdentity:original.identity,copySourceName:path.basename(sourceRoot),creationId:requestId,stageId,requestName:name,name,identity:stagePin.identity,head,files:result.files,bytes:result.bytes,createdAt:new Date().toISOString()};
    at('duplicate-before-ready');writeRecord(readyPath,record);ready=true;at('duplicate-ready');
   }
   const result=catalog.finishCreation(record,{at});return {name:result.name,organization:'asMagicBrain',head:result.head,files:result.files,bytes:result.bytes};
  }catch(error){
   if(stagePin&&!ready&&!exists(readyPath)){try{checkDirectory(stagePin);fs.rmSync(staging,{recursive:true});sync(catalog.root);}catch{}}
   throw error;
  }finally{const live=exists(lockPath);if(live&&identity(live)===lockIdentity)fs.unlinkSync(lockPath);sync(pin.path);}
 }
 async function importArchive({name,archivePath}){
  catalog.assertAvailable(name);const pin=catalog.ensure(),lockPath=path.join(pin.path,'import.lock');
  if(lockActive(lockPath))fail('IMPORT_BUSY');
  try{writeRecord(lockPath,{schemaVersion:1,pid:process.pid,token:randomUUID()});}catch(e){if(e.code==='EEXIST')fail('IMPORT_BUSY');throw e;}
  const lockIdentity=identity(fs.lstatSync(lockPath)),id=randomUUID(),staging=path.join(catalog.root,`.asmb-import-${id}`);let reserved=null,stagePin=null,ready=false;
  try{
   catalog.assertAvailable(name);fs.mkdirSync(staging,{mode:0o700});stagePin=pinDirectory(staging);sync(catalog.root);
   const result=await runWorker(archivePath,staging);checkDirectory(stagePin);checkDirectory(pin);catalog.assertAvailable(name);
   const record={schemaVersion:1,name,identity:stagePin.identity,head:result.head,archiveSha256:result.archiveSha256,files:result.files,bytes:result.bytes,excludedEntries:result.excludedEntries,importedAt:new Date().toISOString()};
   writeRecord(path.join(pin.path,`${id}.ready.json`),record);ready=true;
   const destination=path.join(catalog.root,name);fs.mkdirSync(destination,{mode:0o700});reserved=pinDirectory(destination);
   writeRecord(path.join(pin.path,`${id}.reservation.json`),{schemaVersion:1,name,identity:reserved.identity});
   catalog.check();checkDirectory(stagePin);checkDirectory(reserved);
   // rename replaces only the empty directory reserved by this operation.
   if(fs.readdirSync(destination).length)fail('NAME_EXISTS');fs.renameSync(staging,destination);sync(catalog.root);reserved=null;
   catalog.register(record);
   return {name,organization:'asMagicBrain',head:record.head,files:record.files,bytes:record.bytes,excludedEntries:record.excludedEntries};
  }catch(error){
   // Remove only our still-empty reservation; preserve extracted data for recovery.
   if(reserved){try{checkDirectory(reserved);if(fs.readdirSync(reserved.path).length===0)fs.rmdirSync(reserved.path);}catch{}}
   if(stagePin&&!ready){try{checkDirectory(stagePin);fs.rmSync(staging,{recursive:true});sync(catalog.root);}catch{}}
   throw error;
  }finally{const live=exists(lockPath);if(live&&identity(live)===lockIdentity)fs.unlinkSync(lockPath);sync(pin.path);}
 }
 return {catalog,importArchive,createRepository,cloneRepository,duplicateRepository};
}
