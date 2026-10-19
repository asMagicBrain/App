import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testRoot} from './development-paths.mjs';
import {buildArtifactManifest} from './create-artifact-manifest.mjs';
import {pinDirectory,prepareArtifactSnapshot} from '../apps/native/artifact-snapshot.mjs';
test('explicit inventory is portable, read-only and detects changed or missing dependencies',()=>{
 const parent=path.join(testRoot,'runs','interactive-manifest-unit');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'portable-'));
 fs.mkdirSync(path.join(root,'media'));fs.writeFileSync(path.join(root,'media/example.html'),'<script src="logic.js"></script>');fs.writeFileSync(path.join(root,'media/logic.js'),'document.title="fixture";');fs.writeFileSync(path.join(root,'fallback.md'),'Read the worked example.');
 const before=fs.readFileSync(path.join(root,'media/logic.js'));const manifest=buildArtifactManifest({root,id:'test.portable',title:'Portable example',entry:'media/example.html',fallback:'fallback.md',assets:['media/logic.js']});fs.writeFileSync(path.join(root,'example.artifact.json'),JSON.stringify(manifest));
 const first=prepareArtifactSnapshot({root:pinDirectory(root),path:'example.artifact.json'});
 const copy=fs.mkdtempSync(path.join(parent,'copied-'));fs.cpSync(root,copy,{recursive:true});const moved=prepareArtifactSnapshot({root:pinDirectory(copy),path:'example.artifact.json'});assert.deepEqual(moved.contentIdentity,first.contentIdentity);assert.notEqual(moved.identity,first.identity);assert.deepEqual(fs.readFileSync(path.join(root,'media/logic.js')),before);
 fs.writeFileSync(path.join(copy,'media/logic.js'),'changed');assert.throws(()=>prepareArtifactSnapshot({root:pinDirectory(copy),path:'example.artifact.json'}),{code:'ARTIFACT_HASH_MISMATCH'});
 assert.throws(()=>buildArtifactManifest({root,id:'test.invalid',title:'Invalid',entry:'media/example.html',fallback:'fallback.md',assets:['../outside.js']}),/portable/);
 assert.throws(()=>buildArtifactManifest({root,id:'test.missing',title:'Missing',entry:'media/example.html',fallback:'fallback.md',assets:['missing.js']}),{code:'ENOENT'});
});
