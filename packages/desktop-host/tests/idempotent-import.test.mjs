import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {testRoot} from '../../../tools/development-paths.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {createRepositoryImporter} from '../src/repository-import/index.mjs';
import {createPackageZip,sha256} from '../src/package-exchange/archive.mjs';
const runRoot=path.join(testRoot,'runs/stage4-shared-services-20260922/exchange/import');fs.mkdirSync(runRoot,{recursive:true,mode:0o700});
const archive=createPackageZip([{path:'README.md',bytes:Buffer.from('# Imported\r\nNo hidden commit.\r\n')},{path:'folder/asset.bin',bytes:Buffer.from([0,255,2])}]);
function fixture(hooks={}){const root=fs.mkdtempSync(path.join(runRoot,'idempotent-import-')),base=path.join(root,'organization'),archivePath=path.join(root,'source.zip');fs.mkdirSync(base,{mode:0o700});fs.writeFileSync(archivePath,archive);const options={base,builtinRepositories:[],hooks};return {root,base,archivePath,options,importer:createRepositoryImporter(options)};}
const git=(root,...args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',root,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',TMPDIR:process.env.TMPDIR},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

test('explicit no-history ZIP import has unborn main and retry after restart returns one registered repository',async()=>{
 const f=fixture(),request={name:'Imported',archivePath:f.archivePath,requestId:randomUUID(),initializeHistory:false};const first=await f.importer.importArchive(request),repo=path.join(f.base,'Imported');assert.equal(first.head,null);assert.equal(first.archiveSha256,sha256(archive));assert.equal(first.initializeHistory,false);assert.equal(git(repo,'symbolic-ref','HEAD'),'refs/heads/main');assert.throws(()=>git(repo,'rev-parse','--verify','HEAD'));assert.ok(!fs.existsSync(path.join(repo,'.git/index')));assert.doesNotMatch(fs.readFileSync(path.join(repo,'.git/config'),'utf8'),/\[user\]|example|author/);assert.equal(fs.readFileSync(path.join(repo,'README.md'),'utf8'),'# Imported\r\nNo hidden commit.\r\n');
 const reopened=createRepositoryImporter(f.options);assert.deepEqual(await reopened.importArchive(request),first);assert.deepEqual(reopened.findCompletedImport({requestId:request.requestId,name:request.name,archiveSha256:sha256(archive),initializeHistory:false}),first);assert.deepEqual(reopened.catalog.list(),[{name:'Imported',privateRepo:true}]);
 await assert.rejects(reopened.importArchive({...request,initializeHistory:true}),{code:'REQUEST_CONFLICT'});await assert.rejects(reopened.importArchive({...request,name:'Other'}),{code:'REQUEST_CONFLICT'});const changed=path.join(f.root,'different.zip');fs.writeFileSync(changed,createPackageZip([{path:'different.md',bytes:Buffer.from('changed')} ]));await assert.rejects(reopened.importArchive({...request,archivePath:changed}),{code:'REQUEST_CONFLICT'});
});

test('read-only import lookup never starts an unknown operation; ordinary UI import keeps initial history',async()=>{
 const f=fixture();assert.equal(f.importer.findCompletedImport({requestId:randomUUID(),name:'Unknown',archiveSha256:sha256(archive),initializeHistory:false}),null);assert.deepEqual(f.importer.catalog.list(),[]);const imported=await f.importer.importArchive({name:'Ordinary',archivePath:f.archivePath});assert.match(imported.head,/^[a-f0-9]{40}$/);assert.equal(git(path.join(f.base,'Ordinary'),'rev-list','--count','HEAD'),'1');
});

