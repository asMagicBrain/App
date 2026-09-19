import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isPublicSourcePath} from './public-source-policy.mjs';
test('allows only reviewed source roots and necessary visible or explicit hidden files',()=>{
 for(const p of ['README.md','SUPPORT.md','.gitignore','.gitattributes','.gitleaks.toml','.github/workflows/source.yml','apps/native/main.mjs','contributing/development.md','docs/assets/example.png','packages/desktop-host/tests/fixture.mjs','tools/run.sh','ui-workshop/.storybook/main.ts','ui-workshop/.npmrc'])assert.equal(isPublicSourcePath(p),true,p);
});
test('rejects credentials, unexpected configuration, build/private roots and ambiguous paths',()=>{
 for(const p of ['.npmrc','apps/.npmrc','.netrc','.env','.aws/credentials','apps/.ssh/config','apps/secret.pem','apps/native/key.p12','private-notes.md','unknown/source.mjs','docs/.DS_Store','docs/.env.local','ui-workshop/.cache/file','apps/native/dist/main.js','releases/app','packages/node_modules/a','private/README.md','docs/internal/README.md','apps/backup/snapshot.md','docs/../README.md','/README.md','docs//README.md','docs\\file','docs/file\0.md','.git/config'])assert.equal(isPublicSourcePath(p),false,p);
});

test('the complete tracked and prospective source surface satisfies publication policy',()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 const files=execFileSync('git',['-C',root,'ls-files','-z','--cached','--others','--exclude-standard'],{env,encoding:'utf8'}).split('\0').filter(Boolean);
 assert.ok(files.length>0);assert.deepEqual(files.filter(name=>!isPublicSourcePath(name)),[]);
});
