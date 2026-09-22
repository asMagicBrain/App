import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testRoot} from '../../tools/development-paths.mjs';
import {saveExportDestination} from './export-destination.mjs';
const base=path.join(testRoot,'runs/stage4-shared-services-20260922/exchange/destinations');fs.mkdirSync(base,{recursive:true,mode:0o700});
const bytes=Buffer.from('Synthetic ZIP payload for destination authority checks');
function fixture(){const root=fs.mkdtempSync(path.join(base,'case-')),parent=path.join(root,'downloads');fs.mkdirSync(parent,{mode:0o700});return{root,parent,filename:path.join(parent,'source.zip')};}

test('native export creates one exclusive exact-byte ZIP and never overwrites an existing destination',()=>{
 const f=fixture();assert.deepEqual(saveExportDestination(f.filename,bytes),{saved:true,filename:'source.zip'});assert.deepEqual(fs.readFileSync(f.filename),bytes);assert.equal(fs.statSync(f.filename).mode&0o777,0o600);
 const before=fs.statSync(f.filename,{bigint:true});assert.throws(()=>saveExportDestination(f.filename,Buffer.from('replacement')),/already exists/);assert.deepEqual(fs.readFileSync(f.filename),bytes);assert.equal(fs.statSync(f.filename,{bigint:true}).ino,before.ino);
});

test('linked destinations and linked parents cannot redirect export writes',()=>{
 const f=fixture(),target=path.join(f.root,'retained.zip');fs.writeFileSync(target,'Original user bytes');fs.symlinkSync(target,f.filename);assert.throws(()=>saveExportDestination(f.filename,bytes));assert.equal(fs.readFileSync(target,'utf8'),'Original user bytes');assert.ok(fs.lstatSync(f.filename).isSymbolicLink());
 const linked=path.join(f.root,'linked');fs.symlinkSync(f.parent,linked);assert.throws(()=>saveExportDestination(path.join(linked,'new.zip'),bytes));assert.ok(!fs.existsSync(path.join(f.parent,'new.zip')));
});

test('managed source/private roots and noncanonical/non-ZIP destinations fail without writes',()=>{
 const f=fixture();for(const name of ['source','private'])fs.mkdirSync(path.join(f.root,name),{mode:0o700});const roots=['source','private'].map(name=>path.join(f.root,name));
 for(const root of roots)assert.throws(()=>saveExportDestination(path.join(root,'export.zip'),bytes,roots),/outside your managed workspace/);
 for(const value of ['relative.zip',path.join(f.parent,'out.html'),f.parent+'/../out.zip',null])assert.throws(()=>saveExportDestination(value,bytes,roots));
 assert.deepEqual(fs.readdirSync(f.parent),[]);for(const root of roots)assert.deepEqual(fs.readdirSync(root),[]);
});

test('parent inode replacement after writing is detected and replacement files are preserved',t=>{
 const f=fixture(),original=fs.fsyncSync,retained=path.join(f.root,'retained-parent');let replaced=false;
 t.mock.method(fs,'fsyncSync',fd=>{original(fd);if(!replaced&&fs.fstatSync(fd).isFile()){replaced=true;fs.renameSync(f.parent,retained);fs.mkdirSync(f.parent,{mode:0o700});fs.writeFileSync(f.filename,'Replacement owner bytes');}});
 assert.throws(()=>saveExportDestination(f.filename,bytes));assert.equal(fs.readFileSync(f.filename,'utf8'),'Replacement owner bytes');assert.deepEqual(fs.readFileSync(path.join(retained,'source.zip')),bytes);
});

test('destination inode replacement cannot be mistaken for the saved export or unlinked during cleanup',t=>{
 const f=fixture(),original=fs.fsyncSync,retained=path.join(f.parent,'retained.zip');let replaced=false;
 t.mock.method(fs,'fsyncSync',fd=>{original(fd);if(!replaced&&fs.fstatSync(fd).isFile()){replaced=true;fs.renameSync(f.filename,retained);fs.writeFileSync(f.filename,'New external file');}});
 assert.throws(()=>saveExportDestination(f.filename,bytes),/destination changed/);assert.equal(fs.readFileSync(f.filename,'utf8'),'New external file');assert.deepEqual(fs.readFileSync(retained),bytes);
});

test('failed synchronization removes only this operation\'s owned partial output',t=>{
 const f=fixture();t.mock.method(fs,'fsyncSync',()=>{throw Object.assign(Error('injected sync error'),{code:'EIO'});});assert.throws(()=>saveExportDestination(f.filename,bytes),{code:'EIO'});assert.equal(fs.existsSync(f.filename),false);
});
