import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pinDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';
import {createRepositorySearch,SEARCH_LIMITS} from './repository-search.mjs';
import {createNativeService} from './host-service.mjs';
import {runWithStorageIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
const id='search-fixture';
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'search-'));const repository=path.join(root,'repo');fs.mkdirSync(repository);
 const pin=pinDirectory(repository);const search=createRepositorySearch({admit:async repo=>{if(repo!==null&&repo!=='repo')throw Error('Unknown');return [{repo:'repo',pin}];},...options});
 t.after(async()=>{await search.close();fs.rmSync(root,{recursive:true,force:true});});
 const write=(name,text)=>{const p=path.join(repository,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
 return {root,repository,search,write};
}
const query=(search,query,rest={})=>search.searchRepositoryText({requestId:id,repo:'repo',query,caseSensitive:false,...rest});
test('search caller carries the mapped admitted root into its fixed worker',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mapped-search-')),source=path.join(root,'source');
 fs.mkdirSync(source,{mode:0o700});fs.writeFileSync(path.join(source,'note.md'),'saved');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stat=fs.lstatSync(root,{bigint:true}),context={schemaVersion:1,root,rootInode:String(stat.ino),owner:Number(stat.uid),currentDevice:Number(stat.dev),namespaceDevice:Number(stat.dev)+71,volumeId:'fixture-volume'};
 await runWithStorageIdentity(context,async()=>{
  const search=createRepositorySearch({admit:async()=>[{repo:'Fixture',pin:pinDirectory(source)}]});
  try{assert.deepEqual((await search.listRepositoryFiles({requestId:'mapped-search',repo:'Fixture'})).paths,['note.md']);}
  finally{await search.close();}
 });
});
test('literal saved search uses bundled rg, Unicode UTF16 columns, CRLF and ignored/private exclusions',async t=>{
 const f=fixture(t);f.write('note.md','first\r\n😀 Ω a.b A.B\r\n');f.write('ignored.md','a.b');f.write('nested/.gitignore','skip.md\n');f.write('nested/skip.md','a.b');f.write('nested/keep.md','a.b');f.write('.gitignore','ignored.md\n');f.write('.github/config.txt','a.b');f.write('.asmb-secret/data','a.b');f.write('.git/config','a.b');
 const value=await query(f.search,'a.b');assert.deepEqual(value.matches.map(x=>[x.path,x.line,x.column,x.endColumn]),[['.github/config.txt',1,1,4],['nested/keep.md',1,1,4],['note.md',2,6,9],['note.md',2,10,13]]);assert.equal(value.matches.at(-1).lineText,'😀 Ω a.b A.B');
 assert.equal((await query(f.search,'a.b',{caseSensitive:true})).matches.length,3);
 const paths=await f.search.listRepositoryFiles({requestId:id,repo:'repo'});assert(paths.paths.includes('.gitignore'));assert(paths.paths.includes('.github/config.txt'));assert(paths.paths.includes('ignored.md'));assert(!paths.paths.some(p=>p.startsWith('.git/')||p.startsWith('.asmb')));
});
test('binary/link/special entries never expose outside content; file inventory still includes binary',async t=>{
 const f=fixture(t);f.write('binary',Buffer.from('target\0target'));f.write('normal','target');fs.writeFileSync(path.join(f.root,'outside'),'target PRIVATE');fs.symlinkSync(path.join(f.root,'outside'),path.join(f.repository,'link'));fs.symlinkSync(f.root,path.join(f.repository,'dirlink'));
 const result=await query(f.search,'target');assert.deepEqual(result.matches.map(x=>x.path),['normal']);const inventory=await f.search.listRepositoryFiles({requestId:id,repo:'repo'});assert.deepEqual(inventory.paths,['binary','normal']);
});
test('invalid input never admits roots; cancellation closes queued search and resumes after prepareClose',async t=>{
 let admits=0,resolve;const f=fixture(t);const search=createRepositorySearch({admit:()=>{admits++;return new Promise(r=>resolve=r);}});t.after(()=>search.close());
 for(const request of [{requestId:id,repo:'repo',query:'x',caseSensitive:false,root:'/tmp'},{requestId:id,repo:null,query:'x',caseSensitive:false,path:'a'},{requestId:id,repo:'repo',query:'\n',caseSensitive:false},{requestId:id,repo:'repo',query:'x',caseSensitive:false,path:'../private'}])await assert.rejects(search.searchRepositoryText(request),{code:'SEARCH_INVALID_REQUEST'});
 assert.equal(admits,0);const running=query(search,'x');const cancellation=search.cancelRepositorySearch({requestId:id});resolve([{repo:'repo',pin:pinDirectory(f.repository)}]);await assert.rejects(running,{code:'SEARCH_CANCELLED'});await cancellation;
 await f.search.prepareClose();await assert.rejects(query(f.search,'x'),{code:'SERVICE_CLOSED'});f.search.resume();assert.equal((await query(f.search,'x')).matches.length,0);
});
test('result, inventory and byte budgets are explicit; filename/argument-like literal patterns remain data',async t=>{
 const f=fixture(t,{limits:{...SEARCH_LIMITS,matches:2,files:5}});f.write('-dash.md','--foo --foo --foo\n');
 const result=await query(f.search,'--foo');assert.equal(result.matches.length,2);assert.equal(result.truncated,true);assert.equal(result.reason,'limit');
 for(let i=0;i<8;i++)f.write('files/'+i,'x');const listing=await f.search.listRepositoryFiles({requestId:id,repo:'repo'});assert.equal(listing.paths.length,5);assert.equal(listing.truncated,true);
});
test('historical inventory pins local commit and ignores worktree-only paths and symlink blobs',async t=>{
 const f=fixture(t);f.write('old.md','old');const git=(...args)=>execFileSync('/usr/bin/git',['-C',f.repository,...args],{env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();git('init','-b','main');git('add','old.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture');git('tag','one');f.write('new.md','new');
 const result=await f.search.listRepositoryFiles({requestId:id,repo:'repo',ref:'refs/tags/one'});assert.deepEqual(result.paths,['old.md']);assert.equal(result.commit,git('rev-parse','HEAD'));await assert.rejects(f.search.listRepositoryFiles({requestId:id,repo:'repo',ref:'--upload-pack=outside'}),{code:'SEARCH_INVALID_REQUEST'});
});
test('host service admits only catalog roots and all-repository scope stays outside private drafts',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'search-host-'));const service=await createNativeService({dataRoot:path.join(root,'data')});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 await service.request({repo:'Workspace',operation:'create',args:{path:'saved.md',text:'saved phrase'}});const opened=await service.request({repo:'Workspace',operation:'open',args:{path:'saved.md'}});await service.request({repo:'Workspace',operation:'checkpoint',args:{path:'saved.md',baseHash:opened.sourceHash,text:'private-only phrase'}});
 const result=await service.searchRepositoryText({requestId:id,repo:null,query:'phrase',caseSensitive:false});assert.deepEqual(result.matches.map(x=>x.lineText),['saved phrase']);await assert.rejects(service.listRepositoryFiles({requestId:id,repo:'../outside'}),{code:'UNKNOWN_REPOSITORY'});
});
test('active cancellation drains worker; timeout and oversized saved files report incomplete results',async t=>{
 const f=fixture(t);for(let i=0;i<500;i++)f.write('many/'+String(i).padStart(4,'0')+'.txt','x'.repeat(4096));
 const running=query(f.search,'x');await new Promise(resolve=>setTimeout(resolve,20));const cancellation=f.search.cancelRepositorySearch({requestId:id});await assert.rejects(running,{code:'SEARCH_CANCELLED'});await cancellation;
 const limited=fixture(t,{limits:{...SEARCH_LIMITS,timeMs:0}});limited.write('a','target');const result=await query(limited.search,'target');assert.equal(result.truncated,true);assert.equal(result.reason,'timeout');
 const large=fixture(t,{limits:{...SEARCH_LIMITS,fileBytes:10}});large.write('a-large','123456789012345');large.write('z-small','target');const partial=await query(large.search,'target');assert.equal(partial.skippedFiles,1);assert.equal(partial.truncated,true);assert.equal(partial.matches[0].path,'z-small');
});
test('batched descriptor search handles a thousand saved files within the configured budget',async t=>{
 const f=fixture(t);for(let i=0;i<1000;i++)f.write('notes/'+String(i).padStart(4,'0')+'.txt','Ordinary text without the needle.\n');f.write('notes/last.md','unique-needle');
 const result=await query(f.search,'unique-needle');assert.equal(result.truncated,false);assert.equal(result.searchedFiles,1001);assert.deepEqual(result.matches.map(x=>x.path),['notes/last.md']);
});
test('a replaced admitted root is rejected before a worker may scan its replacement',async t=>{
 const f=fixture(t);f.write('safe.txt','safe');fs.renameSync(f.repository,f.repository+'-old');fs.mkdirSync(f.repository);fs.writeFileSync(path.join(f.repository,'private.txt'),'secret');await assert.rejects(query(f.search,'secret'),{code:'DENIED'});
});
test('ignore negation, scoped folder search and high Unicode protocol output remain intact',async t=>{
 const f=fixture(t);f.write('.gitignore','*.txt\n!keep.txt\n');f.write('drop.txt','秘密 😀');f.write('keep.txt','秘密 😀');f.write('folder/kept.md','秘密 😀');f.write('other.md','秘密 😀');
 const result=await query(f.search,'秘密',{path:'folder'});assert.equal(result.matches.length,1);assert.equal(result.matches[0].lineText,'秘密 😀');assert.equal(result.matches[0].endColumn,3);
 const all=await query(f.search,'秘密');assert.deepEqual(all.matches.map(x=>x.path),['folder/kept.md','keep.txt','other.md']);
 f.write('long.md',Array.from({length:100},()=> '秘密 😀 repeated').join('\n'));const long=await query(f.search,'秘密');assert.equal(long.matches.filter(x=>x.path==='long.md').length,100);assert(long.matches.every(x=>!x.lineText.includes('�')));
});

