import {gitExecutable, gitEnvironment} from '../git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {pinDirectory,checkDirectory} from '../physical-roots.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Initialize only an unpublished, empty host-owned directory. No templates,
 * user configuration, author, initial commit, hooks or remote are inherited. */
export async function initializeEmptyRepository(sourceRoot){
 const source=pinDirectory(sourceRoot);
 if(fs.readdirSync(source.path).length)fail('DIRECTORY_NOT_EMPTY');
 for(let parent=path.dirname(source.path);;){
  if(fs.existsSync(path.join(parent,'.git')))fail('NESTED_REPOSITORY');
  const next=path.dirname(parent);if(next===parent)break;parent=next;
 }
 const gitPath=path.join(source.path,'.git');fs.mkdirSync(gitPath,{mode:0o700});const git=pinDirectory(gitPath);
 await new Promise((resolve,reject)=>{
  execFile(gitExecutable(),['--no-pager','--no-replace-objects','-c','credential.helper=','-c','credential.interactive=false','-c','core.hooksPath=/dev/null','-c','protocol.allow=never',
   `--git-dir=${gitPath}`,`--work-tree=${source.path}`,'init','--initial-branch=main','--object-format=sha1','--template=',source.path],
  {cwd:source.path,env:gitEnvironment({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
   GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'0',GIT_ALLOW_PROTOCOL:'',GIT_NO_LAZY_FETCH:'1'}),timeout:30000,maxBuffer:65536},
  error=>error?reject(Object.assign(new Error(error.killed?'GIT_TIMEOUT':'GIT_FAILED'),{code:error.killed?'GIT_TIMEOUT':'GIT_FAILED'})):resolve());
 });
 checkDirectory(source);checkDirectory(git);
 if(fs.readFileSync(path.join(gitPath,'HEAD'),'utf8')!=='ref: refs/heads/main\n')fail('GIT_FAILED');
 function syncTree(directory){
  const pin=pinDirectory(directory);
  for(const name of fs.readdirSync(directory)){
   const filename=path.join(directory,name),stat=fs.lstatSync(filename);
   if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))fail('UNSAFE_GIT_METADATA');
   if(stat.isDirectory())syncTree(filename);
   else{const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  }
  checkDirectory(pin);const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 syncTree(source.path);checkDirectory(source);checkDirectory(git);
 return {head:null,branch:'main'};
}
