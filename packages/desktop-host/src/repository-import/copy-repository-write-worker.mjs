import fs from 'node:fs';
import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};const id=s=>`${s.dev}:${s.ino}`;
const stamp=s=>['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const flags=fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const leaf=n=>typeof n==='string'&&n.length>0&&!['.','..'].includes(n)&&!/[\/\\\0]/.test(n);
try{
 const r=JSON.parse(fs.readFileSync(0,'utf8'));if(id(fs.statSync('.'))!==r.identity)fail('DESTINATION_CHANGED');const parent=fs.openSync('.',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|flags);let value=null;
 try{if(r.operation==='mkdir'){
  if(!leaf(r.name))fail('INVALID_PATH');fs.mkdirSync(r.name,{mode:0o700});value=id(fs.lstatSync(r.name));
 }else if(r.operation==='mode'){
  if(!leaf(r.name))fail('INVALID_PATH');const fd=fs.openSync(r.name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|flags);try{if(id(fs.fstatSync(fd))!==r.childIdentity)fail('DESTINATION_CHANGED');fs.fchmodSync(fd,r.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }else if(r.operation==='copy'){
  if(!Array.isArray(r.files)||r.files.length>32)fail('INVALID_REQUEST');
  for(const f of r.files){if(!leaf(f.name)||stamp(fs.fstatSync(f.fd,{bigint:true}))!==f.stamp)fail('SOURCE_CHANGED');const fd=fs.openSync(f.name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|flags,0o600);try{const b=Buffer.alloc(128*1024),h=createHash('sha256');let offset=0;while(offset<f.size){const n=fs.readSync(f.fd,b,0,Math.min(b.length,f.size-offset),offset);if(!n)fail('SOURCE_CHANGED');h.update(b.subarray(0,n));let sent=0;while(sent<n)sent+=fs.writeSync(fd,b,sent,n-sent);offset+=n;}if(h.digest('hex')!==f.hash||stamp(fs.fstatSync(f.fd,{bigint:true}))!==f.stamp)fail('SOURCE_CHANGED');fs.fchmodSync(fd,f.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 }else fail('INVALID_REQUEST');fs.fsyncSync(parent);if(id(fs.statSync('.'))!==r.identity)fail('DESTINATION_CHANGED');}finally{fs.closeSync(parent);}process.stdout.write(JSON.stringify({ok:true,value}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code??'DUPLICATE_FAILED'}));process.exitCode=1;}
