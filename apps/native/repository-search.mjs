import {storageWorkerEnvelope} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {checkDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';
import {isInspectableRelativePath} from '../../packages/source-foundation/src/domain/path-policy.mjs';
const worker=fileURLToPath(new URL('./repository-search-worker.mjs',import.meta.url));
const here=fileURLToPath(new URL('.',import.meta.url));
export const SEARCH_LIMITS=Object.freeze({files:10000,matches:200,fileBytes:8*1024*1024,totalBytes:128*1024*1024,outputBytes:2*1024*1024,timeMs:15000,depth:32});
const error=code=>Object.assign(new Error(({SEARCH_CANCELLED:'Search cancelled.',SEARCH_BUSY:'Another search is still running.',SEARCH_INVALID_REQUEST:'Invalid search request.',SEARCH_FAILED:'Search could not finish. Please retry.'})[code]??code),{code});
const fields=(value,required,optional=[])=>value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>[...required,...optional].includes(k));
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const safePath=value=>typeof value==='string'&&(value===''||isInspectableRelativePath(value)&&value.split('/').length<=32&&!value.split('/').some(p=>p.toLowerCase()==='.asmagicbrain'||p.toLowerCase().startsWith('.asmb-')));
export function validateSearch(input,kind){
 if(!fields(input,kind==='files'?['requestId','repo']:['requestId','query','caseSensitive','repo'],kind==='files'?['ref']:['path'])||!requestId(input.requestId))throw error('SEARCH_INVALID_REQUEST');
 if(typeof input.repo!=='string'&&!(kind==='text'&&input.repo===null))throw error('SEARCH_INVALID_REQUEST');
 if(kind==='files'&&(input.ref!==undefined&&(typeof input.ref!=='string'||input.ref!==''&&!/^refs\/(heads|tags)\/[^\x00-\x20\x7f]{1,900}$/.test(input.ref))))throw error('SEARCH_INVALID_REQUEST');
 if(kind==='text'&&(typeof input.query!=='string'||!input.query.isWellFormed()||!input.query.length||input.query.length>512||/[\0\r\n]/.test(input.query)||typeof input.caseSensitive!=='boolean'||input.path!==undefined&&(!safePath(input.path)||input.repo===null)))throw error('SEARCH_INVALID_REQUEST');
 return structuredClone(input);
}
/** Detached bounded jobs. Only trusted host admission supplies physical roots. */
export function createRepositorySearch({admit,ripgrepPath=path.join(here,'dist-host/rg'),limits=SEARCH_LIMITS}={}){
 const jobs=new Map();let paused=false;
 async function run(kind,input){
  const value=validateSearch(input,kind);if(paused)throw error('SERVICE_CLOSED');if(jobs.has(value.requestId)||jobs.size>=2)throw error('SEARCH_BUSY');
  const controller=new AbortController();const job={controller,promise:null};jobs.set(value.requestId,job);
  job.promise=(async()=>{
   const roots=await admit(value.repo,{kind,ref:value.ref});if(controller.signal.aborted)throw error('SEARCH_CANCELLED');if(!roots.length)throw error('SEARCH_UNAVAILABLE');for(const root of roots)checkDirectory(root.pin);
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[worker],{cwd:roots[0].pin.path,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:process.env.TMPDIR,TMP:process.env.TMPDIR,TEMP:process.env.TMPDIR,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','pipe']});
    let chunks=[],size=0,failure,timer,hard;
    const stop=code=>{failure??=error(code);child.kill('SIGTERM');hard??=setTimeout(()=>child.kill('SIGKILL'),1000);hard.unref();};
    const abort=()=>stop('SEARCH_CANCELLED');controller.signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop('SEARCH_TIMEOUT'),limits.timeMs+2000);timer.unref();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limits.outputBytes)stop('SEARCH_LIMIT_EXCEEDED');else chunks.push(chunk);});child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('error',()=>{failure??=error('SEARCH_FAILED');});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(hard);controller.signal.removeEventListener('abort',abort);if(failure)return reject(failure);try{const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(code!==0||reply.ok!==true)throw error(reply.code??'SEARCH_FAILED');resolve(reply.value);}catch(caught){reject(caught);}});
    child.stdin.end(JSON.stringify(storageWorkerEnvelope({kind,input:value,roots:roots.map(root=>({repo:root.repo,path:root.pin.path,identity:root.pin.identity})),ripgrepPath,limits})));
   });
   if(controller.signal.aborted)throw error('SEARCH_CANCELLED');if(!roots.length)throw error('SEARCH_UNAVAILABLE');for(const root of roots)checkDirectory(root.pin);return result;
  })();
  try{return await job.promise;}finally{jobs.delete(value.requestId);}
 }
 async function cancel(input){if(!fields(input,['requestId'])||!requestId(input.requestId))throw error('SEARCH_INVALID_REQUEST');const job=jobs.get(input.requestId);job?.controller.abort();if(job)await job.promise.catch(()=>{});}
 async function prepareClose(){paused=true;for(const job of jobs.values())job.controller.abort();await Promise.allSettled([...jobs.values()].map(job=>job.promise));}
 return Object.freeze({listRepositoryFiles:input=>run('files',input),searchRepositoryText:input=>run('text',input),cancelRepositorySearch:cancel,prepareClose,resume(){paused=false;},close:prepareClose,drain:()=>Promise.allSettled([...jobs.values()].map(job=>job.promise))});
}
