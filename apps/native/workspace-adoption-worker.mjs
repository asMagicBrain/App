import {parentPort,workerData} from 'node:worker_threads';
import {performWorkspaceAdoption} from './workspace-adoption.mjs';
try{const result=await performWorkspaceAdoption(workerData,{at:phase=>parentPort.postMessage({phase})});parentPort.postMessage({complete:true,result});}
catch(error){parentPort.postMessage({complete:true,error:{code:error.code??'WORKSPACE_ADOPTION_FAILED',message:error.message}});}
