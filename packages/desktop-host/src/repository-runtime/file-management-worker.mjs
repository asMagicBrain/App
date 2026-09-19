import {persistentIdentity, runStorageWorkerEnvelope} from '../../../source-foundation/src/adapters/storage-identity.mjs';
// Internal fixed-command worker. cwd pins one admitted parent directory object;
// every source mutation uses a direct basename, never a traversable absolute path.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const stamp=stat=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':');
const identity=persistentIdentity;
const flags=fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const leaf=name=>typeof name==='string'&&name.length>0&&!['.','..'].includes(name)&&!/[\/\\\0]/.test(name);
function names(filename){const handle=fs.opendirSync(filename),result=[];try{for(let entry=handle.readSync();entry;entry=handle.readSync()){if(result.length>=10000)fail('LIMIT_EXCEEDED');result.push(entry.name);}return result;}finally{handle.closeSync();}}
function sync(){const fd=fs.openSync('.',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|flags);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function regular(name){const stat=fs.lstatSync(name,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())fail('UNSAFE_FILE');return stat;}
function hashFile(name){
  const before=regular(name),fd=fs.openSync(name,fs.constants.O_RDONLY|flags),hasher=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0;
  try{if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before))fail('CONFLICT');for(;;){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)-size+1),null);if(!count)break;size+=count;if(size>Number(before.size))fail('CONFLICT');hasher.update(buffer.subarray(0,count));}if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(fs.lstatSync(name,{bigint:true}))!==stamp(before))fail('CONFLICT');return {hash:hasher.digest('hex'),size,identity:identity(before)};}finally{fs.closeSync(fd);}
}
function verifyTree(root,entries){
  const expected=new Map(entries.map(entry=>[entry.path,entry]));let count=0;
  const walk=(name,relative)=>{
    const wanted=expected.get(relative),before=fs.lstatSync(name,{bigint:true});if(!wanted||before.isSymbolicLink()||Number(before.mode&0o777n)!==wanted.mode)fail('CONFLICT');count++;
    if(wanted.type==='directory'){
      if(!before.isDirectory())fail('CONFLICT');
      for(const child of names(name))walk(`${name}/${child}`,relative?`${relative}/${child}`:child);
      if(stamp(fs.lstatSync(name,{bigint:true}))!==stamp(before))fail('CONFLICT');
    }else{if(!before.isFile()||before.nlink!==1n)fail('CONFLICT');const observed=hashFile(name);if(observed.hash!==wanted.hash||observed.size!==wanted.size)fail('CONFLICT');}
  };
  walk(root,'');if(count!==entries.length)fail('CONFLICT');
}
try{
  await runStorageWorkerEnvelope(JSON.parse(fs.readFileSync(0,'utf8')),request=>{
  if(!request||typeof request!=='object'||identity(fs.statSync('.'))!==request.parentIdentity)fail('DENIED');
  for(const name of ['name','from','to'])if(Object.hasOwn(request,name)&&!leaf(request[name]))fail('INVALID_PATH');
  let value={};
  if(request.command==='mkdir'){
    fs.mkdirSync(request.name,{mode:request.mode??0o700});value={identity:identity(fs.lstatSync(request.name))};sync();
  }else if(request.command==='copy'){
    const before=fs.fstatSync(3,{bigint:true});if(!before.isFile()||before.nlink!==1n||stamp(before)!==request.sourceStamp)fail('CONFLICT');
    const fd=fs.openSync(request.name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|flags,0o600),buffer=Buffer.alloc(64*1024),hasher=createHash('sha256');let size=0;
    try{for(;;){const count=fs.readSync(3,buffer,0,Math.min(buffer.length,request.size-size+1),null);if(!count)break;size+=count;if(size>request.size)fail('CONFLICT');hasher.update(buffer.subarray(0,count));let offset=0;while(offset<count)offset+=fs.writeSync(fd,buffer,offset,count-offset);}if(size!==request.size||hasher.digest('hex')!==request.hash||stamp(fs.fstatSync(3,{bigint:true}))!==stamp(before))fail('CONFLICT');fs.fchmodSync(fd,request.mode);fs.fsyncSync(fd);value={identity:identity(fs.fstatSync(fd))};}finally{fs.closeSync(fd);}sync();
  }else if(request.command==='link-publish'){
    verifyTree(request.from,request.entries);
    const from=regular(request.from);if(from.nlink!==1n)fail('UNSAFE_FILE');
    fs.linkSync(request.from,request.to);sync();
    const current=regular(request.from),published=regular(request.to);if(identity(current)!==identity(from)||identity(published)!==identity(from)||current.nlink!==2n)fail('CONFLICT');
    fs.unlinkSync(request.from);sync();
  }else if(request.command==='rename-directory'){
    verifyTree(request.from,request.entries);
    const from=fs.lstatSync(request.from),to=fs.lstatSync(request.to);
    if(!from.isDirectory()||from.isSymbolicLink()||!to.isDirectory()||to.isSymbolicLink()||identity(to)!==request.reservation||names(request.to).length)fail('CONFLICT');
    fs.renameSync(request.from,request.to);sync();
  }else if(request.command==='chmod-directory'){
    const fd=fs.openSync(request.name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|flags);try{if(!fs.fstatSync(fd).isDirectory())fail('UNSAFE_FILE');fs.fchmodSync(fd,request.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync();
  }else if(request.command==='remove-file'){
    const file=hashFile(request.name);if(file.hash!==request.hash||file.size!==request.size)fail('CONFLICT');fs.unlinkSync(request.name);sync();
  }else if(request.command==='remove-directory'){
    const stat=fs.lstatSync(request.name);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_FILE');fs.rmdirSync(request.name);sync();
  }else if(request.command==='remove-linked'){
    const from=regular(request.from),to=regular(request.to);if(from.nlink!==2n||identity(from)!==identity(to))fail('CONFLICT');fs.unlinkSync(request.from);sync();
  }else fail('INVALID_COMMAND');
  process.stdout.write(JSON.stringify({ok:true,value}));
  });
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.code??'OPERATION_FAILED'}));process.exitCode=1;}
