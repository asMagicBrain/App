import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {createWorkspaceHandler,createWorkspaceService} from './local-workspace.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-local-editor-')),base=path.join(root,'repositories'),privateBase=path.join(root,'private');fs.mkdirSync(base);fs.mkdirSync(path.join(base,'Workspace'));fs.writeFileSync(path.join(base,'Workspace','README.md'),'\ufeff# Workspace\r\n');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {base,privateBase};}
async function call(handler,{method='GET',headers={},body,url='/__local-workspace?repo=Workspace'}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{method,url,headers:{host:'127.0.0.1:6006',...headers}});const result={};await handler(req,{writeHead(status,headers){Object.assign(result,{status,headers});},end(text){result.body=JSON.parse(text);}});return result;}
test('mutation transport admits only exact same-origin capability JSON requests',async t=>{
 const handler=createWorkspaceHandler(fixture(t));t.after(()=>handler.close());const bootstrap=await call(handler);assert.equal(bootstrap.status,200);assert.match(bootstrap.body.capability,/^[a-f0-9]{64}$/);const valid={origin:'http://127.0.0.1:6006','content-type':'application/json','x-asmagicbrain-capability':bootstrap.body.capability};
 const body={repo:'Workspace',operation:'open',args:{path:'README.md'}};
 for(const headers of [{},{...valid,origin:'https://evil.example'},{...valid,'sec-fetch-site':'cross-site'},{...valid,'x-asmagicbrain-capability':'wrong'},{...valid,'content-type':'text/plain'},{...valid,host:'evil.example'}])assert.equal((await call(handler,{method:'POST',headers,body})).status,403);
 const opened=await call(handler,{method:'POST',headers:valid,body});assert.equal(opened.body.value.text,'\ufeff# Workspace\r\n');
 for(const bad of [{...body,root:'/tmp'},{...body,operation:'execute'},{...body,args:{path:'README.md',command:'anything'}},{...body,repo:'unknown'}, {...body,args:{path:'../README.md'}},{...body,args:{path:'.git/config'}}])assert.equal((await call(handler,{method:'POST',headers:valid,body:bad})).body.ok,false);
 assert.equal((await call(handler,{method:'POST',headers:valid,body:'{'})).status,400);
 assert.equal((await call(handler,{headers:{origin:'https://evil.example'}})).status,403);
 assert.equal((await call(handler,{url:'/__local-workspace?repo=Workspace&repo=asTeach-App'})).status,400);
});
test('real source saves and private drafts survive service reconstruction',async t=>{
 const options=fixture(t);let service=createWorkspaceService(options);const opened=await service.execute('Workspace','open',{path:'README.md'});
 await service.execute('Workspace','checkpoint',{path:opened.path,baseHash:opened.sourceHash,text:'\ufeff# Draft\r\n'});
 await service.execute('Workspace','checkpointNew',{draftId:'draft-1',path:'notes/',text:'# New draft\r\n'});service.close();service=createWorkspaceService(options);t.after(()=>service.close());
 assert.equal((await service.execute('Workspace','open',{path:'README.md'})).draft.text,'\ufeff# Draft\r\n');assert.equal(service.bootstrap('Workspace').newDrafts[0].text,'# New draft\r\n');
 const saved=await service.execute('Workspace','save',{path:opened.path,baseHash:opened.sourceHash,text:'\ufeff# Saved\r\n'});assert.equal(saved.text,'\ufeff# Saved\r\n');assert.equal(saved.draft,null);
 assert.equal(fs.readFileSync(path.join(options.base,'Workspace','README.md'),'utf8'),saved.text);
 await assert.rejects(service.execute('Workspace','save',{path:opened.path,baseHash:opened.sourceHash,text:'stale'}),{code:'CONFLICT'});
 await service.execute('Workspace','discardNew',{draftId:'draft-1'});assert.equal(service.bootstrap('Workspace').newDrafts.length,0);
});
test('local workflow creates nested Markdown, commits reviewed bytes, then moves and commits only selected paths',async t=>{
 const options=fixture(t),service=createWorkspaceService(options);t.after(()=>service.close());const repo=path.join(options.base,'Workspace');
 await service.execute('Workspace','gitInitialize',{branch:'main'});
 const created=await service.execute('Workspace','create',{path:'notes/week-1.md',text:'\ufeff# Week one\r\nUnicode: 文本\r\n'});
 assert.equal(created.text,'\ufeff# Week one\r\nUnicode: 文本\r\n');
 let review=await service.execute('Workspace','gitReview',{paths:[created.path]});
 const commit=async value=>service.execute('Workspace','gitCommit',{expectedHead:value.expectedHead,expectedIndexHash:value.expectedIndexHash,files:value.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'Local editor test',author:{name:'asMagicBrain Test',email:'local-test@example.invalid'}});
 await commit(review);
 const git=args=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});
 assert.equal(git(['show','HEAD:notes/week-1.md']),created.text);
 assert.equal(git(['ls-tree','--name-only','HEAD']),'notes\n');
 const changed=await service.execute('Workspace','save',{path:created.path,baseHash:created.sourceHash,text:created.text+'Second line\r\n'});
 const renamed=await service.execute('Workspace','rename',{path:changed.path,newPath:'archive/week-1.md',baseHash:changed.sourceHash});
 assert.equal(renamed.documentId,created.documentId);
 review=await service.execute('Workspace','gitReview',{paths:[created.path,renamed.path]});await commit(review);
 assert.equal(git(['show','HEAD:archive/week-1.md']),changed.text);assert.equal(fs.readFileSync(path.join(repo,'README.md'),'utf8'),'\ufeff# Workspace\r\n');
 assert.equal((await service.execute('Workspace','gitStatus',{})).files.some(v=>v.path==='README.md'),true);
});
test('trusted trailing-slash roots initialize and cached drafts stay bound to physical repository',async t=>{
 const options=fixture(t),service=createWorkspaceService({base:options.base+'/',privateBase:options.privateBase+'/'});t.after(()=>service.close());
 await service.execute('Workspace','checkpointNew',{draftId:'private-draft',path:'note.md',text:'Preserve with original folder'});
 const current=path.join(options.base,'Workspace'),original=path.join(options.base,'preserved-original');
 fs.renameSync(current,original);fs.mkdirSync(current);
 assert.throws(()=>service.bootstrap('Workspace'),{code:'DENIED'});
 await assert.rejects(service.execute('Workspace','checkpointNew',{draftId:'private-draft',path:'note.md',text:'replacement'}),{code:'DENIED'});
 await assert.rejects(service.execute('Workspace','discardNew',{draftId:'private-draft'}),{code:'DENIED'});
 fs.rmdirSync(current);fs.renameSync(original,current);
 assert.equal(service.bootstrap('Workspace').newDrafts[0].text,'Preserve with original folder');
});

