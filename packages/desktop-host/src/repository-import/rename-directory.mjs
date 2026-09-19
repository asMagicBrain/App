import {storageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkDirectory} from '../physical-roots.mjs';

const worker=fileURLToPath(new URL('./rename-worker.mjs',import.meta.url));
/** Host-only, fixed worker with a pinned cwd; no absolute source mutation. */
export function renameDirectoryStep(parent,request){
 checkDirectory(parent);
 const result=spawnSync(process.execPath,[worker],{cwd:parent.path,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},input:JSON.stringify(storageWorkerEnvelope({...request,parentIdentity:parent.identity})),maxBuffer:16384});
 if(result.error)throw result.error;
 let response;try{response=JSON.parse(result.stdout);}catch{throw Object.assign(new Error('RENAME_FAILED'),{code:'RENAME_FAILED'});}
 if(result.status!==0||response.ok!==true)throw Object.assign(new Error(response.code??'RENAME_FAILED'),{code:response.code??'RENAME_FAILED'});
 checkDirectory(parent);return response.identity;
}