test('read-only search retains nonportable names admitted by source inspection',async t=>{
 const f=fixture(t);f.write('100% complete.md','target');f.write('notes:2026.md','target');const listing=await f.search.listRepositoryFiles({requestId:id,repo:'repo'});assert.deepEqual(listing.paths,['100% complete.md','notes:2026.md']);assert.equal((await query(f.search,'target',{path:'notes:2026.md'})).matches[0].path,'notes:2026.md');
});

test('host file inventory results open retained percent and colon names through read-only bridge',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'search-names-'));const dataRoot=path.join(root,'data'),service=await createNativeService({dataRoot});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const repository=path.join(dataRoot,'workspaces/asMagicBrain/Workspace');for(const name of ['100% complete.md','notes:2026.md'])fs.writeFileSync(path.join(repository,name),'retained target');
 const result=await service.listRepositoryFiles({requestId:id,repo:'Workspace'});for(const name of ['100% complete.md','notes:2026.md']){assert(result.paths.includes(name));assert.equal((await service.read({repo:'Workspace',path:name})).content,'retained target');}
 await assert.rejects(service.request({repo:'Workspace',operation:'create',args:{path:'new:bad.md',text:'no'}}));
 await assert.rejects(service.importExternalFiles({repo:'Workspace',destination:'folder:invalid',sources:['unopened']}),{code:'INVALID_REQUEST'});
});
