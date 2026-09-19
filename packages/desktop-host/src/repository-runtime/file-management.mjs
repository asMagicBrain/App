import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinDirectory, checkDirectory, checkSourceSpelling, contains } from '../physical-roots.mjs';
import { isPortableRelativePath, portablePathKey } from '../../../source-foundation/src/domain/path-policy.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const worker=fileURLToPath(new URL('./file-management-worker.mjs',import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const stamp = stat => ['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(key => String(stat[key])).join(':');
export const managementPathContains = (parent, child) => portablePathKey(child) === portablePathKey(parent) || portablePathKey(child).startsWith(portablePathKey(parent) + '/');
const overlap = (a,b) => managementPathContains(a,b) || managementPathContains(b,a);
export const externalMetadataName = name => ['.git','.asmagicbrain','.ds_store','__macosx'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('.asmb-');
export function inspectExternalSources(sources){
  if(!Array.isArray(sources)||!sources.length||sources.length>256)fail('INVALID_EXTERNAL_FILES');
  const found=new Set();return sources.map(filename=>{
    if(typeof filename!=='string'||!filename.isWellFormed()||filename.length>4096||!path.isAbsolute(filename)||path.normalize(filename)!==filename||filename===path.parse(filename).root)fail('INVALID_EXTERNAL_FILES');
    const parent=pinDirectory(path.dirname(filename)),stat=fs.lstatSync(filename);checkDirectory(parent);
    if(stat.isSymbolicLink())fail('SYMLINK_UNSUPPORTED');if(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))fail('UNSUPPORTED_FILE');
    if(found.has(filename))fail('DUPLICATE_SOURCE');found.add(filename);
    if(!externalMetadataName(path.basename(filename)))managementPath(path.basename(filename));
    return {path:filename,identity:`${stat.dev}:${stat.ino}`,kind:stat.isDirectory()?'directory':'file'};
  });
}
export function managementPath(relative) {
  if (!isPortableRelativePath(relative) || !relative.isWellFormed() || relative.split('/').length > 32
    || relative.split('/').some(part => Buffer.byteLength(part) > 255 || part.toLowerCase() === '.asmagicbrain' || part.toLowerCase().startsWith('.asmb-'))) fail('INVALID_PATH');
  return relative;
}
function exists(filename) { try { return fs.lstatSync(filename); } catch(error) { if(error.code === 'ENOENT')return null; throw error; } }
function names(filename){const handle=fs.opendirSync(filename),result=[];try{for(let entry=handle.readSync();entry;entry=handle.readSync()){if(result.length>=10000)fail('LIMIT_EXCEEDED');result.push(entry.name);}return result;}finally{handle.closeSync();}}
function mutate(parent,command,fields={},input,at){
  const pinned=pinDirectory(parent);at?.('management-before-worker',{parent,command,...fields});
  const result=spawnSync(process.execPath,[worker],{cwd:pinned.path,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},input:JSON.stringify({command,parentIdentity:pinned.identity,...fields}),stdio:['pipe','pipe','pipe',input??'ignore'],maxBuffer:64*1024});
  if(result.error)throw result.error;let response;try{response=JSON.parse(result.stdout);}catch{fail('WORKER_FAILED');}
  if(!response.ok)fail(response.error);checkDirectory(pinned);return response.value;
}
function syncDirectory(filename) {
  const pin=pinDirectory(filename),fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try { if(`${fs.fstatSync(fd).dev}:${fs.fstatSync(fd).ino}`!==pin.identity)fail('CONFLICT');fs.fsyncSync(fd);checkDirectory(pin); } finally { fs.closeSync(fd); }
}
function fileHash(filename, linkedWith, checkCancelled=()=>{}) {
  const parent=pinDirectory(path.dirname(filename));
  const before=fs.lstatSync(filename,{bigint:true});
  if(!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(Number(before.size)))fail('UNSAFE_FILE');
  if(before.nlink!==1n){const other=linkedWith&&exists(linkedWith);if(before.nlink!==2n||!other||BigInt(other.dev)!==before.dev||BigInt(other.ino)!==before.ino)fail('UNSAFE_FILE');}
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),hasher=createHash('sha256'),buffer=Buffer.alloc(64*1024);
  try {
    checkDirectory(parent);
    if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before))fail('CONFLICT');
    let bytes=0;for(;;){checkCancelled();const read=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)-bytes+1),null);if(!read)break;bytes+=read;if(bytes>Number(before.size))fail('CONFLICT');hasher.update(buffer.subarray(0,read));}
    if(bytes!==Number(before.size)||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(fs.lstatSync(filename,{bigint:true}))!==stamp(before))fail('CONFLICT');
    checkDirectory(parent);return {hash:hasher.digest('hex'),size:bytes,mode:Number(before.mode&0o777n)};
  } finally {fs.closeSync(fd);}
}
function prefixHash(filename,length){
  const parent=pinDirectory(path.dirname(filename)),before=fs.lstatSync(filename,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||BigInt(length)>before.size)fail('RECOVERY_REQUIRED');
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),hasher=createHash('sha256'),buffer=Buffer.alloc(64*1024);
  try{checkDirectory(parent);if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before))fail('CONFLICT');let remaining=length;
    while(remaining){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,remaining),null);if(!count)fail('CONFLICT');hasher.update(buffer.subarray(0,count));remaining-=count;}
    if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(fs.lstatSync(filename,{bigint:true}))!==stamp(before))fail('CONFLICT');checkDirectory(parent);return hasher.digest('hex');
  }finally{fs.closeSync(fd);}
}
function scan(filename,{linkedWith,privateModes=false,skipMetadata=false,onSkipped=()=>{},checkCancelled=()=>{}}={}) {
  if(!exists(filename))return null;
  const entries=[],seen=new Set();let byteLength=0,fileCount=0;
  function walk(current,relative,depth){
    checkCancelled();
    if(depth>32||entries.length>=10000)fail('LIMIT_EXCEEDED');
    if(relative)managementPath(relative);
    const key=portablePathKey(relative);if(seen.has(key))fail('PATH_ALIAS');seen.add(key);
    const before=fs.lstatSync(current,{bigint:true});if(before.isSymbolicLink())fail(skipMetadata?'SYMLINK_UNSUPPORTED':'UNSAFE_FILE');
    if(before.isDirectory()){
      const pin=pinDirectory(current);entries.push({path:relative,type:'directory',mode:Number(before.mode&0o777n)});
      const directory=fs.opendirSync(current),names=[];
      try{for(let entry=directory.readSync();entry;entry=directory.readSync()){if(names.length>=10000)fail('LIMIT_EXCEEDED');names.push(entry.name);}}finally{directory.closeSync();}
      for(const name of names.sort()){if(skipMetadata&&externalMetadataName(name)){onSkipped();continue;}walk(path.join(current,name),relative?`${relative}/${name}`:name,depth+1);}
      checkDirectory(pin);if(stamp(fs.lstatSync(current,{bigint:true}))!==stamp(before))fail('CONFLICT');
    }else{
      const item=fileHash(current,relative===''?linkedWith:undefined,checkCancelled);entries.push({path:relative,type:'file',...item});byteLength+=item.size;fileCount++;
      if(!Number.isSafeInteger(byteLength))fail('LIMIT_EXCEEDED');
    }
  }
  walk(filename,'',0);
  return {type:entries[0].type,token:entries[0].type==='file'?entries[0].hash:hash(JSON.stringify(entries)),byteLength,fileCount,entryCount:entries.length,entries};
}
const equivalent = (actual,expected,{privateModes=false}={}) => actual && actual.entries.length===expected.entries.length && actual.entries.every((entry,index)=>{
  const desired=expected.entries[index];return entry.path===desired.path&&entry.type===desired.type&&(privateModes||entry.mode===desired.mode)&&entry.hash===desired.hash&&entry.size===desired.size;
});
const subset=(actual,expected)=>actual&&actual.entries.every(entry=>{const desired=expected.entries.find(value=>value.path===entry.path);return desired&&equivalent({entries:[entry]},{entries:[desired]},{privateModes:true});});
function copyTree(from,to,snapshot,{privateModes=false,at,checkCancelled=()=>{}}={}) {
  for(const entry of snapshot.entries){
    checkCancelled();
    const source=entry.path?path.join(from,entry.path):from,target=entry.path?path.join(to,entry.path):to;
    if(entry.type==='directory'){mutate(path.dirname(target),'mkdir',{name:path.basename(target)},undefined,at);continue;}
    const before=fs.lstatSync(source,{bigint:true});if(!before.isFile()||before.nlink!==1n)fail('UNSAFE_FILE');
    const sourceParent=pinDirectory(path.dirname(source)),input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{
      checkDirectory(sourceParent);if(stamp(fs.fstatSync(input,{bigint:true}))!==stamp(before))fail('CONFLICT');
      mutate(path.dirname(target),'copy',{name:path.basename(target),sourceStamp:stamp(before),size:entry.size,hash:entry.hash,mode:privateModes?0o600:entry.mode},input,at);
      checkDirectory(sourceParent);if(stamp(fs.fstatSync(input,{bigint:true}))!==stamp(before)||stamp(fs.lstatSync(source,{bigint:true}))!==stamp(before))fail('CONFLICT');
    }finally{fs.closeSync(input);}
  }
  for(const entry of [...snapshot.entries].reverse().filter(entry=>entry.type==='directory')){const target=entry.path?path.join(to,entry.path):to;mutate(path.dirname(target),'chmod-directory',{name:path.basename(target),mode:privateModes?0o700:entry.mode},undefined,at);}
  syncDirectory(path.dirname(to));
  if(!equivalent(scan(to),snapshot,{privateModes}))fail('CONFLICT');
}
function validateSnapshot(value){
  if(!exact(value,['type','token','byteLength','fileCount','entryCount','entries'])||!['file','directory'].includes(value.type)||!digest(value.token)||!Number.isSafeInteger(value.byteLength)||value.byteLength<0||!Number.isSafeInteger(value.fileCount)||value.fileCount<0||!Array.isArray(value.entries)||!value.entries.length||value.entries.length>10000||value.entryCount!==value.entries.length)fail('RECOVERY_REQUIRED');
  const names=new Set();let bytes=0,files=0;
  for(const [index,entry] of value.entries.entries()){
    if(!exact(entry,entry.type==='file'?['path','type','hash','size','mode']:['path','type','mode'])||!['file','directory'].includes(entry.type)||!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o777)fail('RECOVERY_REQUIRED');
    if(index===0?entry.path!==''||entry.type!==value.type:!entry.path)fail('RECOVERY_REQUIRED');if(entry.path)managementPath(entry.path);
    const key=portablePathKey(entry.path);if(names.has(key))fail('RECOVERY_REQUIRED');names.add(key);
    if(entry.type==='file'){if(!digest(entry.hash)||!Number.isSafeInteger(entry.size)||entry.size<0)fail('RECOVERY_REQUIRED');bytes+=entry.size;files++;}
  }
  if(bytes!==value.byteLength||files!==value.fileCount||(value.type==='file'?value.entries.length!==1||value.token!==value.entries[0].hash:value.token!==hash(JSON.stringify(value.entries))))fail('RECOVERY_REQUIRED');
}
export function validateManagementPlan(plan){
  if(!exact(plan,['id','operation','items'])||!uuid(plan.id)||!['move','copy','trash','restore','import'].includes(plan.operation)||!Array.isArray(plan.items)||!plan.items.length||plan.items.length>256)fail('RECOVERY_REQUIRED');
  for(const item of plan.items){if(!exact(item,plan.operation==='import'?['path','newPath','trashId','snapshot','external']:['path','newPath','trashId','snapshot'])||!(item.path===null||typeof item.path==='string')||!(item.newPath===null||typeof item.newPath==='string')||!(item.trashId===null||uuid(item.trashId)))fail('RECOVERY_REQUIRED');if(item.path)managementPath(item.path);if(item.newPath)managementPath(item.newPath);validateSnapshot(item.snapshot);
    if(plan.operation==='import'&&(item.path!==null||item.trashId!==null||!item.newPath||!exact(item.external,['path','identity','kind'])||typeof item.external.path!=='string'||!path.isAbsolute(item.external.path)||path.normalize(item.external.path)!==item.external.path||item.external.path.length>4096||!/^\d+:\d+$/.test(item.external.identity)||!['file','directory'].includes(item.external.kind)))fail('RECOVERY_REQUIRED');
  }
}
export function validateManagedTrash(entry){
  if(!exact(entry,['format','trashId','path','snapshot'])||entry.format!=='tree-v1'||!uuid(entry.trashId))fail('RECOVERY_REQUIRED');managementPath(entry.path);validateSnapshot(entry.snapshot);
}

