import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createPluginPackage,inspectPluginPackage} from '../desktop-host/src/plugin-packages/format.mjs';
import {isTrustedTeachPackage,teachPackageDigest,legacyTeachPackageDigest} from './binding.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
const entry=(version,digest,m=manifest)=>({id:m.id,version,digest,manifest:m});
test('release package bytes match exact teaching activation identity',()=>{
 const info=inspectPluginPackage(createPluginPackage({manifest,compression:'store',resources:[{path:'content/about.txt',bytes:fs.readFileSync(new URL('./about.txt',import.meta.url))}]}));
 assert.equal(info.digest,teachPackageDigest);
 assert.equal(createPluginPackage({manifest,compression:'store',resources:[{path:'content/about.txt',bytes:fs.readFileSync(new URL('./about.txt',import.meta.url))}]}).readUInt16LE(8),0);assert.equal(manifest.version,'0.1.2');assert.equal(isTrustedTeachPackage(entry(manifest.version,info.digest)),true);
});
test('previous exact installed teaching identity stays active after app replacement',()=>{
 const info=inspectPluginPackage(fs.readFileSync(new URL('./fixtures/asTeach-0.1.1.asmbplugin',import.meta.url)));
 const old=info.manifest;
 assert.equal(info.digest,legacyTeachPackageDigest);assert.equal(isTrustedTeachPackage(entry(old.version,info.digest,old)),true);
});
test('unreviewed bytes, mismatched version, publisher or access do not activate teaching',()=>{
 assert.equal(isTrustedTeachPackage(entry('0.1.2',legacyTeachPackageDigest)),false);
 assert.equal(isTrustedTeachPackage(entry('0.1.1',teachPackageDigest)),false);
 assert.equal(isTrustedTeachPackage(entry('0.1.3',teachPackageDigest)),false);
 assert.equal(isTrustedTeachPackage(entry('0.1.2','0'.repeat(64))),false);
 assert.equal(isTrustedTeachPackage(entry('0.1.2',teachPackageDigest,{...manifest,publisher:{id:'other'}})),false);
 assert.equal(isTrustedTeachPackage(entry('0.1.2',teachPackageDigest,{...manifest,permissions:['files']})),false);
 assert.equal(isTrustedTeachPackage(null),false);
});

test('stored packaging refuses an unknown compressor and preserves admitted payload bytes',()=>{
 const input={manifest,resources:[{path:'content/about.txt',bytes:Buffer.from('Exact bytes\r\n')}]};
 const first=createPluginPackage({...input,compression:'store'}),second=createPluginPackage({...input,compression:'store'});
 assert.deepEqual(first,second);
 assert.equal(inspectPluginPackage(first).fileCount,3);
 assert.throws(()=>createPluginPackage({...input,compression:'unknown'}),{code:'INVALID_PACKAGE'});
});
