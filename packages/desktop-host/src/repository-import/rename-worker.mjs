import {persistentIdentity, runStorageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import {isPortableRelativePath,portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const identity=persistentIdentity;
const managedName=value=>typeof value==='string'&&/^\.asmb-(?:repository-trash|docs-stage|docs-preserved)-[a-f0-9-]{36}$/.test(value);
const name=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)&&isPortableRelativePath(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const directory=value=>{const stat=fs.lstatSync(value);if(!stat.isDirectory()||stat.isSymbolicLink())fail('REPOSITORY_CHANGED');return identity(stat);};
try{
 const input=fs.readFileSync(0,'utf8');if(input.length>8192)fail('INVALID_REQUEST');await runStorageWorkerEnvelope(JSON.parse(input),request=>{
 if(JSON.stringify(request).length>2048)fail('INVALID_REQUEST');
 const fields=request.operation==='reserve'?['operation','name','parentIdentity']:['operation','repository','name','identity','reservationIdentity','parentIdentity'];
 if(!exact(request,fields)||!['reserve','rename'].includes(request.operation)||!(name(request.name)||managedName(request.name)))fail('INVALID_REQUEST');
 const parent=fs.openSync('.',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{
  const check=()=>{if(identity(fs.fstatSync(parent))!==request.parentIdentity||directory('.')!==request.parentIdentity)fail('REPOSITORY_CHANGED');};
  check();const names=fs.readdirSync('.');if(names.length>=10000)fail('LIMIT_EXCEEDED');
  if(request.operation==='reserve'){
   if(names.some(value=>portablePathKey(value)===portablePathKey(request.name)))fail('NAME_EXISTS');
   fs.mkdirSync(request.name,{mode:0o700});fs.fsyncSync(parent);check();
  }else{
   if(!(name(request.repository)||managedName(request.repository))||portablePathKey(request.repository)===portablePathKey(request.name))fail('INVALID_REQUEST');
   for(const value of [request.repository,request.name])if(names.filter(entry=>portablePathKey(entry)===portablePathKey(value)).length!==1||!names.includes(value))fail('NAME_EXISTS');
   if(directory(request.repository)!==request.identity||directory(request.name)!==request.reservationIdentity||fs.readdirSync(request.name).length)fail('REPOSITORY_CHANGED');
   // Replace only this transaction's empty destination reservation. Both names
   // are direct children of the held cwd, independent of ancestor path changes.
   fs.renameSync(request.repository,request.name);fs.fsyncSync(parent);check();
   if(directory(request.name)!==request.identity)fail('REPOSITORY_CHANGED');
  }
  process.stdout.write(JSON.stringify({ok:true,identity:directory(request.name)}));
 }finally{fs.closeSync(parent);}
 });
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code??'RENAME_FAILED'}));process.exitCode=1;}
