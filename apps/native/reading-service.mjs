import {createHash} from 'node:crypto';
import {ReadingHistory,readingLocation} from '../../packages/desktop-host/src/reading-navigation.mjs';
import {COLLECTION_METADATA_PATH,parseCollectionMetadata,portableReference,resolvePortableReference,evidenceContext} from '../../packages/desktop-host/src/reading-reference.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Called only inside the native host's serialized admission queue. No file writer. */
export function createReadingService({repositories,readSnapshot,redirectStore}){
 const history=new ReadingHistory();
 let redirects=[];
 let scan=redirectStore?redirectStore.ensureDurable(redirectStore.scan()):null;
 if(scan?.blocked)fail('READING_RECOVERY_REQUIRED');
 const record=scan?.events.at(-1)?.payload;
 if(record){if(record.schemaVersion!==1||Object.keys(record).length!==2||!Array.isArray(record.redirects)||record.redirects.length>1000||record.redirects.some(value=>!value||Object.keys(value).length!==4||!/^[a-f0-9]{64}$/.test(value.repoId)||!/^[-A-Za-z0-9._:]{1,128}$/.test(value.documentId)||![value.from,value.to].every(path=>typeof path==='string'&&path.length<=2048&&!path.startsWith('/')&&!/[\\\x00-\x1f]/.test(path)&&!path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'||part.startsWith('.asmb-'))))||new Set(record.redirects.map(value=>value.repoId+':'+value.documentId)).size!==record.redirects.length)fail('READING_RECOVERY_REQUIRED');redirects=record.redirects;}
 const persist=()=>{if(!redirectStore)return;const state={schemaVersion:1,redirects};if(scan.tailRecords>=16||scan.coveredFiles.length)scan=redirectStore.compact(scan,state);scan=redirectStore.append(scan,'draft',state);};
 const admitted=repo=>{const entry=repositories().find(item=>item.name===repo);if(!entry)fail('UNKNOWN_REPOSITORY');return entry;};
 async function metadata(repo,ref=''){try{const value=await readSnapshot({repo,path:COLLECTION_METADATA_PATH,ref});return parseCollectionMetadata(value.content);}catch{return parseCollectionMetadata(null);}}
 async function text(repo,path,ref=''){const value=await readSnapshot({repo,path,ref});if(value.type!=='file'||typeof value.content!=='string')fail('READING_UNAVAILABLE');return {text:value.content,sourceHash:hash(value.content)};}
 const location=value=>{const result=readingLocation(value),entry=admitted(result.repo);if(entry.stableId!==result.repoId)fail('REPOSITORY_CHANGED');return result;};
 return Object.freeze({
  async history(input){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['operation','location','direction','token'].includes(key)))fail('INVALID_REQUEST');
   if(input.operation==='state')return history.state();
   if(input.operation==='peek'){
    if(![-1,1].includes(input.direction))fail('INVALID_REQUEST');for(let count=0;count<100;count++){const ticket=history.peek(input.direction);if(!ticket)return null;const entry=repositories().find(item=>item.stableId===ticket.location.repoId);if(!entry){history.cancel(ticket.token);history.removeRepository(ticket.location.repoId);continue;}ticket.location.repo=entry.name;return ticket;}return null;
   }
   if(input.operation==='cancel'){if(typeof input.token!=='string')fail('INVALID_REQUEST');return history.cancel(input.token);}
   if(!['visit','checkpoint','complete'].includes(input.operation))fail('INVALID_REQUEST');
   const value=location(input.location);
   // Opening failures never advance history. Selection/scroll checkpoints contain no document text.
   if(input.operation!=='checkpoint')await readSnapshot({repo:value.repo,path:value.path,ref:value.ref});
   if(input.operation==='complete'){if(typeof input.token!=='string')fail('INVALID_REQUEST');return history.complete(input.token,value);}
   return history[input.operation](value);
  },
  async evidence(input){const entry=admitted(input.repo),redirect=!input.ref&&redirects.find(value=>value.repoId===entry.stableId&&value.to===input.path);return evidenceContext(await metadata(input.repo,input.ref),redirect?.from??input.path);},
  async reference(input){
   const repository=admitted(input.repo),redirect=!input.ref&&redirects.find(value=>value.repoId===repository.stableId&&value.to===input.path);const meta=await metadata(input.repo,input.ref),entry=meta.collection?.documents.find(item=>item.path===(redirect?.from??input.path));
   if(!entry)return {status:'missing',message:'This file has no author-declared portable document ID.'};
   const saved=await text(input.repo,input.path,input.ref);let revision;if(input.ref){const snapshot=await readSnapshot(input);revision=snapshot.resolvedCommit;if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision??''))fail('VERSION_UNAVAILABLE');}
   return {status:'ready',message:'Reference pinned to these saved bytes.',reference:{schemaVersion:1,collectionId:meta.collection.collectionId,documentId:entry.id,sourceHash:saved.sourceHash,...(revision?{revision}:{})}};
  },
  async resolve(input){
   if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['reference','repoId'].includes(key)))fail('INVALID_REQUEST');
   portableReference(input.reference);let entries=repositories();if(input.repoId!==undefined){if(typeof input.repoId!=='string')fail('INVALID_REQUEST');entries=entries.filter(entry=>entry.stableId===input.repoId);}
   const candidates=[];for(const entry of entries.slice(0,256))candidates.push({repo:entry.name,repoId:entry.stableId,metadata:await metadata(entry.name)});
   return resolvePortableReference({reference:input.reference,candidates,redirects,
    // Each callback is an admitted saved/immutable read, never a draft substitution.
    ...{readDocument:(entry,path)=>text(entry.repo,path),readRevision:(entry,path,ref)=>text(entry.repo,path,ref)}});
  },
  async prepareRename(repo,moves){
   const meta=await metadata(repo);if(meta.status!=='ready')return [];
   return moves.flatMap(move=>meta.collection.documents.flatMap(document=>{const current=redirects.find(item=>item.repoId===admitted(repo).stableId&&item.documentId===document.id)?.to??document.path;return current===move.from||current.startsWith(move.from+'/')?[{repoId:admitted(repo).stableId,documentId:document.id,from:document.path,to:move.to+current.slice(move.from.length)}]:[]}));
  },
  renamed(repo,moves,prepared=[]){history.renamePaths(admitted(repo).stableId,moves);for(const value of prepared){redirects=redirects.filter(item=>!(item.repoId===value.repoId&&item.documentId===value.documentId));redirects.push(value);}if(redirects.length>1000)redirects=redirects.slice(-1000);if(prepared.length)persist();},
 });
}
