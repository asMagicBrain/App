import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {pinDirectory,checkDirectory} from '../physical-roots.mjs';
import {isPortableRelativePath,portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

export function cloneFailureCode(stderr){if(/Resource not accessible by integration|GitHub App.*permission/i.test(stderr))return 'CLONE_APP_PERMISSION';if(/SAML|SSO|organization.*authoriz/i.test(stderr))return 'CLONE_ORG_AUTHORIZATION';if(/no space left|disk full/i.test(stderr))return 'CLONE_DISK_SPACE';if(/HTTP 401|Authentication failed|could not read Username|terminal prompts disabled/i.test(stderr))return 'CLONE_AUTH_REQUIRED';if(/HTTP 403|access denied|permission denied/i.test(stderr))return 'CLONE_PERMISSION_REQUIRED';if(/Repository not found/i.test(stderr))return 'CLONE_REPOSITORY_UNAVAILABLE';if(/timed out|timeout/i.test(stderr))return 'CLONE_TIMEOUT';if(/could not resolve|failed to connect|connection reset|TLS|SSL/i.test(stderr))return 'CLONE_TRANSPORT_FAILED';return 'CLONE_FAILED';}
const fail=code=>{throw Object.assign(new Error(code),{code});};
const MAX_OUTPUT=16*1024*1024;
// Intake bounds do not limit later file management. Ordinary and executable
// blobs are copied byte for byte; LFS objects and submodules are never fetched.
export const GITHUB_CLONE_LIMITS=Object.freeze({files:10000,bytes:16*1024*1024*1024,metadataEntries:100000,timeoutMs:2*60*60*1000,stallMs:2*60*1000,reserveBytes:256*1024*1024});
export function canonicalGitHubUrl(value){
 if(typeof value!=='string'||value.length>512||/[\x00-\x20\x7f]/.test(value)||!/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(value))fail('INVALID_GITHUB_URL');
 const parts=value.replace(/\/$/,'').slice('https://github.com/'.length).split('/'),owner=parts[0],repo=parts[1].replace(/\.git$/,'');
 if(!repo||repo==='.'||repo==='..'||repo.length>100||owner.endsWith('-')||owner.includes('--'))fail('INVALID_GITHUB_URL');
 return `https://github.com/${owner}/${repo}.git`;
}
const environment=()=>gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1',GIT_ALLOW_PROTOCOL:'https'});
const prefix=['--no-pager','--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.autocrlf=false','-c','core.pager=cat','-c','credential.helper=','-c','credential.interactive=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','http.followRedirects=false','-c','http.sslVerify=true','-c','submodule.recurse=false'];

/** A new, unpublished physical directory only. The optional acquire callback is
 * an internal test transport; callers across IPC cannot select it or credentials.
 * No checkout runs: validated Git blobs are materialized without attributes,
 * filters, hooks, symlinks or code from the downloaded repository. */
export async function cloneGitHubRepository({sourceRoot,url,signal,credential,onProgress=()=>{},acquire}={}){
 const source=pinDirectory(sourceRoot),sourceUrl=canonicalGitHubUrl(url);let gitPin=null;
 if(fs.readdirSync(source.path).length)fail('DIRECTORY_NOT_EMPTY');
 for(let parent=path.dirname(source.path);;){if(fs.existsSync(path.join(parent,'.git')))fail('NESTED_REPOSITORY');const next=path.dirname(parent);if(next===parent)break;parent=next;}
 if(credential!==undefined&&(!credential||typeof credential.token!=='string'||credential.token.length<1||credential.token.length>4096||/[\x00-\x20\x7f]/.test(credential.token)))fail('INVALID_CREDENTIAL');
 const executable=fs.statSync(gitExecutable()),deadline=Date.now()+GITHUB_CLONE_LIMITS.timeoutMs;
 const check=()=>{checkDirectory(source);if(gitPin)checkDirectory(gitPin);if(signal?.aborted)fail('CLONE_CANCELLED');if(Date.now()>deadline)fail('CLONE_TIMEOUT');const current=fs.statSync(gitExecutable());if(current.ino!==executable.ino||current.dev!==executable.dev)fail('GIT_EXECUTABLE_CHANGED');};
 function run(args,{network=false,output,allow=[0]}={}){
  check();const env={...environment(),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})};if(!network)env.GIT_ALLOW_PROTOCOL='';
  if(network&&credential){env.GIT_CONFIG_COUNT='1';env.GIT_CONFIG_KEY_0=`http.${sourceUrl}.extraHeader`;env.GIT_CONFIG_VALUE_0=`Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString('base64')}`;}
  let stdout=[],length=0,stderr='',reason=null,child,lastActivity=Date.now();
  const completion=new Promise((resolve,reject)=>{
   child=spawn(gitExecutable(),[...prefix,...(!network?['-c','protocol.allow=never','-c','protocol.https.allow=never']:[]),...args],{cwd:source.path,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
   const stop=code=>{if(reason)return;reason=code;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
   const abort=()=>stop('CLONE_CANCELLED'),timeout=setTimeout(()=>stop('CLONE_TIMEOUT'),Math.max(1,deadline-Date.now()));
   const stall=setInterval(()=>{if(Date.now()-lastActivity>GITHUB_CLONE_LIMITS.stallMs)stop('CLONE_STALLED');if(network)try{diskRequired(0);let entries=0,bytes=0;const walk=dir=>{for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),stat=fs.lstatSync(p);if(++entries>GITHUB_CLONE_LIMITS.metadataEntries)fail('CLONE_LIMIT_EXCEEDED');if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())fail('UNSAFE_GIT_METADATA');if(stat.isDirectory())walk(p);else bytes+=stat.size;if(bytes>GITHUB_CLONE_LIMITS.bytes)fail('CLONE_LIMIT_EXCEEDED');}};const dir=path.join(source.path,'.git');if(fs.existsSync(dir))walk(dir);}catch(e){stop(e.code??'CLONE_FAILED');}},2000);
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   if(!output)child.stdout.on('data',bytes=>{lastActivity=Date.now();length+=bytes.length;if(length>MAX_OUTPUT)stop('CLONE_LIMIT_EXCEEDED');else stdout.push(bytes);});
   child.stderr.on('data',bytes=>{lastActivity=Date.now();stderr=(stderr+bytes.toString('utf8')).slice(-8192);if(network){const match=/(?:Receiving objects|Resolving deltas):\s*(\d+)%.*?\((\d+)\/(\d+)\)/g;for(const m of stderr.matchAll(match))onProgress({phase:'receiving',percent:Number(m[1]),completedObjects:Number(m[2]),totalObjects:Number(m[3])});}});
   child.on('error',()=>{reason??='GIT_UNAVAILABLE';});
   child.on('close',code=>{clearTimeout(timeout);clearInterval(stall);signal?.removeEventListener('abort',abort);if(reason||!allow.includes(code)){const failure=reason??cloneFailureCode(stderr);reject(Object.assign(new Error(failure),{code:failure}));return;}try{check();resolve(Buffer.concat(stdout));}catch(error){reject(error);}});
  });
  if(!output)return completion;
  const transfer=pipeline(child.stdout,output).catch(error=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}throw error;});
  return Promise.allSettled([completion,transfer]).then(results=>{const failure=results.find(value=>value.status==='rejected');if(failure)throw failure.reason;return results[0].value;});
 }
 const diskRequired=bytes=>{const stat=fs.statfsSync(source.path);if(Number(stat.bavail)*Number(stat.bsize)<bytes+GITHUB_CLONE_LIMITS.reserveBytes)fail('CLONE_DISK_SPACE');};
 onProgress({phase:'connecting'});check();diskRequired(0);
 if(acquire)await acquire({destination:source.path,sourceUrl,signal});
 else{onProgress({phase:'receiving'});await run(['clone','--progress','--no-checkout','--no-hardlinks','--no-local','--template=','--origin','origin','--',sourceUrl,source.path],{network:true});}
 credential=undefined;check();onProgress({phase:'checking'});
 const gitPath=path.join(source.path,'.git'),git=pinDirectory(gitPath);gitPin=git;let metadataEntries=0,metadataBytes=0;
 function metadataWalk(directory){for(const name of fs.readdirSync(directory)){const filename=path.join(directory,name),stat=fs.lstatSync(filename);if(++metadataEntries>GITHUB_CLONE_LIMITS.metadataEntries)fail('CLONE_LIMIT_EXCEEDED');if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))fail('UNSAFE_GIT_METADATA');if(stat.isDirectory())metadataWalk(filename);else{metadataBytes+=stat.size;if(metadataBytes>GITHUB_CLONE_LIMITS.bytes)fail('CLONE_LIMIT_EXCEEDED');}}}
 metadataWalk(gitPath);
 for(const name of ['commondir','objects/info/alternates','objects/info/http-alternates','shallow'])if(fs.existsSync(path.join(gitPath,name)))fail('UNSUPPORTED_GIT_DIRECTORY');
 // Clone creates config itself, but replace it with only the values this local
 // product understands. Retain provenance; network use still needs its own API.
 const config=`[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tautocrlf = false\n[remote "origin"]\n\turl = ${sourceUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
 const configPath=path.join(gitPath,'config'),fd=fs.openSync(configPath,fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW);try{fs.writeFileSync(fd,config);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const gitArgs=args=>[`--git-dir=${gitPath}`,`--work-tree=${source.path}`,...args];
 const string=async(args,options)=>(await run(gitArgs(args),options)).toString('utf8').trim();
 const head=(await string(['rev-parse','--verify','HEAD'],{allow:[0,128]}))||null,branchRef=await string(['symbolic-ref','HEAD']);
 if(head!==null&&!/^[a-f0-9]{40}$/.test(head)||!branchRef.startsWith('refs/heads/'))fail('CLONE_EMPTY_OR_UNSUPPORTED');
 if(head===null&&(await string(['for-each-ref','--format=%(refname)'])))fail('CLONE_EMPTY_OR_UNSUPPORTED');
 const branch=branchRef.slice(11);
 const refText=await string(['for-each-ref','--format=%(objectname) %(refname) %(symref)','refs/remotes/origin/']);
 for(const line of refText.split('\n').filter(Boolean)){const [sha,ref,symbolic]=line.split(' ');if(symbolic)continue;if(!/^[a-f0-9]{40}$/.test(sha)||!ref.startsWith('refs/remotes/origin/'))fail('CLONE_FAILED');const local=`refs/heads/${ref.slice('refs/remotes/origin/'.length)}`;if(local!==branchRef)await run(gitArgs(['update-ref',local,sha,'0'.repeat(40)]));}
 const treeBytes=head?await run(gitArgs(['ls-tree','-rlz','--full-tree',head])):Buffer.alloc(0);let tree;
 try{tree=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(treeBytes).split('\0').filter(Boolean);}catch{fail('CLONE_UNSUPPORTED_ENTRY');}
 if(tree.length>GITHUB_CLONE_LIMITS.files)fail('CLONE_LIMIT_EXCEEDED');
 const names=new Map(),entries=[];
 for(const row of tree){const tab=row.indexOf('\t'),[mode,type,sha,sizeText]=row.slice(0,tab).trim().split(/\s+/),name=row.slice(tab+1),parts=name.split('/');
  if(tab<0||type!=='blob'||!['100644','100755'].includes(mode)||!/^[a-f0-9]{40}$/.test(sha)||!isPortableRelativePath(name)||!name.isWellFormed()||parts.length>32||parts.some(part=>Buffer.byteLength(part)>255||part.toLowerCase()==='.asmagicbrain'||part.toLowerCase().startsWith('.asmb-')))fail('CLONE_UNSUPPORTED_ENTRY');
  let spelling='';for(let index=0;index<parts.length;index++){spelling+=(index?'/':'')+parts[index];const kind=index===parts.length-1?'file':'directory',key=portablePathKey(spelling),prior=names.get(key);if(prior&&(prior.spelling!==spelling||prior.kind!==kind||kind==='file'))fail('CLONE_UNSUPPORTED_ENTRY');names.set(key,{spelling,kind});}
  const size=Number(sizeText);if(!Number.isSafeInteger(size)||size<0)fail('CLONE_UNSUPPORTED_ENTRY');entries.push({name,mode,sha,size});
 }
 const expectedBytes=entries.reduce((n,e)=>n+e.size,0);if(expectedBytes>GITHUB_CLONE_LIMITS.bytes)fail('CLONE_LIMIT_EXCEEDED');diskRequired(expectedBytes);
 let bytes=0,completedFiles=0;
 // One binary cat-file process streams raw object bytes; attributes, filters and
 // hooks never participate. This avoids thousands of per-file subprocesses.
 const batch=spawn(gitExecutable(),[...prefix,'-c','protocol.allow=never','-c','protocol.https.allow=never',...gitArgs(['cat-file','--batch'])],{cwd:source.path,env:environment(),stdio:['pipe','pipe','pipe']});
 let batchReason=null,lastBatchActivity=Date.now();const abortBatch=()=>{batchReason='CLONE_CANCELLED';batch.kill('SIGKILL');};signal?.addEventListener('abort',abortBatch,{once:true});
 const done=new Promise((resolve,reject)=>{batch.once('error',()=>reject(Object.assign(Error('GIT_UNAVAILABLE'),{code:'GIT_UNAVAILABLE'})));batch.once('close',code=>code===0?resolve():reject(Object.assign(Error(batchReason??'CLONE_FAILED'),{code:batchReason??'CLONE_FAILED'})));});void done.catch(()=>{});batch.stderr.resume();batch.stdin.on('error',()=>{});
 const iterator=batch.stdout[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
 async function fill(){check();const next=await iterator.next();if(next.done)fail(batchReason??'CLONE_FAILED');pending=next.value;lastBatchActivity=Date.now();}
 async function line(){const parts=[];let length=0;for(;;){if(!pending.length)await fill();const at=pending.indexOf(10);if(at>=0){parts.push(pending.subarray(0,at));pending=pending.subarray(at+1);return Buffer.concat(parts).toString('ascii');}parts.push(pending);length+=pending.length;if(length>1024)fail('CLONE_FAILED');pending=Buffer.alloc(0);}}
 const timer=setInterval(()=>{try{check();diskRequired(0);if(Date.now()-lastBatchActivity>GITHUB_CLONE_LIMITS.stallMs)fail('CLONE_STALLED');}catch(e){batchReason=e.code;batch.kill('SIGKILL');}},1000);
 try{for(const entry of entries){check();batch.stdin.write(entry.sha+'\n');const header=await line();if(header!==`${entry.sha} blob ${entry.size}`)fail('CLONE_FAILED');const filename=path.join(source.path,entry.name);fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,entry.mode==='100755'?0o755:0o644);
   try{let remaining=entry.size;while(remaining){if(!pending.length)await fill();const chunk=pending.subarray(0,Math.min(pending.length,remaining));let at=0;while(at<chunk.length)at+=fs.writeSync(fd,chunk,at,chunk.length-at);pending=pending.subarray(chunk.length);remaining-=chunk.length;bytes+=chunk.length;if(bytes%(16*1024*1024)<chunk.length)await yieldTurn();if(signal?.aborted)fail('CLONE_CANCELLED');if(bytes%(8*1024*1024)<chunk.length)check();onProgress({phase:'checking',checkedBytes:bytes,totalBytes:expectedBytes,completedFiles,files:entries.length});}if(await line()!=='')fail('CLONE_FAILED');fs.fchmodSync(fd,entry.mode==='100755'?0o755:0o644);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}completedFiles++;}
  batch.stdin.end();await done;
 }catch(error){batch.kill('SIGKILL');batch.stdout.destroy();batch.stdin.destroy();batch.stderr.destroy();await done.catch(()=>{});if(error.code==='ENOSPC')fail('CLONE_DISK_SPACE');throw error;}finally{clearInterval(timer);signal?.removeEventListener('abort',abortBatch);}

 await run(gitArgs(head?['read-tree',head]:['read-tree','--empty']));checkDirectory(git);
 const syncTree=directory=>{const pin=pinDirectory(directory);for(const name of fs.readdirSync(directory)){const filename=path.join(directory,name),stat=fs.lstatSync(filename);if(stat.isDirectory())syncTree(filename);else{if(!stat.isFile()||stat.nlink!==1)fail('UNSAFE_GIT_METADATA');const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}checkDirectory(pin);const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 syncTree(source.path);check();return {head,branch,files:entries.length,bytes,sourceUrl};
}
