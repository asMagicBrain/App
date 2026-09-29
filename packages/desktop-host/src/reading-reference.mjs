/** Portable author declarations. Parsing grants no repository or file authority. */
export const COLLECTION_METADATA_PATH = 'asmagicbrain.collection.json';
export const COLLECTION_METADATA_LIMIT = 65536;
const id = value => typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const hash = value => typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const text = (value,max=1024)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b-\u001f]/u.test(value);
const path = value=>text(value,2048)&&value.length>0&&!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git');
const status=(state,message,extra={})=>({status:state,message,...extra});
export function parseCollectionMetadata(source) {
 if(typeof source!=='string')return status('missing','No portable collection metadata.');
 if(new TextEncoder().encode(source).byteLength>COLLECTION_METADATA_LIMIT)return status('invalid','Collection metadata is too large. Markdown remains available.');
 let data;try{data=JSON.parse(source);}catch{return status('invalid','Collection metadata is malformed. Markdown remains available.');}
 if(data?.schemaVersion!==1)return status('unsupported','This collection metadata version is not supported. Markdown remains available.');
 if(!id(data.collectionId)||!Array.isArray(data.documents)||data.documents.length>256)return status('invalid','Collection identity or document list is invalid.');
 const documents=[],ids=new Set(),paths=new Set();
 for(const entry of data.documents){
  if(!entry||!id(entry.id)||!path(entry.path))return status('invalid','A collection document identity or path is invalid.');
  if(ids.has(entry.id)||paths.has(entry.path.toLowerCase()))return status('ambiguous','Duplicate document IDs or paths require explicit correction.');
  ids.add(entry.id);paths.add(entry.path.toLowerCase());const document={id:entry.id,path:entry.path,targets:[],evidence:null};
  if(entry.targets!==undefined){if(!Array.isArray(entry.targets)||entry.targets.length>256)return status('invalid','Too many document targets.');const targets=new Set();for(const target of entry.targets){if(!target||!id(target.id)||!['heading','block','equation'].includes(target.kind)||!hash(target.sourceHash)||!Number.isSafeInteger(target.from)||!Number.isSafeInteger(target.to)||target.from<0||target.to<=target.from||target.to>1048576)return status('invalid','Explicit targets require an exact source hash and range.');if(targets.has(target.id))return status('ambiguous','Duplicate target IDs require explicit correction.');targets.add(target.id);document.targets.push({id:target.id,kind:target.kind,sourceHash:target.sourceHash,from:target.from,to:target.to});}}
  if(entry.evidence!==undefined){if(!entry.evidence||typeof entry.evidence!=='object'||Array.isArray(entry.evidence))return status('invalid','Evidence declarations must be an object.');const evidence={};for(const key of ['observationDate','build','kind','validation','scope','supersedes']){if(entry.evidence[key]!==undefined){if(!text(entry.evidence[key]))return status('invalid','Evidence declaration is invalid.');evidence[key]=entry.evidence[key];}}document.evidence=evidence;}
  documents.push(document);
 }
 return status('ready','Author-declared collection metadata.',{collection:{schemaVersion:1,collectionId:data.collectionId,documents}});
}
export function portableReference(value){if(!value||value.schemaVersion!==1||!id(value.collectionId)||!id(value.documentId)||value.targetId!==undefined&&!id(value.targetId)||value.sourceHash!==undefined&&!hash(value.sourceHash)||value.revision!==undefined&&(typeof value.revision!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.revision)))throw new Error('Invalid portable reference.');return{schemaVersion:1,collectionId:value.collectionId,documentId:value.documentId,...(value.targetId?{targetId:value.targetId}:{}),...(value.sourceHash?{sourceHash:value.sourceHash}:{}),...(value.revision?{revision:value.revision}:{})};}
/** Explicit metadata ranges use raw UTF-16 positions. Convert only after matching
 * its whole-document hash; reject split Unicode/newline boundaries. */
