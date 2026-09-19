// Fixed, host-internal commands. cwd is an admitted physical parent; operations
// use basenames only. Retain the actual displaced leaf before publication.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const identity=s=>`${s.dev}:${s.ino}`,flags=fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const stamp=s=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const sync=()=>{const fd=fs.openSync('.',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|flags);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function observe(name){
 let before;try{before=fs.lstatSync(name,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink>2n)fail('APPLY_RECOVERY_REQUIRED');
 const fd=fs.openSync(name,fs.constants.O_RDONLY|flags),hash=createHash('sha256'),chunk=Buffer.alloc(65536);let size=0;
 try{if(stamp(before)!==stamp(fs.fstatSync(fd,{bigint:true})))fail('APPLY_RECOVERY_REQUIRED');for(;;){const n=fs.readSync(fd,chunk,0,Math.min(chunk.length,Number(before.size)-size+1),null);if(!n)break;size+=n;if(size>Number(before.size))fail('APPLY_RECOVERY_REQUIRED');hash.update(chunk.subarray(0,n));}if(stamp(before)!==stamp(fs.fstatSync(fd,{bigint:true}))||stamp(before)!==stamp(fs.lstatSync(name,{bigint:true})))fail('APPLY_RECOVERY_REQUIRED');return {hash:hash.digest('hex'),mode:before.mode&0o111n?'100755':'100644',size,identity:identity(before),links:Number(before.nlink)};}finally{fs.closeSync(fd);}
}
const equal=(a,b)=>a===null||b===null?a===b:a.hash===b.hash&&a.mode===b.mode&&a.size===b.size;
try{
 const r=JSON.parse(fs.readFileSync(0,'utf8'));if(identity(fs.statSync('.'))!==r.parentIdentity)fail('APPLY_RECOVERY_REQUIRED');
 for(const k of ['name','stage','previous'])if(r[k]!==undefined&&(typeof r[k]!=='string'||!r[k]||['.','..'].includes(r[k])||/[\/\\\0]/.test(r[k])))fail('INVALID_PATH');
 let value={};
 if(r.command==='copy'){
  const before=fs.fstatSync(3,{bigint:true});if(!before.isFile()||before.nlink!==1n||stamp(before)!==r.stamp)fail('APPLY_STALE');
  const fd=fs.openSync(r.name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|flags,0o600),hash=createHash('sha256'),buf=Buffer.alloc(65536);let size=0;
  try{for(;;){const n=fs.readSync(3,buf,0,Math.min(buf.length,r.expected.size-size+1),null);if(!n)break;size+=n;if(size>r.expected.size)fail('APPLY_STALE');hash.update(buf.subarray(0,n));let i=0;while(i<n)i+=fs.writeSync(fd,buf,i,n-i);}if(size!==r.expected.size||hash.digest('hex')!==r.expected.hash||stamp(before)!==stamp(fs.fstatSync(3,{bigint:true})))fail('APPLY_STALE');fs.fchmodSync(fd,r.expected.mode==='100755'?0o755:0o644);fs.fsyncSync(fd);value={identity:identity(fs.fstatSync(fd))};}finally{fs.closeSync(fd);}sync();
 }else if(r.command==='publish'){
  const current=observe(r.name),candidate=r.after?observe(r.stage):null,retained=observe(r.previous);
  if(equal(current,r.after)){
   if(candidate&&current&&candidate.identity===current.identity){fs.unlinkSync(r.stage);sync();}
   else if(candidate)fail('APPLY_RECOVERY_REQUIRED');
   value={state:'new'};
  }else{
   if(!equal(current,r.before)&&!(current===null&&equal(retained,r.before)&&r.before))fail('APPLY_RECOVERY_REQUIRED');
   if(r.after&&!equal(candidate,r.after))fail('APPLY_RECOVERY_REQUIRED');
   if(current){if(retained)fail('APPLY_RECOVERY_REQUIRED');fs.renameSync(r.name,r.previous);sync();if(r.stopAfter==='retain')process.exit(86);const actual=observe(r.previous);if(!equal(actual,r.before)){try{fs.linkSync(r.previous,r.name);sync();}catch{}fail('APPLY_RECOVERY_REQUIRED');}}
   if(r.after){fs.linkSync(r.stage,r.name);sync();if(r.stopAfter==='link')process.exit(86);fs.unlinkSync(r.stage);sync();if(r.stopAfter==='unlink')process.exit(86);}
   if(!equal(observe(r.name),r.after))fail('APPLY_RECOVERY_REQUIRED');value={state:'new'};
  }
 }else if(r.command==='mkdir'){fs.mkdirSync(r.name,{mode:0o755});sync();value={identity:identity(fs.lstatSync(r.name))};}
 else if(r.command==='rmdir'){const s=fs.lstatSync(r.name);if(!s.isDirectory()||s.isSymbolicLink()||identity(s)!==r.identity)fail('APPLY_RECOVERY_REQUIRED');fs.rmdirSync(r.name);sync();}
 else if(r.command==='publish-index'){
  const current=observe(r.name),candidate=observe(r.stage);if(!candidate||candidate.identity!==r.identity||!equal(candidate,r.after)||!equal(current,r.before))fail('APPLY_RECOVERY_REQUIRED');fs.renameSync(r.stage,r.name);sync();if(!equal(observe(r.name),r.after))fail('APPLY_RECOVERY_REQUIRED');
 }else if(r.command==='remove'){
  const current=observe(r.name);if(current){if(!equal(current,r.expected))fail('APPLY_RECOVERY_REQUIRED');fs.unlinkSync(r.name);sync();}
 }else fail('INVALID_COMMAND');
 process.stdout.write(JSON.stringify({ok:true,value}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code??'APPLY_FAILED'}));process.exitCode=1;}
