import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateArtifactManifest} from './artifact-snapshot.mjs';
export const AUTOMATION_VALIDATION_LIMITS=Object.freeze({documents:256,textBytes:65536,issues:1000,referencesPerDocument:1000});
const TEXT=/\.(?:md|markdown|txt|json|ya?ml|toml|csv|html?|js|mjs|css|svg|py|c|cpp|h|ts|tsx)$/iu;
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID_REQUEST'});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const physicalPath=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&value.isWellFormed()&&!/^(?:\/|[a-z]:)/iu.test(value)&&!/[\\\u0000-\u001f\u007f]/u.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!['.git','.asmagicbrain'].includes(part.toLowerCase())&&!part.toLowerCase().startsWith('.asmb-'));
function support(relative){
 if(/\.(?:md|markdown)$/iu.test(relative))return{format:'markdown',staticPreview:'markdown-with-math-and-diagram-support',sourceAvailable:true,runtimeEligibility:'not-applicable'};
 if(/\.artifact\.json$/iu.test(relative))return{format:'artifact-manifest',staticPreview:'source',sourceAvailable:true,runtimeEligibility:'requires-validation'};
 if(/\.html$/iu.test(relative))return{format:'html',staticPreview:'source',sourceAvailable:true,runtimeEligibility:'eligible-for-explicit-review'};
 if(/\.(?:png|jpe?g|gif|webp)$/iu.test(relative))return{format:'image',staticPreview:'image',sourceAvailable:false,runtimeEligibility:'not-applicable'};
 if(/\.(?:mp4|webm)$/iu.test(relative))return{format:'video',staticPreview:'platform-dependent-media',sourceAvailable:false,runtimeEligibility:'not-applicable'};
 return{format:TEXT.test(relative)?'text':'binary',staticPreview:TEXT.test(relative)?'source':'unavailable',sourceAvailable:TEXT.test(relative),runtimeEligibility:'not-applicable'};
}
/** Validates only admitted inputs supplied by the host. No filesystem authority,
 * networking, execution, credential access or executable approval is conferred. */
export function validateAutomationFiles({files,inventoryPaths,analyzeReferences}){
 if(!Array.isArray(files)||typeof analyzeReferences!=='function'||inventoryPaths!==undefined&&!Array.isArray(inventoryPaths))fail('Validation requires admitted file inputs.');
 const limits=AUTOMATION_VALIDATION_LIMITS,issues=[],results=[],contents=new Map(),analyses=new Map(),seen=new Set();let truncated=files.length>limits.documents;
 const inventory=new Set();for(const relative of inventoryPaths??files.map(item=>item?.path)){if(!physicalPath(relative))fail('Validation inventory contains an invalid path.');if(inventory.size>=10000){truncated=true;break;}inventory.add(relative);}
 const add=(relative,code,detail={})=>{if(issues.length>=limits.issues){truncated=true;return;}issues.push({path:relative,code,...detail});};
 for(const file of files.slice(0,limits.documents)){
  if(!file||!physicalPath(file.path)||seen.has(file.path.toLowerCase())||file.text!==undefined&&(typeof file.text!=='string'||!file.text.isWellFormed())||file.size!==undefined&&(!Number.isSafeInteger(file.size)||file.size<0))fail('Validation file input is invalid or duplicated.');seen.add(file.path.toLowerCase());
  const item={path:file.path,present:true,importSupported:true,...support(file.path),executionPermitted:false,validation:'not-inspected'};if(item.format==='binary'&&typeof file.text==='string'){item.format='text';item.staticPreview='source';item.sourceAvailable=true;}results.push(item);
  if(item.sourceAvailable&&file.size>limits.textBytes){truncated=true;item.validation='limit-exceeded';if(item.runtimeEligibility!=='not-applicable')item.runtimeEligibility='not-inspected';add(file.path,'LIMIT_EXCEEDED',{limit:'textBytes',maximum:limits.textBytes});continue;}
  if(file.text===undefined){if(item.sourceAvailable)add(file.path,'TEXT_NOT_PROVIDED');item.runtimeEligibility=item.runtimeEligibility==='eligible-for-explicit-review'?'not-inspected':item.runtimeEligibility;continue;}
  if(file.text.length>limits.textBytes||Buffer.byteLength(file.text,'utf8')>limits.textBytes){truncated=true;item.validation='limit-exceeded';if(item.runtimeEligibility!=='not-applicable')item.runtimeEligibility='not-inspected';add(file.path,'LIMIT_EXCEEDED',{limit:'textBytes',maximum:limits.textBytes});continue;}
  contents.set(file.path,file.text);item.validation='inspected';
  if(item.format==='markdown'){const analysis=analyzeReferences({path:file.path,text:file.text,limit:limits.referencesPerDocument});if(!analysis||!Array.isArray(analysis.references)||typeof analysis.hasFragment!=='function')fail('The trusted reference analyzer returned invalid output.');analyses.set(file.path,analysis);truncated ||= analysis.truncated===true;}
 }
 for(const item of results){const text=contents.get(item.path);if(text===undefined)continue;
  const analysis=analyses.get(item.path);for(const reference of analysis?.references??[]){
   if(!reference.local){add(item.path,/^(?:https?:\/\/|mailto:)/iu.test(reference.value)?'EXTERNAL_REFERENCE':'UNRESOLVED_REFERENCE',{scheme:/^([a-z][a-z0-9+.-]*):/iu.exec(reference.value)?.[1]?.toLowerCase()??'unresolved',networkChecked:false});continue;}
   const target=reference.local;if(!physicalPath(target.path)){add(item.path,'UNRESOLVED_REFERENCE',{target:target.path.slice(0,512)});continue;}
   if(!inventory.has(target.path)){add(item.path,'MISSING_LOCAL_REFERENCE',{target:target.path,fragment:target.fragment});continue;}
   if(target.fragment){const destination=analyses.get(target.path);if(!destination)add(item.path,'TARGET_NOT_INSPECTED',{target:target.path,fragment:target.fragment});else if(!destination.hasFragment(target.fragment))add(item.path,'MISSING_LOCAL_TARGET',{target:target.path,fragment:target.fragment});}
  }
  if(item.format==='artifact-manifest'){
   let manifest;try{manifest=validateArtifactManifest(JSON.parse(text));}catch{item.runtimeEligibility='ineligible';add(item.path,'INVALID_ARTIFACT_MANIFEST');continue;}
   let complete=true;const prefix=path.posix.dirname(item.path)==='.'?'':path.posix.dirname(item.path)+'/';
   for(const asset of manifest.assets){const target=prefix+asset.path;if(!inventory.has(target)){complete=false;add(item.path,'MISSING_ARTIFACT_DEPENDENCY',{target});continue;}const data=contents.get(target);if(data===undefined){complete=false;add(item.path,'DEPENDENCY_NOT_INSPECTED',{target});continue;}if(Buffer.byteLength(data,'utf8')!==asset.bytes||hash(data)!==asset.sha256){complete=false;add(item.path,'ARTIFACT_DEPENDENCY_CHANGED',{target});}}
   item.runtimeEligibility=complete?'eligible-for-explicit-review':'manifest-valid-dependencies-unconfirmed';
  }
 }
 return{schemaVersion:1,validationVersion:'1.0',status:truncated?'truncated':'complete',truncated,limits,scope:'Saved provided files; Markdown links and declared artifact dependencies only.',executionPermitted:false,files:results,issues};
}
