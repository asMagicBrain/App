import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {gitExecutable,gitEnvironment} from '../git-executable.mjs';
import {pinDirectory,checkDirectory} from '../physical-roots.mjs';
import {isPortableRelativePath,portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';
import {openRawFile} from './raw-file.mjs';
import {canonicalGitHubUrl} from './github-clone.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const stillPinned=p=>{for(const part of p.chain){const s=fs.lstatSync(part.path);if(!s.isDirectory()||s.isSymbolicLink()||`${s.dev}:${s.ino}`!==part.rawIdentity)fail('DENIED');}};
const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
const proofs=new WeakMap();
export function verifyCheckoutObservation(result){const p=proofs.get(result);if(!p)fail('STALE_PLAN');checkDirectory(p.root);checkDirectory(p.git);for(const f of p.files)if(stamp(fs.lstatSync(path.join(p.root.path,f.path)))!==f.stamp)fail('CONFLICT');for(const f of p.metadata)if(stamp(fs.lstatSync(f.path))!==f.stamp)fail('CONFLICT');for(const d of p.dirs){checkDirectory(d.pin);if(stamp(fs.lstatSync(d.pin.path))!==d.stamp)fail('CONFLICT');}}
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const decode=b=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{fail('CHECKOUT_UNSUPPORTED_ENTRY');}};
/** Read-only Git commands: no checkout, hooks, filters, credential helpers or network. */
async function git(root,args,{signal}={}){
 const env=gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_ALLOW_PROTOCOL:''});
 return new Promise((resolve,reject)=>execFile(gitExecutable(),['--no-pager','--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.interactive=false','-c','protocol.allow=never','-c','gc.auto=0','-c','maintenance.auto=false',`--git-dir=${root}/.git`,`--work-tree=${root}`,...args],{cwd:root,env,encoding:'buffer',maxBuffer:16*1024*1024,timeout:args[0]==='fsck'?600000:30000,signal},(error,stdout)=>error?reject(Object.assign(Error(signal?.aborted?'CHECKOUT_CANCELLED':error.killed?'CHECKOUT_GIT_TIMEOUT':'CHECKOUT_GIT_FAILED'),{code:signal?.aborted?'CHECKOUT_CANCELLED':error.killed?'CHECKOUT_GIT_TIMEOUT':'CHECKOUT_GIT_FAILED'})):resolve(stdout)));
}
function config(root){
 const gitPin=pinDirectory(path.join(root,'.git')),file=openRawFile(path.join(gitPin.path,'config'),65536);
 try{const b=Buffer.alloc(file.size);fs.readSync(file.fd,b,0,b.length,0);file.verify();const text=decode(b);if(/^\s*\[\s*(?:include(?:if)?|fsck)\b/im.test(text)||/^\s*(?:promisor|partialclone|partialclonefilter)\s*=/im.test(text))fail('CHECKOUT_CONFIG_UNSUPPORTED');return gitPin;}finally{file.close();}
}
export async function readCheckoutOrigin(root){const pin=pinDirectory(root),g=config(pin.path);const raw=decode(await git(pin.path,['config','--local','--no-includes','--get-all','remote.origin.url'])).trim();checkDirectory(g);checkDirectory(pin);return canonicalGitHubUrl(raw);}
/** Explicit reviewed intake may stream all bytes once; ordinary navigation must never call it. */
export async function inspectExistingCheckout(root,{signal,onProgress=()=>{}}={}){
 const pin=pinDirectory(root),g=config(pin.path);let metadataCount=0;const metadataProof=[];
 const check=()=>{if(signal?.aborted)fail('CHECKOUT_CANCELLED');stillPinned(pin);stillPinned(g);};
 const metadata=(dir,depth=0)=>{if(depth>64)fail('CHECKOUT_ENTRY_LIMIT');for(const n of fs.readdirSync(dir)){if(signal?.aborted)fail('CHECKOUT_CANCELLED');const p=path.join(dir,n),s=fs.lstatSync(p);if(++metadataCount>100000)fail('CHECKOUT_ENTRY_LIMIT');if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink!==1))fail('UNSAFE_GIT_METADATA');metadataProof.push({path:p,stamp:stamp(s)});if(s.isDirectory())metadata(p,depth+1);}};metadata(g.path);
 for(const n of ['commondir','objects/info/alternates','objects/info/http-alternates','shallow','info/grafts'])if(fs.existsSync(path.join(g.path,n)))fail('UNSUPPORTED_GIT_DIRECTORY');
 await git(root,['fsck','--full','--no-dangling'],{signal});check();
 const origin=await readCheckoutOrigin(root),head=decode(await git(root,['rev-parse','--verify','HEAD'])).trim(),branchRef=decode(await git(root,['symbolic-ref','HEAD'])).trim();
 if(!/^[a-f0-9]{40}$/.test(head)||!branchRef.startsWith('refs/heads/'))fail('CHECKOUT_BRANCH_REQUIRED');const branch=branchRef.slice(11);
 const trackingHead=decode(await git(root,['rev-parse','--verify','refs/remotes/origin/'+branch])).trim();if(!/^[a-f0-9]{40}$/.test(trackingHead))fail('CHECKOUT_TRACKING_REQUIRED');if(trackingHead!==head)fail('CHECKOUT_NOT_SYNCHRONIZED');
 const tree=decode(await git(root,['ls-tree','-rz','--full-tree',head])).split('\0').filter(Boolean),index=decode(await git(root,['ls-files','--stage','-z'])).split('\0').filter(Boolean),expected=new Map(),treeNames=new Map();
 for(const row of tree){const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(row);if(!m)fail('CHECKOUT_UNSUPPORTED_ENTRY');if(!isPortableRelativePath(m[3])||!m[3].isWellFormed()||m[3].split('/').length>32)fail('CHECKOUT_UNSUPPORTED_ENTRY');let part='';const parts=m[3].split('/');for(let i=0;i<parts.length;i++){part+=(i?'/':'')+parts[i];const k=portablePathKey(part),prior=treeNames.get(k),kind=i===parts.length-1?'file':'directory';if(prior&&(prior.path!==part||prior.kind!==kind||kind==='file'))fail('CHECKOUT_UNSUPPORTED_ENTRY');treeNames.set(k,{path:part,kind});}expected.set(m[3],{mode:m[1],sha:m[2]});}
 if(index.length!==expected.size||index.some(row=>{const m=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/s.exec(row),e=m&&expected.get(m[3]);return !e||e.sha!==m[2]||e.mode!==m[1];}))fail('CHECKOUT_DIRTY');
 const names=new Map(),files=[],dirs=[];let entries=0;
 const walk=(dir,relative='')=>{const dp=pinDirectory(dir);dirs.push({pin:dp,stamp:stamp(fs.lstatSync(dir))});for(const n of fs.readdirSync(dir).sort()){if(!relative&&n==='.git')continue;if(signal?.aborted)fail('CHECKOUT_CANCELLED');const rel=relative?relative+'/'+n:n,p=path.join(dir,n),s=fs.lstatSync(p),key=portablePathKey(rel);if(++entries>20000)fail('CHECKOUT_ENTRY_LIMIT');if(!isPortableRelativePath(rel)||!rel.isWellFormed()||rel.split('/').length>32||names.has(key))fail('CHECKOUT_UNSUPPORTED_ENTRY');names.set(key,rel);if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink!==1))fail('UNSAFE_FILE');if(s.isDirectory())walk(p,rel);else files.push({path:rel,stamp:stamp(s),size:s.size});}checkDirectory(dp);};walk(root);
 if(files.length!==expected.size||files.some(f=>!expected.has(f.path)))fail('CHECKOUT_DIRTY');
 const totalBytes=files.reduce((n,f)=>n+f.size,0);let checkedBytes=0;
 for(const f of files){check();const filename=path.join(root,f.path);if(stamp(fs.lstatSync(filename))!==f.stamp)fail('CONFLICT');const file=openRawFile(filename,Number.MAX_SAFE_INTEGER),h=createHash('sha1').update(`blob ${file.size}\0`),chunk=Buffer.allocUnsafe(64*1024);try{let offset=0;while(offset<file.size){if(signal?.aborted)fail('CHECKOUT_CANCELLED');const count=fs.readSync(file.fd,chunk,0,Math.min(chunk.length,file.size-offset),offset);if(!count)fail('CONFLICT');h.update(chunk.subarray(0,count));offset+=count;checkedBytes+=count;if(offset%(8*1024*1024)===0)check();if(offset%(1024*1024)===0){onProgress({phase:'checking',checkedBytes,totalBytes,files:files.length});await yieldTurn();}}file.verify();const entry=expected.get(f.path);if(h.digest('hex')!==entry.sha||entry.mode!==file.mode)fail('CHECKOUT_DIRTY');}finally{file.close();}await yieldTurn();}
 for(const f of files)if(stamp(fs.lstatSync(path.join(root,f.path)))!==f.stamp)fail('CONFLICT');for(const d of dirs){checkDirectory(d.pin);if(stamp(fs.lstatSync(d.pin.path))!==d.stamp)fail('CONFLICT');}check();
 if(decode(await git(root,['rev-parse','HEAD'])).trim()!==head||decode(await git(root,['ls-files','--stage','-z']))!==index.join('\0')+(index.length?'\0':''))fail('CONFLICT');
 checkDirectory(pin);checkDirectory(g);const result={origin,branch,head,trackingHead,files:files.length,bytes:totalBytes,identity:pin.identity,clean:true,indexHash:digest(index),fingerprint:digest({head,branch,trackingHead,origin,files})};proofs.set(result,{root:pin,git:g,files,dirs,metadata:metadataProof});verifyCheckoutObservation(result);onProgress({phase:'checked',checkedBytes,totalBytes,files:files.length});return result;
}