export function sourceTargetSelection(raw,target){
 const boundary=offset=>Number.isSafeInteger(offset)&&offset>=0&&offset<=raw.length&&!(raw[offset-1]==='\r'&&raw[offset]==='\n')&&!(/[\uD800-\uDBFF]/u.test(raw[offset-1]??'')&&/[\uDC00-\uDFFF]/u.test(raw[offset]??''));
 if(typeof raw!=='string'||!target||!boundary(target.from)||!boundary(target.to)||target.to<=target.from)return null;
 const normalized=offset=>raw.slice(0,offset).replace(/^\ufeff/u,'').replace(/\r\n|\r/gu,'\n').length;
 return{from:normalized(target.from),to:normalized(target.to)};
}
/** Host supplies admitted collections and physically checked saved/immutable reads. */
export async function resolvePortableReference({reference,candidates,readDocument,readRevision,redirects=[]}){
 let ref;try{ref=portableReference(reference);}catch{return status('invalid','This portable reference is invalid or unsupported.');}
 const matches=candidates.filter(item=>item.metadata?.status==='ready'&&item.metadata.collection.collectionId===ref.collectionId);
 if(matches.length!==1)return status(matches.length?'ambiguous':'missing',matches.length?'More than one installed collection has this ID. Choose a repository explicitly.':'This collection is not installed.',{candidates:matches.map(item=>({repo:item.repo,repoId:item.repoId}))});
 const candidate=matches[0],entries=candidate.metadata.collection.documents.filter(item=>item.id===ref.documentId);
 if(entries.length!==1)return status(entries.length?'ambiguous':'missing','The declared document ID is missing or ambiguous.');
 const entry=entries[0],redirect=redirects.filter(item=>item.repoId===candidate.repoId&&item.from===entry.path&&item.documentId===entry.id);
 if(redirect.length>1)return status('ambiguous','More than one managed rename points from this document.');
 const relativePath=ref.revision?entry.path:redirect[0]?.to??entry.path;
 let saved;try{saved=ref.revision?(readRevision?await readRevision(candidate,relativePath,ref.revision):null):await readDocument(candidate,relativePath);}catch{return status(ref.revision?'version-unavailable':'missing',ref.revision?'The requested immutable revision is unavailable.':'The declared path is unavailable. Restore it or update the collection metadata after an external rename.');}
 if(!saved||!hash(saved.sourceHash)||typeof saved.text!=='string')return status(ref.revision?'version-unavailable':'missing',ref.revision?'The requested immutable revision is unavailable.':'The document is unavailable.');
 if(ref.sourceHash&&saved.sourceHash!==ref.sourceHash)return status('changed','The requested content hash does not match these bytes. No substitute was opened.');
 const target=ref.targetId?entry.targets.filter(item=>item.id===ref.targetId):[];
 if(ref.targetId&&target.length!==1)return status(target.length?'ambiguous':'missing','The exact target ID is unavailable.');
 const selection=target.length?sourceTargetSelection(saved.text,target[0]):null;
 if(target.length&&(target[0].sourceHash!==saved.sourceHash||!selection))return status('changed','The declared target belongs to different source bytes. Review and update its declaration.');
 return status('resolved','Author-declared identity resolved; this does not establish the truth of its claims.',{repo:candidate.repo,repoId:candidate.repoId,path:relativePath,revision:ref.revision??'',sourceHash:saved.sourceHash,documentId:entry.id,collectionId:ref.collectionId,evidence:entry.evidence,target:target[0]?{...target[0],rawFrom:target[0].from,rawTo:target[0].to,...selection}:null,redirected:Boolean(!ref.revision&&redirect.length)});
}
/** Context is labelled as a declaration, never upgraded to a verification badge. */
export function evidenceContext(metadata,path){if(metadata?.status!=='ready')return{status:metadata?.status??'missing',message:metadata?.message??'',evidence:null};const entry=metadata.collection.documents.find(item=>item.path===path);return{status:entry?'declared':'missing',message:entry?'Author-declared context; not independently verified.':'',collectionId:metadata.collection.collectionId,documentId:entry?.id??null,evidence:entry?.evidence??null};}

/** Recheck the local resolution receipt after asynchronous repository selection.
 * Portable IDs alone do not authorize switching to a different local copy. */
export function assertResolvedRepository(reference,repoId){
 if(reference?.status!=='resolved'||typeof reference.repoId!=='string'||!reference.repoId||reference.repoId!==repoId)throw new Error('This repository changed while resolving the reference. Open it again.');
}
