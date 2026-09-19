import {persistentIdentity, storageWorkerEnvelope, runStorageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
// The reader holds each source directory as cwd; destination writes run in a
// separate fixed worker whose cwd is checked against the admitted inode.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const writer=fileURLToPath(new URL('./copy-repository-write-worker.mjs',import.meta.url));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=persistentIdentity;
const stamp=s=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const flags=fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const directory=name=>{const s=fs.lstatSync(name);if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_REPOSITORY');return id(s);};
const leaf=n=>typeof n==='string'&&n.length>0&&!['.','..'].includes(n)&&!/[\/\\\0]/.test(n)&&n.isWellFormed();
let activeChild,aborted=false;
process.on('SIGTERM',()=>{aborted=true;activeChild?.kill('SIGTERM');});
const run=async(destination,identity,request,fds=[])=>{
 if(aborted)fail('DUPLICATE_CANCELLED');
 return await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[writer],{cwd:destination,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},stdio:['pipe','pipe','pipe',...fds]});activeChild=child;let output='',failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill('SIGTERM');},30000);
  child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>16384){failed=true;child.kill('SIGTERM');}});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(storageWorkerEnvelope({...request,identity})));child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);activeChild=null;try{const reply=JSON.parse(output);if(aborted||failed||code!==0||!reply.ok)throw Object.assign(new Error(reply.code??'DUPLICATE_FAILED'),{code:aborted?'DUPLICATE_CANCELLED':reply.code??'DUPLICATE_FAILED'});resolve(reply.value);}catch(error){reject(error.code?error:Object.assign(new Error('DUPLICATE_FAILED'),{code:'DUPLICATE_FAILED'}));}});
 });
};
function hash(fd,size){const h=createHash('sha256'),b=Buffer.alloc(128*1024);let offset=0;while(offset<size){const n=fs.readSync(fd,b,0,Math.min(b.length,size-offset),offset);if(!n)fail('SOURCE_CHANGED');h.update(b.subarray(0,n));offset+=n;}return h.digest('hex');}
try{
 await runStorageWorkerEnvelope(JSON.parse(fs.readFileSync(0,'utf8')),async request=>{if(!leaf(request.source)||!/^\.asmb-import-[a-f0-9-]{36}$/.test(request.destination)||directory('.')!==request.parentIdentity||directory(request.source)!==request.sourceIdentity||directory(request.destination)!==request.targetIdentity)fail('INVALID_ROOT');
 const destination=path.join(process.cwd(),request.destination);if(fs.readdirSync(destination).length)fail('NAME_EXISTS');
 const manifest=new Map();let count=0,bytes=0,files=0;const started=Date.now();
 const bound=()=>{if(++count>100000||bytes>1024*1024*1024||Date.now()-started>110000||aborted)fail('DUPLICATE_LIMIT');};
 async function walk(target,targetIdentity,relative='',verify=false){
  const before=fs.lstatSync('.',{bigint:true}),entries=fs.readdirSync('.').sort();bound();if(relative.split('/').length>32)fail('DUPLICATE_LIMIT');
  const record={stamp:stamp(before),names:entries,mode:Number(before.mode&0o777n)};if(verify){if(JSON.stringify(manifest.get(relative))!==JSON.stringify(record))fail('SOURCE_CHANGED');}else manifest.set(relative,record);
  let batch=[];
  const flush=async()=>{if(!batch.length)return;try{await run(target,targetIdentity,{operation:'copy',files:batch.map((r,i)=>({name:r.name,size:r.size,mode:r.mode,stamp:r.stamp,hash:r.hash,fd:i+3}))},batch.map(r=>r.fd));for(const r of batch)if(stamp(fs.fstatSync(r.fd,{bigint:true}))!==r.stamp||stamp(fs.lstatSync(r.name,{bigint:true}))!==r.stamp)fail('SOURCE_CHANGED');}finally{for(const r of batch)fs.closeSync(r.fd);batch=[];}};
  try{for(const name of entries){
   if(!leaf(name))fail('UNSAFE_REPOSITORY');const rel=relative?relative+'/'+name:name;const stat=fs.lstatSync(name,{bigint:true});bound();
   if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1n)fail('UNSAFE_REPOSITORY');
   if(name.toLowerCase()==='.asmagicbrain'||name.toLowerCase().startsWith('.asmb-'))fail('PRIVATE_SOURCE_UNSUPPORTED');
   if(name.toLowerCase()==='.git'&&relative)fail('NESTED_REPOSITORY');
   if(/^(?:\.git\/(?:commondir|gitdir|shallow|objects\/info\/(?:alternates|http-alternates)))(?:$|\/)/.test(rel)||/^\.git\/hooks\/.+/.test(rel)&&!name.endsWith('.sample'))fail('UNSUPPORTED_GIT_DIRECTORY');
   if(stat.isDirectory()){
    await flush();const next=verify?null:await run(target,targetIdentity,{operation:'mkdir',name});process.chdir(name);if(id(fs.lstatSync('.'))!==id(stat))fail('SOURCE_CHANGED');
    await walk(path.join(target,name),next,rel,verify);process.chdir('..');if(id(fs.lstatSync('.'))!==id(before))fail('SOURCE_CHANGED');
    if(!verify)await run(target,targetIdentity,{operation:'mode',name,childIdentity:next,mode:Number(stat.mode&0o777n)});
   }else{
    bytes+=Number(stat.size);bound();
    const fd=fs.openSync(name,fs.constants.O_RDONLY|flags);let owned=true;
    try{if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat))fail('SOURCE_CHANGED');const digest=hash(fd,Number(stat.size));if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat)||stamp(fs.lstatSync(name,{bigint:true}))!==stamp(stat))fail('SOURCE_CHANGED');const r={stamp:stamp(stat),hash:digest,mode:Number(stat.mode&0o777n),size:Number(stat.size)};if(verify){if(JSON.stringify(manifest.get(rel))!==JSON.stringify(r))fail('SOURCE_CHANGED');}else{manifest.set(rel,r);files++;batch.push({name,fd,size:Number(stat.size),mode:Number(stat.mode&0o777n),stamp:stamp(stat),hash:digest});owned=false;if(batch.length===32)await flush();}}finally{if(owned)fs.closeSync(fd);}
   }
  }await flush();if(stamp(fs.lstatSync('.',{bigint:true}))!==stamp(before))fail('SOURCE_CHANGED');}finally{for(const r of batch)fs.closeSync(r.fd);}
 }
 function verifyDestination(relative=''){
  const before=fs.lstatSync('.',{bigint:true}),expected=manifest.get(relative);bound();
  if(!expected?.names||Number(before.mode&0o777n)!==expected.mode||JSON.stringify(fs.readdirSync('.').sort())!==JSON.stringify(expected.names))fail('DESTINATION_CHANGED');
  for(const name of expected.names){const rel=relative?relative+'/'+name:name,wanted=manifest.get(rel),stat=fs.lstatSync(name,{bigint:true});bound();if(stat.isSymbolicLink()||Number(stat.mode&0o777n)!==wanted.mode)fail('DESTINATION_CHANGED');
   if(wanted.names){if(!stat.isDirectory())fail('DESTINATION_CHANGED');process.chdir(name);if(id(fs.lstatSync('.'))!==id(stat))fail('DESTINATION_CHANGED');verifyDestination(rel);process.chdir('..');if(id(fs.lstatSync('.'))!==id(before))fail('DESTINATION_CHANGED');}
   else{if(!stat.isFile()||stat.nlink!==1n||Number(stat.size)!==wanted.size)fail('DESTINATION_CHANGED');const fd=fs.openSync(name,fs.constants.O_RDONLY|flags);try{if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat)||hash(fd,wanted.size)!==wanted.hash||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat)||stamp(fs.lstatSync(name,{bigint:true}))!==stamp(stat))fail('DESTINATION_CHANGED');}finally{fs.closeSync(fd);}}
  }if(stamp(fs.lstatSync('.',{bigint:true}))!==stamp(before))fail('DESTINATION_CHANGED');
 }
 process.chdir(request.source);if(directory('.')!==request.sourceIdentity)fail('SOURCE_CHANGED');await walk(destination,request.targetIdentity);const totals={files,bytes};count=0;bytes=0;await walk(destination,request.targetIdentity,'',true);if(directory('.')!==request.sourceIdentity)fail('SOURCE_CHANGED');process.chdir('..');if(directory('.')!==request.parentIdentity)fail('SOURCE_CHANGED');process.chdir(request.destination);if(directory('.')!==request.targetIdentity)fail('DESTINATION_CHANGED');count=0;verifyDestination();process.stdout.write(JSON.stringify({ok:true,value:totals}));
 });
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code??'DUPLICATE_FAILED'}));process.exitCode=1;}
