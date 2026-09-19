import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createImportedGitSnapshot} from '../src/local-git/import-snapshot.mjs';
import {createLocalGit} from '../src/local-git/index.mjs';

function fixture(t) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-git-import-')),sourceRoot=path.join(base,'stage');fs.mkdirSync(sourceRoot,{mode:0o700});
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('/usr/bin/git',['--no-pager','-C',sourceRoot,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 return {base,sourceRoot,git,write:(name,bytes,mode=0o600)=>fs.writeFileSync(path.join(sourceRoot,name),bytes,{mode})};
}

test('fresh import commits exact binary, BOM/CRLF, executable and ignored bytes on main with no remotes',async t=>{
 const {base,sourceRoot,git,write}=fixture(t),binary=Buffer.from([0,255,254,13,10,0,128]);
 fs.mkdirSync(path.join(sourceRoot,'assets'));fs.mkdirSync(path.join(sourceRoot,'empty'));
 write('README.md','\ufeff# Import\r\n原样\r\n');write('assets/data.bin',binary);write('.gitignore','assets/\n');
 write('.gitattributes','* text eol=lf filter=do-not-execute\n');write('script.sh','#!/bin/sh\r\necho inert\r\n',0o700);write('empty.txt','');
 const names=['README.md','assets/data.bin','.gitignore','.gitattributes','script.sh','empty.txt'];
 const originals=new Map(names.map(name=>[name,fs.readFileSync(path.join(sourceRoot,name))]));
 const result=await createImportedGitSnapshot({sourceRoot,files:names.map(name=>({path:name,mode:name==='script.sh'?0o700:0o600}))});
 assert.equal(result.branch,'main');assert.equal(result.fileCount,names.length);assert.equal(git('rev-parse','HEAD'),result.head);
 assert.equal(git('symbolic-ref','--short','HEAD'),'main');assert.equal(git('log','--format=%s'),'Import project');assert.equal(git('rev-list','--count','HEAD'),'1');
 assert.equal(git('remote'), '');assert.equal(fs.existsSync(path.join(sourceRoot,'.git','hooks')),false);
 for(const [name,bytes] of originals){assert.deepEqual(execFileSync('/usr/bin/git',['-C',sourceRoot,'cat-file','blob',`HEAD:${name}`]),bytes);assert.deepEqual(fs.readFileSync(path.join(sourceRoot,name)),bytes);}
 assert.match(git('ls-tree','HEAD','script.sh'),/^100755 /);assert.ok(fs.statSync(path.join(sourceRoot,'empty')).isDirectory());
 assert.throws(()=>git('config','--local','--get','user.name'));
 // Publication changes the path: no private state is bound to the staging root.
 const published=path.join(base,'published'),privateRoot=path.join(base,'private');fs.renameSync(sourceRoot,published);fs.mkdirSync(privateRoot,{mode:0o700});
 const local=createLocalGit({sourceRoot:published,privateRoot});assert.equal((await local.inspect()).head,result.head);assert.deepEqual((await local.status()).files,[]);
});

test('empty extracted project receives a real initial commit',async t=>{
 const {sourceRoot,git}=fixture(t);fs.mkdirSync(path.join(sourceRoot,'empty'));
 const result=await createImportedGitSnapshot({sourceRoot,files:[]});assert.equal(result.fileCount,0);assert.equal(git('log','-1','--format=%s'),'Import project');assert.equal(git('ls-tree','HEAD'),'');
});

test('existing Git metadata and nested repositories are never modified',async t=>{
 const {sourceRoot,git,write}=fixture(t);write('README.md','preserve');const first=await createImportedGitSnapshot({sourceRoot,files:[{path:'README.md'}]});
 const index=fs.readFileSync(path.join(sourceRoot,'.git','index'));await assert.rejects(createImportedGitSnapshot({sourceRoot,files:[{path:'README.md'}]}),{code:'GIT_ALREADY_INITIALIZED'});
 assert.equal(git('rev-parse','HEAD'),first.head);assert.deepEqual(fs.readFileSync(path.join(sourceRoot,'.git','index')),index);
 const child=path.join(sourceRoot,'child');fs.mkdirSync(child);await assert.rejects(createImportedGitSnapshot({sourceRoot:child,files:[]}),{code:'NESTED_REPOSITORY'});assert.equal(fs.existsSync(path.join(child,'.git')),false);
});

test('manifest mismatch, nonportable aliases, mode mismatch and linked files fail before initialization',async t=>{
 const {base,sourceRoot,write}=fixture(t);write('README.md','keep');
 for(const files of [[],[{path:'missing.md'}],[{path:'README.md'},{path:'readme.md'}],[{path:'../README.md'}],[{path:'README.md',mode:'100755'}]]){
  await assert.rejects(createImportedGitSnapshot({sourceRoot,files}));assert.equal(fs.existsSync(path.join(sourceRoot,'.git')),false);
 }
 const outside=path.join(base,'outside');fs.writeFileSync(outside,'external');fs.linkSync(outside,path.join(sourceRoot,'linked'));
 await assert.rejects(createImportedGitSnapshot({sourceRoot,files:[{path:'README.md'},{path:'linked'}]}),{code:'UNSAFE_FILE'});assert.equal(fs.existsSync(path.join(sourceRoot,'.git')),false);
 fs.unlinkSync(path.join(sourceRoot,'linked'));fs.symlinkSync(outside,path.join(sourceRoot,'linked'));
 await assert.rejects(createImportedGitSnapshot({sourceRoot,files:[{path:'README.md'},{path:'linked'}]}),{code:'UNSAFE_FILE'});assert.equal(fs.readFileSync(outside,'utf8'),'external');
});

test('host environment cannot supply templates, filters, hooks or author identity',async t=>{
 const {base,sourceRoot,git,write}=fixture(t),template=path.join(base,'template'),marker=path.join(base,'executed'),config=path.join(base,'global-config');
 fs.mkdirSync(template);fs.mkdirSync(path.join(template,'hooks'));fs.writeFileSync(path.join(template,'hooks','reference-transaction'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
 fs.writeFileSync(config,`[init]\n templateDir = ${template}\n[user]\n name = External\n email = external@example.test\n[filter "danger"]\n clean = touch '${marker}'\n required = true\n[core]\n hooksPath = ${path.join(template,'hooks')}\n autocrlf = true\n`);
 const previous={GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL,GIT_TEMPLATE_DIR:process.env.GIT_TEMPLATE_DIR,GIT_AUTHOR_NAME:process.env.GIT_AUTHOR_NAME};
 Object.assign(process.env,{GIT_CONFIG_GLOBAL:config,GIT_TEMPLATE_DIR:template,GIT_AUTHOR_NAME:'External'});
 try {write('.gitattributes','*.md filter=danger text eol=lf\n');write('README.md','Exact\r\n');await createImportedGitSnapshot({sourceRoot,files:[{path:'.gitattributes'},{path:'README.md'}]});}
 finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
 assert.equal(fs.existsSync(marker),false);assert.equal(git('log','-1','--format=%an <%ae>'),'asMagicBrain <local@asmagicbrain.invalid>');assert.deepEqual(execFileSync('/usr/bin/git',['-C',sourceRoot,'cat-file','blob','HEAD:README.md']),Buffer.from('Exact\r\n'));
});