test('managed transport moves, copies and restores a large binary folder without text reads',async t=>{
 const options=fixture(t),service=createWorkspaceService(options);t.after(()=>service.close());
 const root=path.join(options.base,'Workspace');fs.mkdirSync(path.join(root,'assets'));const bytes=Buffer.alloc(3*1024*1024,0x9f);fs.writeFileSync(path.join(root,'assets','large.pdf'),bytes);
 assert.equal((await service.execute('Workspace','runtimeStatus',{})).recoveryRequired,false);
 const inspected=await service.execute('Workspace','inspectEntry',{path:'assets'});
 const moved=await service.execute('Workspace','manage',{operation:'move',items:[{path:'assets',token:inspected.token,newPath:'renamed'}]});
 assert.equal(moved.operation,'move');assert.deepEqual(fs.readFileSync(path.join(root,'renamed','large.pdf')),bytes);
 const current=await service.execute('Workspace','inspectEntry',{path:'renamed'});
 await service.execute('Workspace','manage',{operation:'copy',items:[{path:'renamed',token:current.token,newPath:'copy'}]});
 const trashed=await service.execute('Workspace','manage',{operation:'trash',items:[{path:'renamed',token:current.token}]});
 assert.equal((await service.execute('Workspace','listTrash',{})).some(item=>item.trashId===trashed.items[0].trashId),true);
 await service.execute('Workspace','restore',{trashId:trashed.items[0].trashId});
 assert.deepEqual(fs.readFileSync(path.join(root,'renamed','large.pdf')),bytes);assert.deepEqual(fs.readFileSync(path.join(root,'copy','large.pdf')),bytes);
 await assert.rejects(service.execute('Workspace','manage',{operation:'move',items:[{path:'../outside',token:current.token,newPath:'elsewhere'}]}));
 await assert.rejects(service.execute('Workspace','manage',{operation:'copy',items:[{path:'renamed',token:current.token,newPath:'copy'}]}));
});

test('runtime recovery status survives a transport restart and recovery is actionable',async t=>{
 const options=fixture(t);let service=createWorkspaceService(options);service.bootstrap('Workspace');service.close();
 const {createRepositoryRuntime}=await import('../../packages/desktop-host/src/repository-runtime/index.mjs');
 const runtime=createRepositoryRuntime({sourceRoot:path.join(options.base,'Workspace'),privateRoot:path.join(options.privateBase,'Workspace','files'),localOwnerId:'asMagicBrain',localRootId:'local-editor',checkoutId:'Workspace',hooks:{at(point){if(point==='after-intent')throw Error('isolated interruption');}}});
 const item=runtime.inspectEntry({path:'README.md'});
 assert.throws(()=>runtime.manage({operation:'copy',items:[{path:item.path,token:item.token,newPath:'copied.md'}]}));runtime.close();
 service=createWorkspaceService(options);t.after(()=>service.close());
 assert.equal((await service.execute('Workspace','runtimeStatus',{})).recoveryRequired,true);
 await service.execute('Workspace','reconcile',{});
 assert.equal((await service.execute('Workspace','runtimeStatus',{})).recoveryRequired,false);
});
