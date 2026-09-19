import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocalRepository, localRepositoryResponse } from './local-repositories.mjs';
test('local browser reads directories and text but denies traversal and symlinks',async()=>{
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'repository-view-')));
 try {
  const root=path.join(base,'Workspace');await mkdir(root);await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'README.md'),'# Local');await writeFile(path.join(root,'docs','note.md'),'Nested note');
  await writeFile(path.join(root,'binary'),Buffer.from([0,1,2]));await symlink(os.tmpdir(),path.join(root,'outside'));
  const result=await readLocalRepository('Workspace','',base);
  assert.equal(result.type,'directory');assert.equal(result.readmePath,'README.md');assert.equal(result.licensePath,null);assert.equal(result.readme,'# Local');assert.equal(result.commit,null);assert.equal(result.entries[0].name,'docs');assert(!result.entries.some(e=>e.name==='outside'));
  assert.equal((await readLocalRepository('Workspace','docs/note.md',base)).content,'Nested note');
  const binary=await readLocalRepository('Workspace','binary',base);assert.equal(binary.content,null);assert.equal(binary.type,'file');assert.equal(binary.readmePath,null);
  for(const relative of ['../README.md','/etc/passwd','.git/config','docs/../../x','outside/a','docs\\x'])await assert.rejects(readLocalRepository('Workspace',relative,base));
  await assert.rejects(readLocalRepository('Unknown','',base));
 }finally{await rm(base,{recursive:true,force:true});}
});
test('local endpoint rejects writes and foreign origins before reading',async()=>{
 for(const format of ['', '?format=raw', '?format=download'])for(const [headers,method,status] of [[{host:'127.0.0.1:6006'},'POST',405],[{host:'evil.example'},'GET',403],[{host:'127.0.0.1:6006',origin:'https://evil.example'},'GET',403],[{host:'127.0.0.1:6006','sec-fetch-site':'cross-site'},'GET',403]]){
  let observed;await localRepositoryResponse({headers,method,url:`/__local-repositories${format}`},{writeHead:s=>observed=s,end:()=>{}});assert.equal(observed,status);
 }
});
async function responseFor(base,params){
 const result={};
 await localRepositoryResponse({method:'GET',headers:{host:'127.0.0.1:6006'},url:`/__local-repositories?${new URLSearchParams(params)}`},{writeHead:(status,headers)=>Object.assign(result,{status,headers}),end:body=>{result.body=body;}},6006,base);
 return result;
}
test('raw and download formats return only admitted text with inert headers and safe filenames',async()=>{
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'repository-raw-'))),root=path.join(base,'Workspace');await mkdir(root);
 try{
  const name='notes "résumé";\r\nX-Injected: yes.md',content='\ufeff<script>alert("inert")</script>\r\n\n# 文本\n';
  await writeFile(path.join(root,name),content);await writeFile(path.join(root,'empty.md'),'');
  await writeFile(path.join(root,'binary'),Buffer.from([0,1,2]));await writeFile(path.join(root,'large.md'),'x'.repeat(1024*1024+1));await writeFile(path.join(root,'invalid.txt'),Buffer.from([0xff]));
  await symlink(path.join(root,name),path.join(root,'linked'));await mkdir(path.join(root,'directory'));
  for(const format of ['raw','download']){
   const response=await responseFor(base,{repo:'Workspace',path:name,format});
   assert.equal(response.status,200);assert.equal(response.body,content);assert.deepEqual(Buffer.from(response.body,'utf8'),Buffer.from(content,'utf8'));assert.equal(response.headers['Content-Type'],'text/plain; charset=utf-8');assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.headers['X-Content-Type-Options'],'nosniff');assert.equal(response.headers['Content-Security-Policy'],"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
   if(format==='download'){
    const disposition=response.headers['Content-Disposition'];assert.match(disposition,/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);assert(!/[\r\n]/.test(disposition));assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]),name);
   }else assert.equal(response.headers['Content-Disposition'],undefined);
   const empty=await responseFor(base,{repo:'Workspace',path:'empty.md',format});assert.equal(empty.status,200);assert.equal(empty.body,'');
   for(const relative of ['','directory','binary','large.md','invalid.txt','linked','missing.md','../outside','.git/config','directory\\file'])assert.equal((await responseFor(base,{repo:'Workspace',path:relative,format})).status,404);
   assert.equal((await responseFor(base,{repo:'Unknown',path:name,format})).status,404);
  }
  const json=await responseFor(base,{repo:'Workspace',path:name});assert.equal(json.status,200);assert.equal(JSON.parse(json.body).content,content);assert.equal(json.headers['Content-Type'],'application/json; charset=utf-8');
  for(const format of ['','html','json','RAW'])assert.equal((await responseFor(base,{repo:'Workspace',path:name,format})).status,400);
  assert.equal((await responseFor(base,[['repo','Workspace'],['path',name],['format','raw'],['format','download']])).status,400);
 }finally{await rm(base,{recursive:true,force:true});}
});
test('branch and annotated tag browsing uses Git objects without changing checkout',async()=>{
 const {execFileSync}=await import('node:child_process');
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'repository-ref-'))),root=path.join(base,'Workspace');await mkdir(root);
 const run=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 try{
  run('init','-b','main');run('config','user.name','Fixture');run('config','user.email','fixture@example.test');
  const bomBytes=Buffer.from('\ufeff# BOM 文本\r\n','utf8');
  await writeFile(path.join(root,'README.md'),'# First\n\n');await writeFile(path.join(root,'bom.md'),bomBytes);run('add','.');run('commit','-m','First');run('tag','-a','v1','-m','Release one');
  run('checkout','-b','alternate');await writeFile(path.join(root,'README.md'),'# Alternate\n');await writeFile(path.join(root,'branch-only.md'),'Only on alternate\n');await symlink('README.md',path.join(root,'linked'));run('add','.');run('commit','-m','Alternate');run('checkout','main');
  await writeFile(path.join(root,'README.md'),'Local uncommitted\n');
  const before=run('status','--porcelain');
  const tag=await readLocalRepository('Workspace','',base,'refs/tags/v1');assert.equal(tag.readme,'# First\n\n');assert.equal(tag.revisionKind,'tag');assert.equal(tag.readmePath,'README.md');
  assert.equal((await readLocalRepository('Workspace','README.md',base,'refs/tags/v1')).content,'# First\n\n');
  assert.equal((await readLocalRepository('Workspace','branch-only.md',base,'refs/heads/alternate')).content,'Only on alternate\n');
  await assert.rejects(readLocalRepository('Workspace','branch-only.md',base,'refs/tags/v1'));
  await assert.rejects(readLocalRepository('Workspace','branch-only.md',base));
  const branch=await readLocalRepository('Workspace','README.md',base,'refs/heads/alternate');assert.equal(branch.content,'# Alternate\n');assert.equal(branch.commitCount,2);assert.equal(branch.branch,'main');
  for(const format of ['raw','download']){
   const response=await responseFor(base,{repo:'Workspace',path:'README.md',ref:'refs/tags/v1',format});assert.equal(response.status,200);assert.equal(response.body,'# First\n\n');
   const bom=await responseFor(base,{repo:'Workspace',path:'bom.md',ref:'refs/tags/v1',format});assert.equal(bom.status,200);assert.deepEqual(Buffer.from(bom.body,'utf8'),bomBytes);
   assert.equal((await responseFor(base,{repo:'Workspace',path:'branch-only.md',ref:'refs/tags/v1',format})).status,404);
   assert.equal((await responseFor(base,{repo:'Workspace',path:'README.md',ref:'refs/heads/missing',format})).status,404);
  }
  await assert.rejects(readLocalRepository('Workspace','linked',base,'refs/heads/alternate'));
  for(const ref of ['alternate','HEAD','refs/heads/missing','refs/tags/v1^{commit}','--all'])await assert.rejects(readLocalRepository('Workspace','',base,ref));
  await assert.rejects(readLocalRepository('Workspace','../README.md',base,'refs/tags/v1'));
  assert.equal(run('symbolic-ref','--short','HEAD'),'main');assert.equal(run('status','--porcelain'),before);assert.equal((await readLocalRepository('Workspace','README.md',base)).content,'Local uncommitted\n');
 }finally{await rm(base,{recursive:true,force:true});}
});

