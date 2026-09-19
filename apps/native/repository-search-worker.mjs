import {persistentIdentity, runStorageWorkerEnvelope} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import {gitExecutable, gitEnvironment} from '../../packages/desktop-host/src/git-executable.mjs';
// Internal process: cwd pins each traversed directory. File basenames open with
// O_NOFOLLOW; ripgrep receives already-open descriptors, never workspace paths.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import ignore from './dist-host/search-ignore.mjs';
import {isInspectableRelativePath} from '../../packages/source-foundation/src/domain/path-policy.mjs';
const identity=persistentIdentity;
const stamp=s=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const allowed=relative=>isInspectableRelativePath(relative)&&relative.split('/').length<=32&&!relative.split('/').some(part=>part.toLowerCase()==='.asmagicbrain'||part.toLowerCase().startsWith('.asmb-'));
let child=null,cancelled=false;
process.on('SIGTERM',()=>{cancelled=true;child?.kill('SIGTERM');});
async function command(executable,args,{fds=[],max=2*1024*1024,timeout=5000}={}){
 if(cancelled)fail('SEARCH_CANCELLED');
 return new Promise((resolve,reject)=>{
  child=spawn(executable,args,{env:gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:process.env.TMPDIR,TMP:process.env.TMPDIR,TEMP:process.env.TMPDIR,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''}),stdio:['ignore','pipe','pipe',...fds]});
  const current=child;let chunks=[],bytes=0,overflow=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;current.kill('SIGTERM');},timeout);timer.unref();
  current.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>max){overflow=true;current.kill('SIGTERM');}else chunks.push(chunk);});current.stderr.resume();
  current.once('error',()=>{});current.once('close',code=>{clearTimeout(timer);child=null;if(cancelled)return reject(Object.assign(Error('cancelled'),{code:'SEARCH_CANCELLED'}));resolve({code,bytes:Buffer.concat(chunks),overflow,timedOut});});
 });
}
try{
 await runStorageWorkerEnvelope(JSON.parse(fs.readFileSync(0,'utf8')),async request=>{
 const {kind,input,roots,ripgrepPath,limits}=request;
 const start=Date.now(),result=kind==='files'?{requestId:input.requestId,repo:input.repo,ref:input.ref??'',commit:null,paths:[],truncated:false}:{requestId:input.requestId,matches:[],truncated:false,searchedFiles:0,skippedFiles:0};
 let seen=0,totalBytes=0,batch=[],visited=0,stopped=false,resultBytes=512;const readBuffer=Buffer.alloc(64*1024);
 const elapsed=()=>{if(cancelled)fail('SEARCH_CANCELLED');if(Date.now()-start>=limits.timeMs){result.truncated=true;result.reason='timeout';stopped=true;return true;}return false;};
 const limit=()=>{result.truncated=true;result.reason='limit';stopped=true;};
 const addPath=value=>{const bytes=Buffer.byteLength(JSON.stringify(value))+1;if(resultBytes+bytes>limits.outputBytes-1024){limit();return false;}resultBytes+=bytes;result.paths.push(value);return true;};
 const fdRead=(name,maxBytes)=>{
  const before=fs.lstatSync(name,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maxBytes))return null;
  const fd=fs.openSync(name,flags);try{if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before))fail('SEARCH_CHANGED');const bytes=Buffer.alloc(Number(before.size)+1);const count=fs.readSync(fd,bytes,0,bytes.length,0);if(count!==Number(before.size)||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(before))fail('SEARCH_CHANGED');return bytes.subarray(0,count);}finally{fs.closeSync(fd);}
 };
 async function flush(){
  if(!batch.length)return;const records=batch;batch=[];
  try{
   const args=['--no-config','--threads','1','--json','--fixed-strings','--line-number','--color','never','--no-mmap','--encoding','none','--max-count',String(limits.matches),...(input.caseSensitive?['--case-sensitive']:['--ignore-case']),'-e',input.query,'--',...records.map((_,i)=>'/dev/fd/'+(i+3))];
   const reply=await command(ripgrepPath,args,{fds:records.map(x=>x.fd),max:limits.outputBytes,timeout:Math.max(1,limits.timeMs-(Date.now()-start))});
   if(reply.timedOut){result.truncated=true;result.reason='timeout';stopped=true;return;}if(reply.overflow){limit();return;}if(![0,1].includes(reply.code))fail('SEARCH_FAILED');
   const matches=[];const invalid=new Set();
   for(const line of reply.bytes.toString('utf8').split('\n').filter(Boolean)){
    const message=JSON.parse(line);if(message.type==='end'&&message.data.binary_offset!==null){const key=message.data.path?.text;invalid.add(key);continue;}if(message.type!=='match')continue;
    const data=message.data,key=data.path?.text,index=Number(key?.slice('/dev/fd/'.length))-3,record=records[index];if(!record||key!=='/dev/fd/'+(index+3))fail('SEARCH_FAILED');
    let bytes,lineText;try{bytes=data.lines.text!==undefined?Buffer.from(data.lines.text):Buffer.from(data.lines.bytes,'base64');lineText=decode(bytes).replace(/\r?\n$/,'');}catch{invalid.add(key);continue;}
    if(lineText.length>4096){result.truncated=true;result.reason='limit';invalid.add(key);continue;}if(lineText.includes('\0')){invalid.add(key);continue;}
    if(!Number.isSafeInteger(data.line_number)||data.line_number<1)fail('SEARCH_FAILED');
    for(const match of data.submatches){
     if(!Number.isSafeInteger(match.start)||!Number.isSafeInteger(match.end)||match.start<0||match.end<match.start||match.end>bytes.length)fail('SEARCH_FAILED');
     let column,endColumn;try{column=decode(bytes.subarray(0,match.start)).length+1;endColumn=decode(bytes.subarray(0,match.end)).length+1;}catch{invalid.add(key);continue;}
     matches.push({key,record,value:{repo:record.repo,path:record.path,line:data.line_number,column,endColumn,lineText,sourceHash:record.sourceHash}});
    }
   }
   for(const record of records)if(stamp(fs.fstatSync(record.fd,{bigint:true}))!==record.stamp)fail('SEARCH_CHANGED');
   result.searchedFiles+=records.length;result.skippedFiles+=invalid.size;
   for(const match of matches){if(invalid.has(match.key))continue;if(result.matches.length>=limits.matches){limit();break;}const size=Buffer.byteLength(JSON.stringify(match.value))+1;if(resultBytes+size>limits.outputBytes-1024){limit();break;}resultBytes+=size;result.matches.push(match.value);if(result.matches.length>=limits.matches){limit();break;}}
  }finally{for(const record of records)fs.closeSync(record.fd);}
 }
 async function walk(root,relative,rules,expected){
  if(elapsed()||stopped)return;if(identity(fs.statSync('.'))!==expected)fail('SEARCH_CHANGED');
  const before=fs.statSync('.',{bigint:true});
  const localRules=[...rules];
  if(kind==='text')for(const name of ['.gitignore','.ignore']){
   try{const bytes=fdRead(name,64*1024);if(bytes)localRules.push({base:relative,matcher:ignore().add(decode(bytes))});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const directory=fs.opendirSync('.'),entries=[];
  try{for(let entry=directory.readSync();entry;entry=directory.readSync()){if(++visited>30000){limit();break;}entries.push(entry.name);}}finally{directory.closeSync();}
  for(const name of entries.sort()){
   if(elapsed()||stopped)break;const relativePath=relative?relative+'/'+name:name;if(!allowed(relativePath))continue;
   const state=fs.lstatSync(name,{bigint:true});if(state.isSymbolicLink()||(!state.isDirectory()&&!state.isFile()))continue;
   const candidate=relativePath+(state.isDirectory()?'/':'');
   if(kind==='text'){
    let ignored=false;for(const rule of localRules){const suffix=rule.base?candidate.slice(rule.base.length+1):candidate,verdict=rule.matcher.test(suffix);if(verdict.ignored)ignored=true;else if(verdict.unignored)ignored=false;}if(ignored)continue;
   }
   if(state.isDirectory()){
    if(relativePath.split('/').length>=limits.depth){limit();continue;}
    process.chdir(name);if(identity(fs.statSync('.'))!==identity(state))fail('SEARCH_CHANGED');
    await walk(root,relativePath,localRules,identity(state));process.chdir('..');if(identity(fs.statSync('.'))!==expected)fail('SEARCH_CHANGED');
   }else{
    if(state.nlink!==1n)continue;if(++seen>limits.files){limit();break;}
    if(kind==='files'){addPath(relativePath);continue;}
    if(input.path&&relativePath!==input.path&&!relativePath.startsWith(input.path+'/'))continue;
    if(state.size>BigInt(limits.fileBytes)){result.skippedFiles++;result.truncated=true;result.reason='limit';continue;}
    if(totalBytes+Number(state.size)>limits.totalBytes){result.skippedFiles++;limit();break;}
    const fd=fs.openSync(name,flags);if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(state)){fs.closeSync(fd);fail('SEARCH_CHANGED');}
    totalBytes+=Number(state.size);
    const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),hasher=createHash('sha256');let offset=0,text=true;
    try{while(offset<Number(state.size)){const count=fs.readSync(fd,readBuffer,0,Math.min(readBuffer.length,Number(state.size)-offset),offset);if(!count)fail('SEARCH_CHANGED');const bytes=readBuffer.subarray(0,count);if(bytes.includes(0)){text=false;break;}decoder.decode(bytes,{stream:true});hasher.update(bytes);offset+=count;}if(text)decoder.decode();}catch(error){if(error.code==='SEARCH_CHANGED'){fs.closeSync(fd);throw error;}text=false;}
    if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(state)){fs.closeSync(fd);fail('SEARCH_CHANGED');}
    if(!text){fs.closeSync(fd);result.skippedFiles++;continue;}
    batch.push({fd,repo:root.repo,path:relativePath,stamp:stamp(state),sourceHash:hasher.digest('hex')});if(batch.length>=32)await flush();
   }
  }
  if(identity(fs.statSync('.'))!==identity(before))fail('SEARCH_CHANGED');
 }
 for(const root of roots){
  if(elapsed()||stopped)break;process.chdir(root.path);if(identity(fs.statSync('.'))!==root.identity)fail('SEARCH_CHANGED');
  if(kind==='files'&&input.ref){
   const gitDir=fs.lstatSync('.git');if(!gitDir.isDirectory()||gitDir.isSymbolicLink())fail('SEARCH_UNAVAILABLE');
   const args=['--no-pager','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.interactive=false','-c','core.hooksPath=/dev/null'];
   const refs=await command(gitExecutable(),[...args,'for-each-ref','--format=%(refname)','refs/heads/','refs/tags/']);if(refs.code!==0||refs.overflow||!refs.bytes.toString().split('\n').includes(input.ref))fail('INVALID_REF');
   const ref=await command(gitExecutable(),[...args,'rev-parse','--verify','--end-of-options',input.ref+'^{commit}']);const oid=ref.bytes.toString().trim();if(ref.code!==0||! /^[a-f0-9]{40,64}$/.test(oid))fail('INVALID_REF');
   const tree=await command(gitExecutable(),[...args,'ls-tree','-rz','--full-tree',oid]);if(tree.code!==0||tree.overflow||tree.timedOut)fail('SEARCH_LIMIT_EXCEEDED');
   for(const entry of decode(tree.bytes).split('\0').filter(Boolean)){
    const tab=entry.indexOf('\t'),[mode,type]=entry.slice(0,tab).split(' '),name=entry.slice(tab+1);if(!['100644','100755'].includes(mode)||type!=='blob'||!allowed(name))continue;
    if(result.paths.length>=limits.files){limit();break;}if(!addPath(name))break;
   }result.commit=oid;
  }else await walk(root,'',[],root.identity);
 }
 await flush();if(kind==='files')result.paths.sort();if(cancelled)fail('SEARCH_CANCELLED');process.stdout.write(JSON.stringify({ok:true,value:result}));
 });
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:typeof error.code==='string'?error.code:'SEARCH_FAILED'}));process.exitCode=1;}
