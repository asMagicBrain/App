import {runWithStorageIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import {parentPort,workerData} from 'node:worker_threads';
import {createWorkspaceService} from '../workspace-service.mjs';

const cancelled=new Int32Array(workerData.cancelFlag);
const checkCancelled=()=>{if(Atomics.load(cancelled,0))throw Object.assign(new Error('File import was cancelled. Original files remain untouched.'),{code:'IMPORT_CANCELLED'});};
let workspace;
try{
 await runWithStorageIdentity(workerData.storageIdentity??null,async()=>{
 try{
 checkCancelled();
 workspace=createWorkspaceService({...workerData.workspace,runtimeHooks:{checkCancelled,at:point=>{
  if(workerData.reportPhases)parentPort.postMessage({phase:point});
  // Test-only host-selected interruption point, never exposed by native IPC.
  if(workerData.exitAt===point)process.exit(73);
  if(workerData.interruptAt===point)throw Object.assign(new Error('Simulated interrupted external copy'),{code:'TEST_INTERRUPTION'});
 }}});
 const allowed=new Set(['inspectEntry','manage','restore','reconcile']);
 if(workerData.operation!=='importExternal'&&!allowed.has(workerData.operation))throw Object.assign(new Error('Invalid worker operation'),{code:'INVALID_REQUEST'});
 const result=workerData.operation==='importExternal'?workspace.importExternal(workerData.repo,{sources:workerData.sources,destination:workerData.destination}):await workspace.execute(workerData.repo,workerData.operation,workerData.args);
 parentPort.postMessage({ok:true,value:result});
 }finally{workspace?.close();}
 });
}catch(error){parentPort.postMessage({ok:false,code:error.code??'IMPORT_FAILED',message:error.message});}
