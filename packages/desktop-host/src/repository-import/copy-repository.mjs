import {storageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pinDirectory,checkDirectory} from '../physical-roots.mjs';
const worker=fileURLToPath(new URL('./copy-repository-worker.mjs',import.meta.url));
/** Host-only local duplication; both roots are fixed admitted siblings. */
export async function copyLocalRepository({sourceRoot,destination}){
 const source=pinDirectory(sourceRoot),target=pinDirectory(destination),parent=pinDirectory(path.dirname(source.path));
 if(path.dirname(target.path)!==parent.path)throw Object.assign(new Error('INVALID_ROOT'),{code:'INVALID_ROOT'});
 const input={source:path.basename(source.path),destination:path.basename(target.path),sourceIdentity:source.identity,targetIdentity:target.identity,parentIdentity:parent.identity};
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[worker],{cwd:parent.path,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:process.env.TMPDIR,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','pipe']});
  let output='',overflow=false;const timer=setTimeout(()=>{overflow=true;child.kill('SIGTERM');},120000);
  child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.length>16384){overflow=true;child.kill('SIGTERM');}});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(storageWorkerEnvelope(input)));
  child.once('error',reject);child.once('close',code=>{clearTimeout(timer);try{const reply=JSON.parse(output);if(overflow||code!==0||!reply.ok)throw Object.assign(new Error(reply.code??'DUPLICATE_FAILED'),{code:overflow?'DUPLICATE_LIMIT':reply.code??'DUPLICATE_FAILED'});resolve(reply.value);}catch(error){reject(error.code?error:Object.assign(new Error('DUPLICATE_FAILED'),{code:'DUPLICATE_FAILED'}));}});
 });
 checkDirectory(parent);checkDirectory(source);checkDirectory(target);return result;
}
