import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {crc32} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createRepositoryImportHandler} from './repository-import.mjs';
import {createRepositoryCatalog,createRepositoryImporter} from '../../packages/desktop-host/src/repository-import/index.mjs';
import {readLocalRepository} from './local-repositories.mjs';
import {createWorkspaceService} from './local-workspace.mjs';

function zip(items){
 const locals=[],centrals=[];let offset=0;
 for(const [filename,content]of items){const name=Buffer.from(filename),bytes=Buffer.from(content),local=Buffer.alloc(30),central=Buffer.alloc(46),crc=crc32(bytes);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,bytes);centrals.push(central,name);offset+=local.length+name.length+bytes.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
function fixture(t){const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-zip-endpoint-')),base=path.join(directory,'repos');fs.mkdirSync(base);fs.mkdirSync(path.join(base,'Workspace'));fs.writeFileSync(path.join(base,'Workspace','README.md'),'Existing');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return{directory,base};}
async function call(handler,{method='GET',headers={},body=Buffer.alloc(0),url='/__repository-import'}={}){const req=Readable.from([body]);Object.assign(req,{method,url,headers:{host:'127.0.0.1:6006',...headers}});const out={};await handler(req,{writeHead(status,headers){Object.assign(out,{status,headers});},end(data){out.body=JSON.parse(data);}});return out;}
const payload=()=>zip([['sample-main/README.md','\ufeff# Imported\r\n'],['sample-main/docs/note.md','Nested\n'],['sample-main/assets/data.bin',Buffer.from([0,255,1])],['sample-main/.git/config','ignored old connection'],['sample-main/.DS_Store','ignored desktop metadata']]);
test('ZIP HTTP import publishes exact managed bytes and fresh local Git, persists catalog and enables editing',async t=>{
 const {directory,base}=fixture(t),handler=createRepositoryImportHandler({base}),bootstrap=await call(handler);assert.equal(bootstrap.body.repositories.length,5);
 const headers={origin:'http://127.0.0.1:6006','content-type':'application/zip','x-asmagicbrain-capability':bootstrap.body.capability},archive=payload();
 const imported=await call(handler,{method:'POST',headers,body:archive,url:'/__repository-import?name=Sample'});assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.value.files,3);assert.equal(imported.body.value.excludedEntries,2);
 const root=path.join(base,'Sample'),git=(...args)=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8'}).trim();
 assert.equal(git('log','--format=%s'),'Import project');assert.equal(git('rev-list','--count','HEAD'),'1');assert.equal(git('remote'),'');assert.equal(git('status','--porcelain'),'');
 assert.deepEqual(fs.readFileSync(path.join(root,'assets/data.bin')),Buffer.from([0,255,1]));assert.equal(fs.readFileSync(path.join(root,'README.md'),'utf8'),'\ufeff# Imported\r\n');
 const reopened=createRepositoryImportHandler({base});assert((await call(reopened)).body.repositories.some(v=>v.name==='Sample'));assert.equal((await readLocalRepository('Sample','README.md',base)).content,'\ufeff# Imported\r\n');
 const workspace=createWorkspaceService({base,privateBase:path.join(directory,'private')});t.after(()=>workspace.close());const opened=await workspace.execute('Sample','open',{path:'README.md'});
 await workspace.execute('Sample','save',{path:'README.md',baseHash:opened.sourceHash,text:opened.text+'Local edit\r\n'});assert.equal((await workspace.execute('Sample','gitStatus',{})).files[0].path,'README.md');
 assert.equal((await call(handler,{method:'POST',headers,body:archive,url:'/__repository-import?name=sample'})).status,409);assert.equal(fs.readFileSync(path.join(base,'Workspace','README.md'),'utf8'),'Existing');
 assert(!fs.readdirSync(path.join(base,'.asmb-catalog')).some(n=>n.startsWith('upload-')));
});
test('ZIP endpoint denies foreign requests, malformed names, bad archives and occupied directories without mutation',async t=>{
 const {base}=fixture(t),handler=createRepositoryImportHandler({base}),bootstrap=await call(handler),headers={origin:'http://127.0.0.1:6006','content-type':'application/zip','x-asmagicbrain-capability':bootstrap.body.capability};
 for(const changes of [{origin:'https://foreign.test'},{host:'foreign.test'},{'sec-fetch-site':'cross-site'},{'x-asmagicbrain-capability':'wrong'},{'content-type':'application/json'}])assert.equal((await call(handler,{method:'POST',headers:{...headers,...changes},body:payload(),url:'/__repository-import?name=Sample'})).status,403);
 for(const name of ['../escape','con','name.','with space',''])assert.equal((await call(handler,{method:'POST',headers,body:payload(),url:`/__repository-import?name=${encodeURIComponent(name)}`})).status,400);
 const invalid=await call(handler,{method:'POST',headers,body:Buffer.from('not a zip'),url:'/__repository-import?name=Invalid'});assert.equal(invalid.body.error.code,'ZIP_INVALID');assert(!fs.existsSync(path.join(base,'Invalid')));assert(!fs.readdirSync(base).some(n=>n.startsWith('.asmb-import-')));
 fs.mkdirSync(path.join(base,'Occupied'));fs.writeFileSync(path.join(base,'Occupied','keep.txt'),'Keep');assert.equal((await call(handler,{method:'POST',headers,body:payload(),url:'/__repository-import?name=Occupied'})).status,409);assert.equal(fs.readFileSync(path.join(base,'Occupied','keep.txt'),'utf8'),'Keep');
 assert.equal((await call(handler,{method:'POST',headers:{...headers,'content-length':String(257*1024*1024)},url:'/__repository-import?name=Large'})).body.error.code,'ZIP_LIMIT_EXCEEDED');
 assert.equal((await call(handler,{method:'POST',headers,body:payload(),url:'/__repository-import?name=Valid'})).status,200);
});
test('catalog recovers published and reserved identities and owned publication links, never unrelated directories',async t=>{
 const {directory,base}=fixture(t),archivePath=path.join(directory,'sample.zip');fs.writeFileSync(archivePath,payload());const importer=createRepositoryImporter({base});await importer.importArchive({name:'Recover',archivePath});
 const metadata=path.join(base,'.asmb-catalog'),readyName=fs.readdirSync(metadata).find(n=>n.endsWith('.ready.json')),record=JSON.parse(fs.readFileSync(path.join(metadata,readyName))),final=path.join(metadata,'Recover.repo.json');
 fs.unlinkSync(final);createRepositoryCatalog(base).recover();assert(fs.existsSync(final));
 const duplicate=final+'.11111111-1111-1111-1111-111111111111.tmp';fs.linkSync(final,duplicate);assert(createRepositoryCatalog(base).list().some(v=>v.name==='Recover'));assert(!fs.existsSync(duplicate));
 fs.unlinkSync(final);const source=path.join(base,'Recover'),stage=path.join(base,`.asmb-import-${readyName.slice(0,-'.ready.json'.length)}`);fs.renameSync(source,stage);fs.mkdirSync(source);const stat=fs.statSync(source);
 fs.writeFileSync(path.join(metadata,readyName.replace('.ready.json','.reservation.json')),JSON.stringify({schemaVersion:1,name:'Recover',identity:`${stat.dev}:${stat.ino}`}));
 createRepositoryCatalog(base).recover();assert(fs.existsSync(final));assert.equal(fs.statSync(source).ino,Number(record.identity.split(':')[1]));assert(!fs.existsSync(stage));
 fs.renameSync(source,path.join(base,'preserved'));fs.mkdirSync(source);fs.writeFileSync(path.join(source,'owned.txt'),'Unrelated');assert.throws(()=>createRepositoryCatalog(base).list(),{code:'REPOSITORY_CHANGED'});assert.equal(fs.readFileSync(path.join(source,'owned.txt'),'utf8'),'Unrelated');
});
test('known dead-process lock is retired, live or unrecognized lock remains protected',async t=>{
 const {directory,base}=fixture(t),archivePath=path.join(directory,'archive.zip');fs.writeFileSync(archivePath,payload());const importer=createRepositoryImporter({base}),lock=path.join(base,'.asmb-catalog','import.lock');
 fs.writeFileSync(lock,JSON.stringify({schemaVersion:1,pid:process.pid,token:'live'}));await assert.rejects(importer.importArchive({name:'Blocked',archivePath}),{code:'IMPORT_BUSY'});fs.unlinkSync(lock);
 const dead=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}));fs.writeFileSync(lock,JSON.stringify({schemaVersion:1,pid:dead,token:'finished-child'}));
 const restarted=createRepositoryImporter({base});assert(!fs.existsSync(lock));await restarted.importArchive({name:'Recovered',archivePath});
 fs.writeFileSync(lock,'');assert.throws(()=>createRepositoryImporter({base}),{code:'IMPORT_BUSY'});assert(fs.existsSync(lock));
});
