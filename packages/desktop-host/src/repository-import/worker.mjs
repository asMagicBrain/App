import {runWithStorageIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parentPort,workerData} from 'node:worker_threads';
import {extractZip,ZIP_IMPORT_LIMITS} from '../zip-import/index.mjs';
import {createImportedGitSnapshot} from '../local-git/import-snapshot.mjs';

try{
 await runWithStorageIdentity(workerData.storageIdentity??null,async()=>{
 const fd=fs.openSync(workerData.archivePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>ZIP_IMPORT_LIMITS.archiveBytes)throw Object.assign(new Error('ZIP_LIMIT_EXCEEDED'),{code:'ZIP_LIMIT_EXCEEDED'});bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
 const archiveSha256=createHash('sha256').update(bytes).digest('hex');
 const result=extractZip(bytes,{destination:workerData.destination,stripRoot:true});
 const files=result.entries.filter(e=>!e.skipped&&e.kind==='file').map(e=>({path:e.path,mode:e.mode}));
 if(workerData.expectedArchiveSha256!==undefined&&workerData.expectedArchiveSha256!==archiveSha256)throw Object.assign(new Error('REQUEST_CONFLICT'),{code:'REQUEST_CONFLICT'});
 const git=await createImportedGitSnapshot({sourceRoot:workerData.destination,files,initializeHistory:workerData.initializeHistory??true});
 parentPort.postMessage({ok:true,value:{head:git.head,archiveSha256,files:result.summary.fileCount,bytes:result.summary.expandedBytes,excludedEntries:result.summary.skippedEntries}});
 });
}catch(error){parentPort.postMessage({ok:false,code:typeof error.code==='string'?error.code:'IMPORT_FAILED'});}
