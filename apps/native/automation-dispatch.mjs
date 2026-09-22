import {createHash,randomUUID} from 'node:crypto';
import {createAutomationBroker} from './automation-broker.mjs';
import {AUTOMATION_LIMITS} from './automation-limits.mjs';
import release from './release.json' with {type:'json'};
import {parsePackage} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
/** Adapts the permission broker to existing admitted host methods; no filesystem writes. */
export function createAutomationDispatch({api,store,write,importArchive,importStatus,applyPackage,validate}){
 const catalog=async()=>(await api.catalog()).repositories;
 async function repo(repoId){if(typeof repoId!=='string')fail('UNKNOWN_REPOSITORY');const entry=(await catalog()).find(item=>item.stableId===repoId);if(!entry)fail('UNKNOWN_REPOSITORY');return entry.name;}
 const packagePlans=new Map();
 const cleanReview=value=>({kind:value.kind,packageDigest:value.packageDigest,collectionId:value.collectionId,version:value.version,semantics:value.semantics,rows:value.rows,drafts:value.drafts,warnings:value.warnings,fileCount:value.fileCount});
 async function prepare(kind,args,operationId){
  const name=await repo(args.repoId);
  if(kind==='write.plan'){if(!exact(args,['repoId','path','expectedHash','text']))fail('INVALID_REQUEST');return write({...args,repo:name},false);}
  if(kind==='import.plan'){
   if(!exact(args,['repoId','name','archiveBase64'])||typeof args.name!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(args.name))fail('INVALID_REQUEST');
   if((await catalog()).some(entry=>entry.name.toLowerCase()===args.name.toLowerCase()))fail('NAME_EXISTS');
   const bytes=Buffer.from(args.archiveBase64,'base64'),archive=parsePackage(bytes);
   return {kind:'import',into:'asMagicBrain',name:args.name,archiveSha256:hash(bytes),files:archive.files.map(file=>({path:file.path,bytes:file.bytes.length,sha256:hash(file.bytes)})),history:'Unborn local Git repository. No commit, remote connection or code execution.'};
  }
  if(kind==='package.plan'){
   if(!exact(args,['repoId','archiveBase64','semantics','version','choices']))fail('INVALID_REQUEST');
   const review=await api.reviewPackageUpdate({repo:name,bytes:Buffer.from(args.archiveBase64,'base64'),semantics:args.semantics,version:args.version});packagePlans.set(operationId,review.planId);return {...cleanReview(review),choices:args.choices};
  }
  if(kind==='export.plan'){
   if(!exact(args,['repoId','kind','collectionId','version'])||!['source','offline'].includes(args.kind))fail('INVALID_REQUEST');
   const review=await api.reviewPackageExport({repo:name,collectionId:args.collectionId,version:args.version});packagePlans.set(operationId,review.planId);return {...cleanReview(review),exportKind:args.kind};
  }
  fail('UNKNOWN_OPERATION');
 }
 return createAutomationBroker({store,catalog,prepare,validate,capabilities:{application:{version:release.version,buildNumber:release.buildNumber},protocolVersion:1,formats:[{format:'markdown',importSupported:true,previewSupported:true,runtimeEligible:false,executionPermitted:false},{format:'math',importSupported:true,previewSupported:true,runtimeEligible:false,executionPermitted:false},{format:'mermaid',importSupported:true,previewSupported:true,runtimeEligible:false,executionPermitted:false},{format:'html',importSupported:true,previewSupported:'source',runtimeEligible:'requires-declared-local-artifact-review',executionPermitted:false},{format:'artifact-manifest',importSupported:true,previewSupported:'static-fallback',runtimeEligible:'validate-first',executionPermitted:false}]},
  read:async args=>{if(!exact(args,['repoId','path']))fail('INVALID_REQUEST');const name=await repo(args.repoId),value=await api.read({repo:name,path:args.path,ref:''});if(value.type!=='file'||typeof value.content!=='string')fail('TEXT_UNAVAILABLE');if(Buffer.byteLength(value.content)>65536)fail('LIMIT_EXCEEDED');return {repoId:args.repoId,path:args.path,text:value.content,sourceHash:hash(value.content),source:'saved'};},
  search:async args=>{if(!exact(args,['repoId','query','caseSensitive']))fail('INVALID_REQUEST');return api.searchRepositoryText({repo:await repo(args.repoId),query:args.query,caseSensitive:args.caseSensitive,requestId:randomUUID()});},
  apply:async(kind,args,operationId)=>{const name=await repo(args.repoId);
   if(kind==='write.plan')return write({...args,repo:name},true);
   if(kind==='import.plan')return importArchive({name:args.name,bytes:Buffer.from(args.archiveBase64,'base64'),requestId:operationId,initializeHistory:false});
   if(kind==='package.plan')return applyPackage({repo:name,planId:packagePlans.get(operationId),choices:args.choices},operationId);
   if(kind==='export.plan'){const output=await api.buildPackageExport({repo:name,planId:packagePlans.get(operationId),kind:args.kind});if(output.bytes.length>AUTOMATION_LIMITS.exportArchiveBytes)fail('LIMIT_EXCEEDED');return {filename:output.filename,sha256:output.sha256,archiveBase64:Buffer.from(output.bytes).toString('base64'),warnings:output.warnings};}
   fail('UNKNOWN_OPERATION');
  },
  inspectInterrupted:async operation=>{
   const args=operation.args,name=await repo(args.repoId);
   if(operation.kind==='write.plan'){try{const value=await api.read({repo:name,path:args.path,ref:''});if(typeof value.content==='string'&&hash(value.content)===hash(args.text))return {completed:true,result:{path:args.path,sourceHash:hash(value.content),recovered:true}};}catch{}return null;}
   // The importer itself binds request ID, archive digest and publication record.
   if(operation.kind==='import.plan'){const result=await importStatus({name:args.name,archiveSha256:hash(Buffer.from(args.archiveBase64,'base64')),requestId:operation.operationId,initializeHistory:false});return result?{completed:true,result}:null;}
   if(operation.kind==='package.plan'){const status=await api.packageStatus({repo:name}),matched=status.operations.find(item=>item.operationId===operation.operationId);if(matched?.status==='completed')return {completed:true,result:{status:'completed',operationId:operation.operationId,changedPaths:matched.paths,recovered:true}};if(status.pending?.operationId===operation.operationId)return {pending:true};return null;}
   return null;
  },
 });
}
