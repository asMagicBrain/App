import fs from 'node:fs';import path from 'node:path';import {setImmediate as yieldTurn} from 'node:timers/promises';
import {pinDirectory,checkDirectory,contains} from '../physical-roots.mjs';
import {openRawFile} from '../local-git/raw-file.mjs';
import {inspectExistingCheckout} from '../local-git/checkout-adoption.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const stillPinned=p=>{for(const part of p.chain){const s=fs.lstatSync(part.path);if(!s.isDirectory()||s.isSymbolicLink()||`${s.dev}:${s.ino}`!==part.rawIdentity)fail('DENIED');}};
const stamp=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':');
/** Copy only after explicit review. Originals and their Git metadata are never written. */
export async function copyReviewedCheckout({sourceRoot,destination,reviewed,signal,onProgress=()=>{}}){
 const source=pinDirectory(sourceRoot),target=pinDirectory(destination);if(contains(source.path,target.path)||contains(target.path,source.path)||source.identity!==reviewed.identity)fail('INVALID_ROOT');
 const check=()=>{if(signal?.aborted)fail('CHECKOUT_CANCELLED');stillPinned(source);stillPinned(target);};
 const files=[],dirs=[];let entries=0,totalBytes=0;
 const walk=(dir,rel='')=>{const pin=pinDirectory(dir);dirs.push({pin,rel,stamp:stamp(fs.lstatSync(dir))});for(const n of fs.readdirSync(dir).sort()){check();const p=path.join(dir,n),r=rel?rel+'/'+n:n,s=fs.lstatSync(p);if(++entries>120000)fail('CHECKOUT_ENTRY_LIMIT');if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink!==1))fail('UNSAFE_FILE');if(s.isDirectory())walk(p,r);else{totalBytes+=s.size;if(totalBytes>32*1024**3)fail('CHECKOUT_SIZE_LIMIT');files.push({rel:r,size:s.size,mode:s.mode&0o777,stamp:stamp(s)});}}};walk(source.path);
 const disk=fs.statfsSync(target.path);if(Number(disk.bavail)*Number(disk.bsize)<totalBytes+256*1024**2)fail('CLONE_DISK_SPACE');
 for(const d of dirs)if(d.rel)fs.mkdirSync(path.join(target.path,d.rel),{mode:0o700});let checkedBytes=0;const chunk=Buffer.allocUnsafe(64*1024);
 for(const f of files){check();if(f.rel==='.git/config')continue;const src=path.join(source.path,f.rel),dst=path.join(target.path,f.rel);if(stamp(fs.lstatSync(src))!==f.stamp)fail('CONFLICT');const file=openRawFile(src,Number.MAX_SAFE_INTEGER),fd=fs.openSync(dst,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let at=0;while(at<file.size){if(signal?.aborted)fail('CHECKOUT_CANCELLED');const count=fs.readSync(file.fd,chunk,0,Math.min(chunk.length,file.size-at),at);if(!count)fail('CONFLICT');let done=0;while(done<count){const n=fs.writeSync(fd,chunk,done,count-done);if(!n)fail('EIO');done+=n;}at+=count;checkedBytes+=count;if(at%(8*1048576)===0)check();if(at%1048576===0){onProgress({phase:'copying',checkedBytes,totalBytes,files:files.length});await yieldTurn();}}file.verify();fs.fchmodSync(fd,f.mode);fs.fsyncSync(fd);}finally{file.close();fs.closeSync(fd);}await yieldTurn();}
 for(const f of files)if(stamp(fs.lstatSync(path.join(source.path,f.rel)))!==f.stamp)fail('CONFLICT');for(const d of dirs){checkDirectory(d.pin);if(stamp(fs.lstatSync(d.pin.path))!==d.stamp)fail('CONFLICT');}check();
 // Never carry credential helpers, headers or custom executable settings into
 // the managed copy. The original config stays intact; refs/objects stay exact.
 const cfg=path.join(target.path,'.git/config'),fd=fs.openSync(cfg,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW);try{fs.writeFileSync(fd,`[core]\n repositoryformatversion = 0\n filemode = true\n bare = false\n logallrefupdates = true\n autocrlf = false\n[remote "origin"]\n url = ${reviewed.origin}\n fetch = +refs/heads/*:refs/remotes/origin/*\n`);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 checkDirectory(source);checkDirectory(target);const copied=await inspectExistingCheckout(target.path,{signal,onProgress});if(copied.head!==reviewed.head||copied.origin!==reviewed.origin||copied.branch!==reviewed.branch||copied.files!==reviewed.files||copied.bytes!==reviewed.bytes)fail('CONFLICT');return copied;
}