for(const phase of ['zip-ready','zip-published','zip-cataloged'])test(`actual process interruption at ${phase} yields one exact receipt on restart`,async()=>{
 const f=fixture(),requestId=randomUUID(),entry=new URL('../src/repository-import/index.mjs',import.meta.url).href;
 const script=`import {createRepositoryImporter} from ${JSON.stringify(entry)};const manager=createRepositoryImporter({base:${JSON.stringify(f.base)},builtinRepositories:[],hooks:{at:p=>{if(p===${JSON.stringify(phase)})process.exit(86);}}});await manager.importArchive({name:'Interrupted',archivePath:${JSON.stringify(f.archivePath)},requestId:${JSON.stringify(requestId)},initializeHistory:false});process.exit(87);`;
 const scriptPath=path.join(f.root,'crash.mjs');fs.writeFileSync(scriptPath,script);const child=spawnSync(process.execPath,[scriptPath],{env:process.env,encoding:'utf8'});assert.equal(child.status,86,child.stderr);const reopened=createRepositoryImporter(f.options),observed=reopened.findCompletedImport({requestId,name:'Interrupted',archiveSha256:sha256(archive),initializeHistory:false});assert.ok(observed);assert.equal(observed.head,null);const repeated=await reopened.importArchive({name:'Interrupted',archivePath:f.archivePath,requestId,initializeHistory:false});assert.deepEqual(repeated,observed);assert.equal(reopened.catalog.list().length,1);assert.equal(fs.readFileSync(path.join(f.base,'Interrupted/README.md'),'utf8'),'# Imported\r\nNo hidden commit.\r\n');
});

test('request bytes stay bound before readiness; retry preserves orphan stage and never adopts arbitrary destination',async()=>{
 const f=fixture(),requestId=randomUUID(),entry=new URL('../src/repository-import/index.mjs',import.meta.url).href;
 const script=`import {createRepositoryImporter} from ${JSON.stringify(entry)};const manager=createRepositoryImporter({base:${JSON.stringify(f.base)},builtinRepositories:[],hooks:{at:p=>{if(p==='zip-staging')process.exit(86);}}});await manager.importArchive({name:'Interrupted',archivePath:${JSON.stringify(f.archivePath)},requestId:${JSON.stringify(requestId)},initializeHistory:false});`;
 const scriptPath=path.join(f.root,'crash.mjs');fs.writeFileSync(scriptPath,script);assert.equal(spawnSync(process.execPath,[scriptPath],{env:process.env}).status,86);const reopened=createRepositoryImporter(f.options);assert.equal(reopened.findCompletedImport({requestId,name:'Interrupted',archiveSha256:sha256(archive),initializeHistory:false}),null);const orphan=fs.readdirSync(f.base).filter(name=>name.startsWith('.asmb-import-'));assert.equal(orphan.length,1);
 const changed=path.join(f.root,'different.zip');fs.writeFileSync(changed,createPackageZip([{path:'different.md',bytes:Buffer.from('changed')}]));await assert.rejects(reopened.importArchive({name:'Interrupted',archivePath:changed,requestId,initializeHistory:false}),{code:'REQUEST_CONFLICT'});assert.ok(fs.existsSync(path.join(f.base,orphan[0])));fs.mkdirSync(path.join(f.base,'Interrupted'));fs.writeFileSync(path.join(f.base,'Interrupted','mine.txt'),'do not adopt');await assert.rejects(reopened.importArchive({name:'Interrupted',archivePath:f.archivePath,requestId,initializeHistory:false}),{code:'NAME_EXISTS'});assert.equal(fs.readFileSync(path.join(f.base,'Interrupted','mine.txt'),'utf8'),'do not adopt');
});

test('simultaneous retry is busy while admitted import finishes, then receives the exact receipt',async()=>{
 const f=fixture(),request={name:'Concurrent',archivePath:f.archivePath,requestId:randomUUID(),initializeHistory:false};const first=f.importer.importArchive(request);await assert.rejects(f.importer.importArchive(request),{code:'IMPORT_BUSY'});const result=await first;assert.deepEqual(await f.importer.importArchive(request),result);assert.equal(f.importer.catalog.list().length,1);
});