/** Byte operations use host-owned staging and retained originals, never text decoding. */
export function createFileManagement({source,privateRoot,check,hooks={}}){
  const archive=pinDirectory(privateRoot);
  const checkRoots=()=>{check();checkDirectory(archive);};
  const sourcePath=relative=>{managementPath(relative);checkRoots();return path.join(source.path,relative);};
  function admitted(relative){const target=sourcePath(relative);checkSourceSpelling(source.path,relative);const result=scan(target);checkRoots();if(!result)fail('NOT_FOUND');for(const entry of result.entries)managementPath(entry.path?`${relative}/${entry.path}`:relative);return result;}
  function inspectEntry({path:relative}){const {entries,...result}=admitted(relative);return {path:relative,...result};}
  function externalSnapshot(external,{cancel=true,onSkipped}={}){
    const current=inspectExternalSources([external.path])[0];if(JSON.stringify(current)!==JSON.stringify(external))fail('CONFLICT');
    return scan(external.path,{skipMetadata:true,onSkipped,checkCancelled:cancel?hooks.checkCancelled:undefined});
  }
  function prepareImport({sources,destination='',reservedPaths=[]}){
    checkRoots();hooks.checkCancelled?.();
    if(destination){managementPath(destination);checkSourceSpelling(source.path,destination);pinDirectory(sourcePath(destination));}
    if(!Array.isArray(sources)||!sources.length||sources.length>256)fail('INVALID_EXTERNAL_FILES');
    const parent=destination?sourcePath(destination):source.path,used=new Set(names(parent).map(portablePathKey));let skippedMetadata=0;
    const taken=relative=>reservedPaths.some(value=>overlap(value,relative));
    const items=[];let count=0;
    for(const external of sources){
      if(!exact(external,['path','identity','kind']))fail('INVALID_EXTERNAL_FILES');
      const filename=path.basename(external.path);if(externalMetadataName(filename)){inspectExternalSources([external.path]);skippedMetadata++;continue;}
      if(external.kind==='directory'&&contains(external.path,parent))fail('INVALID_DESTINATION');
      const snapshot=externalSnapshot(external,{onSkipped:()=>{skippedMetadata++;}});count+=snapshot.entryCount;if(count>10000)fail('LIMIT_EXCEEDED');
      const extension=snapshot.type==='file'?path.extname(filename):'',stem=extension?filename.slice(0,-extension.length):filename;
      let leaf=filename,index=1,relative=destination?`${destination}/${leaf}`:leaf;
      while(used.has(portablePathKey(leaf))||taken(relative)){
        if(index>10000)fail('LIMIT_EXCEEDED');leaf=`${stem} copy${index===1?'':` ${index}`}${extension}`;index++;relative=destination?`${destination}/${leaf}`:leaf;
      }
      managementPath(relative);for(const entry of snapshot.entries)managementPath(entry.path?`${relative}/${entry.path}`:relative);used.add(portablePathKey(leaf));
      items.push({path:null,newPath:relative,trashId:null,snapshot,external});
    }
    const plan=items.length?{id:randomUUID(),operation:'import',items}:null;if(plan)capacity(plan);return {plan,skippedMetadata};
  }
  function absent(relative){
    managementPath(relative);checkRoots();let parent=source.path;
    for(const [index,name] of relative.split('/').entries()){
      const directory=pinDirectory(parent),entries=names(parent);
      const matches=entries.filter(value=>portablePathKey(value)===portablePathKey(name));checkDirectory(directory);
      if(!matches.length){if(entries.length>=10000)fail('LIMIT_EXCEEDED');return;}
      if(matches.length!==1||matches[0]!==name)fail('ALREADY_EXISTS');
      if(index===relative.split('/').length-1)fail('ALREADY_EXISTS');
      parent=path.join(parent,name);pinDirectory(parent);
    }
  }
  function capacity(plan){
    const additions=new Map(),temporary=new Set(),parents=new Set();
    const add=relative=>additions.set(relative,(additions.get(relative)??0)+1);
    for(const item of plan.items){
      if(item.path&&plan.operation!=='copy')temporary.add(path.posix.dirname(item.path)==='.'?'':path.posix.dirname(item.path));
      if(item.newPath){
        const parts=item.newPath.split('/').slice(0,-1);
        for(let i=1;i<=parts.length;i++){
          const relative=parts.slice(0,i).join('/');
          if(!exists(sourcePath(relative))&&!parents.has(relative)){parents.add(relative);add(parts.slice(0,i-1).join('/'));}
        }
        const parent=parts.join('/');add(parent);temporary.add(parent);
      }
    }
    for(const relative of new Set([...additions.keys(),...temporary])){
      const filename=relative?sourcePath(relative):source.path;let count=0;
      if(exists(filename)){pinDirectory(filename);count=names(filename).length;}
      if(count+(additions.get(relative)??0)+(temporary.has(relative)?1:0)>10000)fail('LIMIT_EXCEEDED');
    }
    if(names(archive.path).length+1+(plan.operation==='trash'?plan.items.length:0)>10000)fail('LIMIT_EXCEEDED');
  }
  function prepare({operation,items}){
    if(!['move','copy','trash'].includes(operation)||!Array.isArray(items)||!items.length||items.length>256)fail('INVALID_REQUEST');
    const values=items.map(item=>{if(!exact(item,operation==='trash'?['path','token']:['path','token','newPath'])||!digest(item.token))fail('INVALID_REQUEST');managementPath(item.path);if(operation!=='trash')managementPath(item.newPath);return item;});
    for(let i=0;i<values.length;i++)for(let j=0;j<values.length;j++){
      if(i!==j&&overlap(values[i].path,values[j].path))fail('OVERLAPPING_PATHS');
      if(operation!=='trash'&&(overlap(values[i].path,values[j].newPath)||(i!==j&&overlap(values[i].newPath,values[j].newPath))))fail('OVERLAPPING_PATHS');
    }
    const result={id:randomUUID(),operation,items:values.map(item=>{const snapshot=admitted(item.path);if(snapshot.token!==item.token)fail('CONFLICT');if(item.newPath){absent(item.newPath);for(const entry of snapshot.entries)managementPath(entry.path?`${item.newPath}/${entry.path}`:item.newPath);}return {path:item.path,newPath:item.newPath??null,trashId:operation==='trash'?randomUUID():null,snapshot};})};
    if(result.items.reduce((total,item)=>total+item.snapshot.entryCount,0)>10000)fail('LIMIT_EXCEEDED');capacity(result);return result;
  }
  const workPath=plan=>path.join(archive.path,`.operation-${plan.id}`);
  const stagePath=(plan,index)=>path.join(path.dirname(sourcePath(plan.items[index].newPath)),`.asmb-new-${plan.id}-${index}`);
  const oldPath=(plan,index)=>path.join(path.dirname(sourcePath(plan.items[index].path)),`.asmb-old-${plan.id}-${index}`);
  const archivePath=id=>{if(!uuid(id))fail('RECOVERY_REQUIRED');checkRoots();return path.join(archive.path,id);};
  function workPin(plan){const pin=pinDirectory(workPath(plan));if((fs.statSync(pin.path).mode&0o777)!==0o700)fail('RECOVERY_REQUIRED');return pin;}
  const witnessPath=(plan,relative)=>path.join(workPath(plan),`reservation-${hash(relative)}.json`);
  function witness(plan,relative,identity){
    if(!identity&&!exists(workPath(plan)))return null;
    workPin(plan);const filename=witnessPath(plan,relative);
    if(identity){
      const value={id:plan.id,path:relative,identity},bytes=Buffer.from(JSON.stringify({value,checksum:hash(JSON.stringify(value))}));
      const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(workPath(plan));return identity;
    }
    const stat=exists(filename);if(!stat)return null;if(!stat.isFile()||stat.nlink!==1||stat.size>8192||(stat.mode&0o777)!==0o600)fail('RECOVERY_REQUIRED');
    const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const record=JSON.parse(fs.readFileSync(fd,'utf8'));if(!exact(record,['value','checksum'])||!exact(record.value,['id','path','identity'])||record.value.id!==plan.id||record.value.path!==relative||!/^\d+:\d+$/.test(record.value.identity)||record.checksum!==hash(JSON.stringify(record.value)))fail('RECOVERY_REQUIRED');return record.value.identity;}finally{fs.closeSync(fd);}
  }
  function stage(plan){
    validateManagementPlan(plan);checkRoots();fs.mkdirSync(workPath(plan),{mode:0o700});syncDirectory(archive.path);const pinned=workPin(plan);
    for(const [index,item] of plan.items.entries()){
      checkRoots();checkDirectory(pinned);
      if(plan.operation==='import'){
        const original=item.external.path;if(!equivalent(externalSnapshot(item.external),item.snapshot))fail('CONFLICT');
        copyTree(original,stagePath(plan,index),item.snapshot,{at:hooks.at,checkCancelled:hooks.checkCancelled});
        if(!equivalent(externalSnapshot(item.external),item.snapshot))fail('CONFLICT');
      }else if(plan.operation==='restore'){
        const original=archivePath(item.trashId);if(!equivalent(scan(original),item.snapshot,{privateModes:true}))fail('RECOVERY_REQUIRED');copyTree(original,stagePath(plan,index),item.snapshot,{at:hooks.at});
      }else{
        if(!equivalent(admitted(item.path),item.snapshot))fail('CONFLICT');
        if(plan.operation==='trash')copyTree(sourcePath(item.path),archivePath(item.trashId),item.snapshot,{privateModes:true,at:hooks.at});
        else copyTree(sourcePath(item.path),stagePath(plan,index),item.snapshot,{at:hooks.at});
        if(!equivalent(admitted(item.path),item.snapshot))fail('CONFLICT');
      }
    }
    hooks.at?.('management-after-staging');
  }
  function publish(plan,from,relative,snapshot){
    absent(relative);const destination=sourcePath(relative),parent=pinDirectory(path.dirname(destination));
    if(path.dirname(from)!==parent.path)fail('RECOVERY_REQUIRED');
    if(snapshot.type==='file'){
      // Exclusive link is an atomic no-overwrite publication on this filesystem.
      mutate(parent.path,'link-publish',{from:path.basename(from),to:path.basename(destination),entries:snapshot.entries},undefined,hooks.at);
    }else{
      // A verified empty reservation prevents replacing an unrelated directory.
      const reservation=mutate(parent.path,'mkdir',{name:path.basename(destination)},undefined,hooks.at);
      witness(plan,relative,reservation.identity);
      mutate(parent.path,'rename-directory',{from:path.basename(from),to:path.basename(destination),reservation:reservation.identity,entries:snapshot.entries},undefined,hooks.at);
    }
    checkDirectory(parent);if(!equivalent(scan(destination),snapshot))fail('CONFLICT');
  }
  function execute(plan){
    const pinned=workPin(plan);checkRoots();
    // Fence the complete selection again before moving any original.
    for(const item of plan.items){if(item.path&&!equivalent(admitted(item.path),item.snapshot))fail('CONFLICT');if(item.newPath)absent(item.newPath);}
    for(const [index,item] of plan.items.entries()){
      checkRoots();checkDirectory(pinned);hooks.at?.('management-before-item',{index});
      if(item.newPath)absent(item.newPath);
      if(plan.operation==='move'||plan.operation==='trash'){
        if(!equivalent(admitted(item.path),item.snapshot))fail('CONFLICT');const original=sourcePath(item.path),parent=pinDirectory(path.dirname(original));
        if(item.snapshot.type==='file')mutate(parent.path,'link-publish',{from:path.basename(original),to:path.basename(oldPath(plan,index)),entries:item.snapshot.entries},undefined,hooks.at);
        else{const reserved=mutate(parent.path,'mkdir',{name:path.basename(oldPath(plan,index))},undefined,hooks.at);mutate(parent.path,'rename-directory',{from:path.basename(original),to:path.basename(oldPath(plan,index)),reservation:reserved.identity,entries:item.snapshot.entries},undefined,hooks.at);}
        checkDirectory(parent);
        hooks.at?.('management-after-retain',{index});
      }
      if(item.newPath)publish(plan,stagePath(plan,index),item.newPath,item.snapshot);
      hooks.at?.('management-after-item',{index});
    }
  }
  function current(relative,linkedWith){
    const target=sourcePath(relative);try{checkSourceSpelling(source.path,relative);}catch(error){if(error.code==='PARTIAL')return null;throw error;}return scan(target,{linkedWith});
  }
  function removeOwned(target,snapshot,{partial=false,privateModes=false}={}){
    const actual=scan(target);if(!actual)return;
    const expected=new Map(snapshot.entries.map(entry=>[entry.path,entry]));
    if(!partial&&!equivalent(actual,snapshot,{privateModes}))fail('RECOVERY_REQUIRED');
    if(actual.entries.some(entry=>{const wanted=expected.get(entry.path);return !wanted||!equivalent({entries:[entry]},{entries:[wanted]},{privateModes});}))fail('RECOVERY_REQUIRED');
    for(const entry of actual.entries.filter(entry=>entry.type==='directory')){const filename=entry.path?path.join(target,entry.path):target;mutate(path.dirname(filename),'chmod-directory',{name:path.basename(filename),mode:0o700},undefined,hooks.at);}
    for(const entry of [...actual.entries].reverse()){
      checkRoots();const filename=entry.path?path.join(target,entry.path):target;
      if(entry.type==='directory')mutate(path.dirname(filename),'remove-directory',{name:path.basename(filename)},undefined,hooks.at);
      else mutate(path.dirname(filename),'remove-file',{name:path.basename(filename),hash:entry.hash,size:entry.size},undefined,hooks.at);
      hooks.at?.('management-after-cleanup-entry',{path:entry.path});
    }
  }
  function inspectOutcome(plan,{rollback=false}={}){
    validateManagementPlan(plan);checkRoots();
    return plan.items.map((item,index)=>{
      const stage=item.newPath?stagePath(plan,index):null,old=item.path?oldPath(plan,index):null;
      const original=item.path?current(item.path,old):null,destination=item.newPath?current(item.newPath,stage):null;
      const retained=old&&exists(old)?scan(old,{linkedWith:sourcePath(item.path)}):null;
      const staged=stage&&exists(stage)?scan(stage,{linkedWith:sourcePath(item.newPath)}):null;
      const reservationStat=item.newPath&&exists(sourcePath(item.newPath));
      const reservation=destination?.type==='directory'&&destination.entries.length===1&&witness(plan,item.newPath)===`${reservationStat.dev}:${reservationStat.ino}`;
      if(original&&!equivalent(original,item.snapshot)||retained&&!subset(retained,item.snapshot)||staged&&!subset(staged,item.snapshot)||destination&&!equivalent(destination,item.snapshot)&&!reservation&&!(rollback&&subset(destination,item.snapshot)))fail('RECOVERY_REQUIRED');
      if(plan.operation==='trash'&&!original&&!equivalent(scan(archivePath(item.trashId)),item.snapshot,{privateModes:true}))fail('RECOVERY_REQUIRED');
      const after=(plan.operation==='copy'||plan.operation==='restore'||plan.operation==='import'||!original)&&(item.newPath?equivalent(destination,item.snapshot):!original);
      return {original,destination,retained,staged,reservation,after};
    });
  }
  function settle(plan,{outcome='prepared',onDecision=()=>{}}={}){
    const states=inspectOutcome(plan,{rollback:outcome==='rollback'});
    const decision=outcome==='prepared'?(states.every(state=>state.after)?'completed':'rollback'):outcome;
    if(decision==='completed'&&!states.every(state=>state.after))fail('RECOVERY_REQUIRED');
    if(decision==='rollback')for(const [index,item] of plan.items.entries())if((plan.operation==='move'||plan.operation==='trash')&&!states[index].original&&!equivalent(states[index].retained,item.snapshot))fail('RECOVERY_REQUIRED');
    if(outcome==='prepared')onDecision(decision);
    if(decision==='completed'){
      for(const [index,item] of plan.items.entries()){
        const stage=item.newPath&&stagePath(plan,index),destination=item.newPath&&sourcePath(item.newPath);
        if(states[index].staged&&destination){const a=exists(stage),b=exists(destination);if(a?.isFile()&&b?.isFile()&&a.dev===b.dev&&a.ino===b.ino)mutate(path.dirname(stage),'remove-linked',{from:path.basename(stage),to:path.basename(destination)},undefined,hooks.at);}
      }
      return 'completed';
    }
    // The rollback decision is durable before removing any published copies.
    for(const [index,item] of [...plan.items.entries()].reverse()){
      const observed=states[index];
      if(item.newPath&&observed.destination){
        const destination=sourcePath(item.newPath),stage=stagePath(plan,index);
        if(observed.reservation&&!equivalent(observed.destination,item.snapshot))mutate(path.dirname(destination),'remove-directory',{name:path.basename(destination)},undefined,hooks.at);
        else{
          const a=exists(stage),b=exists(destination);
          if(a?.isFile()&&b?.isFile()&&a.dev===b.dev&&a.ino===b.ino)mutate(path.dirname(destination),'remove-linked',{from:path.basename(destination),to:path.basename(stage)},undefined,hooks.at);
          else removeOwned(destination,item.snapshot,{partial:true,privateModes:true});
        }
      }
      if(observed.original&&observed.retained){const original=sourcePath(item.path),old=oldPath(plan,index),a=exists(original),b=exists(old);if(a?.isFile()&&b?.isFile()&&a.dev===b.dev&&a.ino===b.ino)mutate(path.dirname(old),'remove-linked',{from:path.basename(old),to:path.basename(original)},undefined,hooks.at);}
      if((plan.operation==='move'||plan.operation==='trash')&&!observed.original){publish(plan,oldPath(plan,index),item.path,item.snapshot);}
    }
    return 'retained-old';
  }
  function cleanup(plan,outcome){
    if(!exists(workPath(plan)))return;const pinned=workPin(plan);
    hooks.at?.('management-before-cleanup');
    for(const [index,item] of plan.items.entries()){
      checkDirectory(pinned);
      for(const filename of [item.path&&oldPath(plan,index),item.newPath&&stagePath(plan,index)].filter(Boolean))removeOwned(filename,item.snapshot,{partial:true,privateModes:true});
      if(item.trashId&&(plan.operation==='restore'&&outcome==='completed'||plan.operation==='trash'&&outcome==='retained-old'))removeOwned(archivePath(item.trashId),item.snapshot,{partial:true,privateModes:true});
      for(const relative of [item.path,item.newPath].filter(Boolean))if(witness(plan,relative))fs.unlinkSync(witnessPath(plan,relative));
    }
    if(names(pinned.path).length)fail('RECOVERY_REQUIRED');fs.rmdirSync(pinned.path);syncDirectory(archive.path);
  }
  function abortStaging(plan){
    validateManagementPlan(plan);checkRoots();const copies=[];
    // Publication is forbidden in this durable phase. Preserve every original,
    // and retire only derived bytes proved equal to their admitted source prefix.
    for(const [index,item] of plan.items.entries()){
      const original=plan.operation==='restore'?archivePath(item.trashId):plan.operation==='import'?item.external.path:sourcePath(item.path);
      let sourceSnapshot;try{sourceSnapshot=plan.operation==='restore'?scan(original):plan.operation==='import'?externalSnapshot(item.external,{cancel:false}):admitted(item.path);}catch(error){if(plan.operation==='import')fail('RECOVERY_REQUIRED');throw error;}
      if(!equivalent(sourceSnapshot,item.snapshot,{privateModes:plan.operation==='restore'}))fail('RECOVERY_REQUIRED');
      const target=plan.operation==='trash'?archivePath(item.trashId):stagePath(plan,index),actual=scan(target);
      if(!actual)continue;
      for(const entry of actual.entries){
        const expected=item.snapshot.entries.find(value=>value.path===entry.path);
        if(!expected||entry.type!==expected.type)fail('RECOVERY_REQUIRED');
        if(entry.type==='file'&&(entry.size>expected.size||prefixHash(entry.path?path.join(original,entry.path):original,entry.size)!==entry.hash))fail('RECOVERY_REQUIRED');
      }
      copies.push({target,actual});
    }
    for(const copy of copies)removeOwned(copy.target,copy.actual,{privateModes:true});
    if(exists(workPath(plan))){const pinned=workPin(plan);if(names(pinned.path).length)fail('RECOVERY_REQUIRED');fs.rmdirSync(pinned.path);syncDirectory(archive.path);}
  }
  function restorePlan(entry){validateManagedTrash(entry);for(const child of entry.snapshot.entries)managementPath(child.path?`${entry.path}/${child.path}`:entry.path);absent(entry.path);if(!equivalent(scan(archivePath(entry.trashId)),entry.snapshot,{privateModes:true}))fail('RECOVERY_REQUIRED');const plan={id:randomUUID(),operation:'restore',items:[{path:null,newPath:entry.path,trashId:entry.trashId,snapshot:entry.snapshot}]};capacity(plan);return plan;}
  return {inspectEntry,prepare,prepareImport,stage,execute,settle,cleanup,abortStaging,restorePlan,absent,createDirectory:(parent,name)=>mutate(parent,'mkdir',{name,mode:0o755},undefined,hooks.at)};
}