async function repositoryHistory(t) {
 const {execFileSync}=await import('node:child_process');
 const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'repository-path-history-'))),root=path.join(base,'Workspace');
 t.after(()=>rm(base,{recursive:true,force:true}));await mkdir(root);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const run=(...args)=>execFileSync('git',['--no-pager','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();
 run('init','-b','main');run('config','user.name','Path Fixture');run('config','user.email','path-fixture@example.test');
 const write=async(relative,content)=>{await mkdir(path.dirname(path.join(root,relative)),{recursive:true});await writeFile(path.join(root,relative),content);};
 const commit=async(files,message)=>{for(const [relative,content] of Object.entries(files))await write(relative,content);run('add','--all');run('commit','-m',message);return run('rev-parse','--short','HEAD');};
 const read=(relative='',revision='')=>readLocalRepository('Workspace',relative,base,revision);
 return {base,root,run,write,commit,read};
}

test('nested worktree snapshots show path history and the selected folder README without changing files',async t=>{
 const {root,run,write,commit,read}=await repositoryHistory(t);
 const first=await commit({'README.md':'# Root\n','docs/README.md':'# Docs\n','docs/guides/README.md':'# Guides\n','docs/guides/topic.md':'First topic\n','docs-other/README.md':'# Other\n','docs/[draft].md':'Literal name\n'},'Initial folders');
 const nested=await commit({'docs/guides/topic.md':'Updated topic\n'},'Update nested topic');
 const tip=await commit({'README.md':'# Current root\n','docs-other/README.md':'# Unrelated update\n','docs/d.md':'Different literal name\n'},'Update outside guides');
 const workingReadme='\ufeff# Local guide draft\r\n';await write('docs/guides/README.md',workingReadme);
 await write('new-folder/README.md','# Untracked folder\n');
 const before=run('status','--porcelain'),head=run('rev-parse','HEAD');
 const rootView=await read(),docs=await read('docs'),guides=await read('docs/guides');
 assert.equal(rootView.commit.sha,tip);assert.equal(rootView.commitCount,3);assert.equal(rootView.readmePath,'README.md');assert.equal(rootView.readme,'# Current root\n');
 assert.equal(docs.commit.sha,tip);assert.equal(docs.readmePath,'docs/README.md');assert.equal(docs.readme,'# Docs\n');
 assert.equal(guides.type,'directory');assert.equal(guides.commit.sha,nested);assert.equal(guides.commit.message,'Update nested topic');assert.equal(guides.commitCount,3);
 assert.equal(guides.readmePath,'docs/guides/README.md');assert.equal(guides.readme,workingReadme);assert.equal(guides.licensePath,null);assert.equal(guides.content,null);
 assert.deepEqual(guides.entries.map(entry=>[entry.path,entry.message]),[['docs/guides/README.md','Initial folders'],['docs/guides/topic.md','Update nested topic']]);
 assert.equal(docs.entries.find(entry=>entry.path==='docs/guides').message,'Update nested topic');
 const readme=await read('docs/guides/README.md'),topic=await read('docs/guides/topic.md');
 assert.equal(readme.commit.sha,first);assert.equal(readme.content,workingReadme);assert.equal(topic.commit.sha,nested);assert.equal(topic.content,'Updated topic\n');
 assert.equal((await read('docs/[draft].md')).commit.sha,first);
 const untracked=await read('new-folder');assert.equal(untracked.commit,null);assert.equal(untracked.readmePath,'new-folder/README.md');assert.equal(untracked.readme,'# Untracked folder\n');
 assert.equal((await read('new-folder/README.md')).commit,null);
 assert.equal(run('rev-parse','HEAD'),head);assert.equal(run('status','--porcelain'),before);assert.equal(await readFile(path.join(root,'docs/guides/README.md'),'utf8'),workingReadme);
});

test('nested historical folder and file metadata stay scoped to their selected branch or annotated tag',async t=>{
 const {root,run,write,commit,read}=await repositoryHistory(t);
 const first=await commit({'README.md':'# Original root\n','docs/nested/README.md':'# Nested readme\n','docs/nested/topic.md':'Original topic\n'},'Original tree');
 run('tag','-a','v1','-m','Original release');
 const mainNested=await commit({'docs/nested/topic.md':'Main topic\n'},'Main nested change');
 const mainTip=await commit({'README.md':'# Main root\n'},'Main root change');
 run('checkout','-b','alternate','refs/tags/v1');
 const alternateNested=await commit({'docs/nested/topic.md':'Alternate topic\n'},'Alternate nested change');
 const alternateTip=await commit({'README.md':'# Alternate root\n'},'Alternate root change');
 run('tag','-a','alternate-v2','-m','Alternate release');run('checkout','main');
 const workingReadme='# Current unsaved README\n';await write('docs/nested/README.md',workingReadme);
 const before=run('status','--porcelain'),head=run('rev-parse','HEAD');
 for(const [ref,tip,nested,content,count] of [
  ['refs/heads/main',mainTip,mainNested,'Main topic\n',3],
  ['refs/heads/alternate',alternateTip,alternateNested,'Alternate topic\n',3],
  ['refs/tags/alternate-v2',alternateTip,alternateNested,'Alternate topic\n',3],
  ['refs/tags/v1',first,first,'Original topic\n',1],
 ]){
  const rootView=await read('',ref),folder=await read('docs/nested',ref),file=await read('docs/nested/topic.md',ref);
  assert.equal(rootView.commit.sha,tip);assert.equal(rootView.commitCount,count);
  assert.equal(folder.type,'directory');assert.equal(folder.selectedRef,ref);assert.equal(folder.branch,'main');assert.equal(folder.commit.sha,nested);assert.equal(folder.commitCount,count);
  assert.equal(folder.readmePath,'docs/nested/README.md');assert.equal(folder.readme,'# Nested readme\n');assert.equal(folder.content,null);
  assert.deepEqual(folder.entries.map(entry=>entry.path),['docs/nested/README.md','docs/nested/topic.md']);
  assert.equal(file.type,'file');assert.equal(file.commit.sha,nested);assert.equal(file.content,content);
  assert.equal((await read('docs/nested/README.md',ref)).commit.sha,first);
 }
 assert.equal(run('symbolic-ref','--short','HEAD'),'main');assert.equal(run('rev-parse','HEAD'),head);assert.equal(run('status','--porcelain'),before);assert.equal(await readFile(path.join(root,'docs/nested/README.md'),'utf8'),workingReadme);
});
