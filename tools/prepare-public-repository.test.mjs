import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const env={...clean,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Private history fixture',GIT_AUTHOR_EMAIL:'private@example.invalid',GIT_COMMITTER_NAME:'Private history fixture',GIT_COMMITTER_EMAIL:'private@example.invalid'};
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',cwd,...args],{encoding:'utf8',env,stdio:'pipe'}).trim();
function fixture(){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'public-source-')),repo=path.join(parent,'internal'),exp=path.join(parent,'export'),output=path.join(parent,'publication');fs.mkdirSync(repo);
 const write=(name,text,mode=0o644)=>{const p=path.join(repo,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);fs.chmodSync(p,mode);};
 for(const f of ['LICENSE','NOTICE','README.md','CONTRIBUTING.md','SECURITY.md','CODE_OF_CONDUCT.md','docs/README.md'])write(f,'Synthetic fixture\n');
 write('package-lock.json','{}\n');write('ui-workshop/package-lock.json','{}\n');
 write('package.json',JSON.stringify({author:{name:'Public Maintainer',email:'public@example.invalid',url:'https://example.invalid'},organization:{name:'Example Group',url:'https://example.invalid'},homepage:'https://example.invalid',copyright:'Copyright 2026 Public Maintainer'})+'\n');
 write('apps/native/release.json',JSON.stringify({schemaVersion:1,version:'0.2.12',buildNumber:35,bundleId:'org.asmagicbrain.preview'})+'\n');
 for(const f of ['tools/export-source.mjs','tools/public-source-policy.mjs','apps/native/release-identity.mjs','packages/desktop-host/src/zip-import/index.mjs','packages/desktop-host/src/physical-roots.mjs','packages/source-foundation/src/domain/path-policy.mjs', 'packages/source-foundation/src/adapters/storage-identity.mjs'])write(f,fs.readFileSync(path.join(root,f)));
 write('docs/test file.md','\ufeffExact bytes\r\n');write('tools/run.sh','#!/bin/sh\nexit 0\n',0o755);
 git(repo,'init','--initial-branch=main','--object-format=sha1','--template=');git(repo,'add','.');git(repo,'commit','-m','Private initial history');
 write('NOTICE','Changed synthetic notice\n');git(repo,'add','.');git(repo,'commit','-m','Second internal commit');git(repo,'tag','native-v0.2.12');
 const exported=spawnSync(process.execPath,[path.join(repo,'tools/export-source.mjs'),'--output='+exp],{encoding:'utf8',env:clean});assert.equal(exported.status,0,exported.stderr);
 const manifest=path.join(exp,'source-manifest.json'),pin=sha(fs.readFileSync(manifest));
 const run=(extra=[],environment={})=>spawnSync(process.execPath,[path.join(root,'tools/prepare-public-repository.mjs'),'--export='+exp,'--manifest-sha256='+pin,'--output='+output,...extra],{encoding:'utf8',env:{...clean,...environment},maxBuffer:4*1024*1024});
 return {parent,repo,exp,output,manifest,pin,run};
}
test('creates a sterile single public commit with exact tree, public attribution and no old history/remotes',()=>{
 const f=fixture(),oldHead=git(f.repo,'rev-parse','HEAD'),result=f.run([], {GIT_DIR:path.join(f.repo,'.git'),GIT_WORK_TREE:f.repo,GIT_INDEX_FILE:path.join(f.repo,'.git/index'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.bare',GIT_CONFIG_VALUE_0:'true'});assert.equal(result.status,0,result.stderr);
 const pub=path.join(f.output,'repository'),receipt=JSON.parse(fs.readFileSync(path.join(f.output,'publication-manifest.json')));
 assert.equal(git(pub,'rev-list','--count','--all'),'1');assert.equal(git(pub,'remote'),'');assert.equal(git(pub,'status','--porcelain'),'');assert.equal(git(pub,'rev-parse','HEAD^{tree}'),git(f.repo,'rev-parse','HEAD^{tree}'));
 assert.equal(git(pub,'log','--format=%an <%ae>'),'Public Maintainer <public@example.invalid>');assert.equal(git(pub,'rev-parse','native-v0.2.12^{commit}'),receipt.publicRepository.sourceCommit);assert.notEqual(receipt.publicRepository.sourceCommit,oldHead);
 assert.equal(git(f.repo,'rev-parse','HEAD'),oldHead);assert.equal(git(f.repo,'rev-list','--count','HEAD'),'2');assert.equal(fs.existsSync(path.join(pub,'.git/logs')),false);
 const absent=spawnSync('git',['-C',pub,'cat-file','-e',oldHead],{env,encoding:'utf8'});assert.notEqual(absent.status,0);
 assert.equal(receipt.status,'prepared-local-only');assert.equal(receipt.upstream.manifestSha256,f.pin);assert.equal(receipt.publicRepository.tree,git(pub,'rev-parse','HEAD^{tree}'));
 assert.equal(fs.readFileSync(path.join(pub,'docs/test file.md'),'utf8'),'\ufeffExact bytes\r\n');assert.equal(fs.statSync(path.join(pub,'tools/run.sh')).mode&0o777,0o755);
 const before=sha(fs.readFileSync(path.join(f.output,'publication-manifest.json')));assert.notEqual(f.run().status,0);assert.equal(sha(fs.readFileSync(path.join(f.output,'publication-manifest.json'))),before);assert.equal(fs.existsSync(path.join(f.output,'INCOMPLETE.txt')),false);
});
test('refuses changed manifest, archive, source bytes/modes, extra private file and symlink before output creation',()=>{
 for(const change of ['manifest','archive','bytes','mode','extra','symlink']){
  const f=fixture(),source=path.join(f.exp,'source'),file=path.join(source,'docs/test file.md');
  if(change==='manifest')fs.appendFileSync(f.manifest,' ');
  if(change==='archive')fs.appendFileSync(path.join(f.exp,'asMagicBrain-0.2.12-source.zip'),'changed');
  if(change==='bytes')fs.writeFileSync(file,'Changed');
  if(change==='mode')fs.chmodSync(file,0o755);
  if(change==='extra')fs.writeFileSync(path.join(source,'.env'),'PRIVATE_FIXTURE=true');
  if(change==='symlink'){fs.renameSync(file,path.join(f.parent,'original.txt'));fs.symlinkSync(path.join(f.parent,'original.txt'),file);}
  assert.notEqual(f.run().status,0,change);assert.equal(fs.existsSync(f.output),false,change);
 }
});
test('refuses duplicate options and symlinked output ancestry',()=>{
 const f=fixture();assert.notEqual(f.run(['--output='+path.join(f.parent,'elsewhere')]).status,0);assert.equal(fs.existsSync(f.output),false);
 const alias=path.join(f.parent,'alias');fs.symlinkSync(f.repo,alias,'dir');
 const r=spawnSync(process.execPath,[path.join(root,'tools/prepare-public-repository.mjs'),'--export='+f.exp,'--manifest-sha256='+f.pin,'--output='+path.join(alias,'publication')],{encoding:'utf8',env:clean});assert.notEqual(r.status,0);assert.match(r.stderr,/physical ancestors/);assert.equal(fs.existsSync(path.join(f.repo,'publication')),false);
});
