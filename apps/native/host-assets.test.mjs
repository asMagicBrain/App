import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';
import {readLocalRepositoryAsset,MAX_REPOSITORY_ASSET_BYTES} from '../../packages/desktop-host/src/repository-reader.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const git=(root,...args)=>execFileSync('/usr/bin/git',['-C',root,...args],{env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
const commit=root=>git(root,'-c','user.name=Asset Fixture','-c','user.email=asset@example.invalid','commit','--quiet','-m','Asset fixture');
function fixture(t){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-native-assets-')),dataRoot=path.join(parent,'profile'),source=path.join(dataRoot,'workspaces/asMagicBrain/Workspace');
 let service;t.after(async()=>{try{await service?.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,dataRoot,source,get service(){return service;},async start(){service=await createNativeService({dataRoot});return service;}};
}
function write(root,relative,bytes){const filename=path.join(root,relative);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);return filename;}
function content(value){assert.ok(value.data instanceof ArrayBuffer);return Buffer.from(value.data);}

test('native local images and video bytes are bounded read-only assets, separate from text documents',async t=>{
 const f=fixture(t),service=await f.start();
 // Signature fixtures verify transport/type admission; actual decoding is covered
 // by packaged UI acceptance using real screenshots and the WebM walkthrough.
 const webp=Buffer.from('52494646080000005745425056503820','hex');
 const fixtures=[['nested/图 example.png','image/png',PNG],['image.JPG','image/jpeg',Buffer.from([255,216,255,224,0,2,255,217])],['image.gif','image/gif',GIF],['image.webp','image/webp',webp],['walkthrough.webm','video/webm',Buffer.from([26,69,223,163,128,0,0,0])],['video.mp4','video/mp4',Buffer.from('000000106674797069736f6d00000000','hex')]];
 for(const [relative,mime,bytes] of fixtures)write(f.source,relative,bytes);
 const before=git(f.source,'status','--porcelain');
 for(const [relative,mime,bytes] of fixtures){const asset=await service.readAsset({repo:'Workspace',path:relative,ref:''});assert.equal(asset.mime,mime);assert.deepEqual(content(asset),bytes);assert.deepEqual(fs.readFileSync(path.join(f.source,relative)),bytes);}
 assert.equal((await service.read({repo:'Workspace',path:'nested/图 example.png'})).content,null);
 assert.equal(git(f.source,'status','--porcelain'),before);
 await service.close();const reopened=await f.start();assert.deepEqual(content(await reopened.readAsset({repo:'Workspace',path:'nested/图 example.png'})),PNG);
});

test('asset ref reads preserve the selected committed bytes without changing worktree or refs',async t=>{
 const f=fixture(t),service=await f.start();write(f.source,'docs/image.png',PNG);git(f.source,'add','.');commit(f.source);git(f.source,'tag','original');
 const current=Buffer.concat([PNG,Buffer.from('worktree annotation')]);write(f.source,'docs/image.png',current);
 const head=git(f.source,'rev-parse','HEAD'),status=git(f.source,'status','--porcelain');
 assert.deepEqual(content(await service.readAsset({repo:'Workspace',path:'docs/image.png',ref:'refs/tags/original'})),PNG);
 assert.deepEqual(content(await service.readAsset({repo:'Workspace',path:'docs/image.png',ref:'refs/heads/main'})),PNG);
 assert.deepEqual(content(await service.readAsset({repo:'Workspace',path:'docs/image.png'})),current);
 await assert.rejects(service.readAsset({repo:'Workspace',path:'docs/image.png',ref:'HEAD'}),{code:'INVALID_REF'});
 assert.equal(git(f.source,'rev-parse','HEAD'),head);assert.equal(git(f.source,'status','--porcelain'),status);assert.deepEqual(fs.readFileSync(path.join(f.source,'docs/image.png')),current);
});

test('asset requests reject unavailable types, invalid selections and oversized files while retaining source bytes',async t=>{
 const f=fixture(t),service=await f.start();write(f.source,'image.png',PNG);write(f.source,'invalid.png','ordinary text');write(f.source,'page.html','<h1>Source only</h1>');
 for(const input of [{repo:'Unregistered',path:'image.png'},{repo:'Workspace',path:'https://example.invalid/image.png'},{repo:'Workspace',path:'../image.png'},{repo:'Workspace',path:'.git/image.png'},{repo:'Workspace',path:'image.png',root:f.parent},{repo:'Workspace',path:''}])await assert.rejects(service.readAsset(input));
 await assert.rejects(service.readAsset({repo:'Workspace',path:'page.html'}),{code:'UNSUPPORTED_ASSET'});
 await assert.rejects(service.readAsset({repo:'Workspace',path:'invalid.png'}),{code:'UNSUPPORTED_ASSET'});
 const base=path.dirname(f.source),options={builtinRepositories:[{name:'Workspace',privateRepo:true}]};
 fs.symlinkSync('image.png',path.join(f.source,'linked.png'));
 await assert.rejects(readLocalRepositoryAsset('Workspace','linked.png',base,'',options));
 const large=write(f.source,'large.png',PNG);fs.truncateSync(large,MAX_REPOSITORY_ASSET_BYTES+1);
 await assert.rejects(readLocalRepositoryAsset('Workspace','large.png',base,'',options),{code:'ASSET_TOO_LARGE'});
 assert.equal(fs.statSync(large).size,MAX_REPOSITORY_ASSET_BYTES+1);assert.deepEqual(fs.readFileSync(path.join(f.source,'image.png')),PNG);assert.equal(fs.readFileSync(path.join(f.source,'page.html'),'utf8'),'<h1>Source only</h1>');
});

test('ZIP-imported documentation assets are catalog-admitted and remain readable after reopening',async t=>{
 const f=fixture(t),archiveRoot=path.join(f.parent,'docs');fs.mkdirSync(archiveRoot);git(archiveRoot,'init','--initial-branch=main','--quiet');
 write(archiveRoot,'README.md','# Docs\n\n![Overlay](media/overlay.png)\n');write(archiveRoot,'media/overlay.png',PNG);git(archiveRoot,'add','.');commit(archiveRoot);
 const bytes=execFileSync('/usr/bin/git',['-C',archiveRoot,'archive','--format=zip','--prefix=docs-main/','HEAD']);
 let service=await f.start();await service.importArchive({name:'asMagicBrain-DevDocs',bytes});
 const request={repo:'asMagicBrain-DevDocs',path:'media/overlay.png',ref:''};assert.deepEqual(content(await service.readAsset(request)),PNG);
 await service.close();service=await f.start();assert.deepEqual(content(await service.readAsset(request)),PNG);
 assert.deepEqual((await service.catalog()).repositories.map(item=>item.name),['Workspace','asMagicBrain-DevDocs']);
 assert.match((await service.read({repo:'Workspace',path:'README.md'})).content,/^# Workspace/);
});
