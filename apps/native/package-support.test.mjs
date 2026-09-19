import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertPhysical,validateRelease,bundleExecutable,runtimeClosure,inventory,dependencyNotices,sha256,requireUnencryptedCookieStore} from './package-support.mjs';
import {releaseSourceTag, releaseTagMatchesVersion} from './release-identity.mjs';

const appRoot=fileURLToPath(new URL('../../',import.meta.url));
const fuseWire=(wire='101100011',version=1,length=wire.length)=>Buffer.concat([Buffer.from('header-dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),Buffer.from([version,length]),Buffer.from(wire)]);
test('session-account packaging verifies the disabled cookie-encryption fuse without changing runtime bytes',()=>{
 const bytes=fuseWire(),before=Buffer.from(bytes);
 assert.deepEqual(requireUnencryptedCookieStore(bytes),{version:1,wire:'101100011',cookieEncryption:false});
 assert.deepEqual(bytes,before);
});
test('session-account packaging rejects encrypted, unknown, ambiguous and incomplete fuse layouts',()=>{
 for(const bytes of [fuseWire('111100011'),fuseWire('1r1100011'),fuseWire('101100011',2),fuseWire('10',1,9),fuseWire('1'),fuseWire('10?'),Buffer.from('missing'),Buffer.concat([fuseWire(),fuseWire()])])assert.throws(()=>requireUnencryptedCookieStore(bytes));
});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-support-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
function write(root,relative,bytes){const filename=path.join(root,relative);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);return filename;}
function json(root,relative,value){return write(root,relative,JSON.stringify(value));}
function dependency(root,relative,name,{license=true,dependencies={}}={}){
 json(root,`${relative}/package.json`,{name,version:'1.2.3',exports:{'./subpath':'./subpath.js'},dependencies});
 write(root,`${relative}/subpath.js`,'export const example = true;');
 if(license)write(root,`${relative}/LICENSE-MIT`,'Example distributable license notice.');
}

test('release metadata is constrained before constructing version paths or bundle identifiers',()=>{
 assert.deepEqual(validateRelease({schemaVersion:1,version:'0.1.0-preview.1',buildNumber:1,bundleId:'org.asmagicbrain.preview'}),{schemaVersion:1,version:'0.1.0-preview.1',buildNumber:1,bundleId:'org.asmagicbrain.preview'});
 for(const changed of [{version:'../old'},{version:'1.2'},{buildNumber:0},{buildNumber:1.5},{bundleId:'org.example/other'},{schemaVersion:2}])assert.throws(()=>validateRelease({schemaVersion:1,version:'1.0.0',buildNumber:1,bundleId:'org.example',...changed}),/Invalid/);
});

test('metadata revisions derive separate immutable source tags without changing product version', () => {
 const original={schemaVersion:1,version:'0.2.11',buildNumber:32,bundleId:'org.asmagicbrain.preview'};
 const reissue={...original,buildNumber:33,metadataRevision:1};
 assert.deepEqual(validateRelease(reissue),reissue);
 assert.equal(releaseSourceTag(original),'native-v0.2.11');
 assert.equal(releaseSourceTag(reissue),'native-v0.2.11-metadata.1');
 assert.equal(releaseSourceTag({...original,metadataRevision:2}),'native-v0.2.11-metadata.2');
 for(const metadataRevision of [undefined,null,0,-1,1.5,'1',true,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateRelease({...original,metadataRevision}),/Invalid/);
 for(const changed of [{version:'0.2.11\n'},{bundleId:'org.asmagicbrain.preview\n'}])assert.throws(()=>validateRelease({...original,...changed}),/Invalid/);
 for(const tag of ['native-v0.2.11','native-v0.2.11-metadata.1','native-v0.2.11-metadata.23'])assert.equal(releaseTagMatchesVersion(tag,original.version),true,tag);
 for(const tag of ['native-v0.2.10-metadata.1','native-v0.2.11-metadata.0','native-v0.2.11-metadata.01','native-v0.2.11-metadata.-1','native-v0.2.11-metadata.1.0','native-v0.2.11-metadata.9007199254740992','native-v0.2.11-metadata.1\n','native-v0.2.11\n','refs/tags/native-v0.2.11','native-v0.2.11-metadata.1/other'])assert.equal(releaseTagMatchesVersion(tag,original.version),false,tag);
 assert.equal(releaseTagMatchesVersion('native-v0.2.11\n','0.2.11\n'),false);
});

test('official helper without executable metadata resolves only its single physical executable',t=>{
 const root=fixture(t),bundle=path.join(root,'Helper.app');
 const executable=write(root,'Helper.app/Contents/MacOS/Electron Helper','example');fs.chmodSync(executable,0o755);
 assert.equal(bundleExecutable(bundle,undefined),'Electron Helper');
 assert.equal(bundleExecutable(bundle,'Electron Helper'),'Electron Helper');
 write(root,'Helper.app/Contents/MacOS/second','another');
 assert.throws(()=>bundleExecutable(bundle,undefined),/ambiguous/);
 assert.throws(()=>bundleExecutable(bundle,'../other'),/ambiguous/);
 fs.chmodSync(executable,0o644);assert.throws(()=>bundleExecutable(bundle,'Electron Helper'),/not executable/);
});

test('source closure follows imports, reexports, dynamic imports, preload require and physical worker URLs',t=>{
 const root=fixture(t);
 write(root,'apps/native/main.mjs',"import fs from 'node:fs'; import {app} from 'electron'; import '../../packages/host/entry.mjs'; new URL('./', import.meta.url); new URL('../../../../asMagicBrain-Test/', import.meta.url);");
 write(root,'apps/native/preload.cjs',"const {contextBridge}=require('electron');");
 write(root,'packages/host/entry.mjs',"export {value} from './value.mjs'; const later=()=>import('./late.mjs'); new URL('./worker.mjs', import.meta.url);");
 write(root,'packages/host/value.mjs','export const value=1;');
 write(root,'packages/host/late.mjs','export default 2;');
 write(root,'packages/host/worker.mjs',"import './value.mjs';");
 write(root,'packages/host/unreferenced.test.mjs',"throw Error('must not ship');");
 assert.deepEqual(runtimeClosure(root),['apps/native/main.mjs','apps/native/preload.cjs','packages/host/entry.mjs','packages/host/late.mjs','packages/host/value.mjs','packages/host/worker.mjs']);
});

test('closure refuses computed dependencies and undeclared runtime package imports',t=>{
 const root=fixture(t);write(root,'apps/native/preload.cjs',"require('electron');");
 for(const source of ["const file='./later.mjs'; import(file);","import 'unbundled';","const file='./worker.mjs'; new URL(file,import.meta.url);","import '../../docs/example.mjs';"]){
  write(root,'apps/native/main.mjs',source);assert.throws(()=>runtimeClosure(root),/Computed|Unbundled|Unadmitted/);
 }
});

test('inventory preserves internal framework links while excluding external source links and parent escapes',t=>{
 const root=fixture(t),bundle=path.join(root,'Example.app');
 write(root,'Example.app/Contents/Framework.framework/Versions/A/binary',Buffer.from([0,1,255]));
 fs.symlinkSync('A',path.join(bundle,'Contents/Framework.framework/Versions/Current'));
 const entries=inventory(bundle,{internalLinks:true});
 assert.equal(entries.find(item=>item.path.endsWith('/binary')).sha256,sha256(Buffer.from([0,1,255])));
 assert.deepEqual(entries.find(item=>item.type==='symlink'),{path:'Contents/Framework.framework/Versions/Current',mode:process.platform==='linux'?0o777:0o755,type:'symlink',target:'A'});
 assert.throws(()=>assertPhysical(bundle,root,{directory:true}),/escaped/);
 fs.symlinkSync(root,path.join(bundle,'outside'));
 assert.throws(()=>inventory(bundle,{internalLinks:true}),/External/);
 assert.throws(()=>assertPhysical(bundle,path.join(bundle,'outside'),{directory:true}),/physical/);
});

test('license collection includes both application roots, subpath-only packages and nested versions without dev tooling',t=>{
 const root=fixture(t);
 json(root,'package.json',{dependencies:{alpha:'1.2.3'},devDependencies:{'dev-only':'1'}});
 json(root,'ui-workshop/package.json',{dependencies:{beta:'1.2.3'}});
 dependency(root,'node_modules/alpha','alpha',{dependencies:{shared:'1.2.3'}});
 dependency(root,'node_modules/shared','shared');
 dependency(root,'ui-workshop/node_modules/beta','beta',{dependencies:{shared:'1.2.3'}});
 dependency(root,'ui-workshop/node_modules/shared','shared');
 const notices=dependencyNotices(root);
 assert.deepEqual(notices.map(item=>item.name).sort(),['alpha','beta','shared','shared']);
 assert.equal(new Set(notices.filter(item=>item.name==='shared').map(item=>item.location)).size,2);
 assert.ok(notices.every(item=>item.filename==='LICENSE-MIT'));
});

test('missing license requires an exact version notice with matching recorded bytes',t=>{
 const root=fixture(t);json(root,'package.json',{dependencies:{alpha:'1.2.3'}});json(root,'ui-workshop/package.json',{});
 dependency(root,'node_modules/alpha','alpha',{license:false});
 assert.throws(()=>dependencyNotices(root),/Missing distributable license/);
 const bytes='Exact upstream license text.\n';write(root,'apps/native/licenses/alpha-1.2.3.txt',bytes);
 json(root,'apps/native/licenses/provenance.json',{schemaVersion:1,licenses:[{name:'alpha',version:'1.2.3',file:'alpha-1.2.3.txt',sourceUrl:'https://example.invalid/upstream/commit/LICENSE',sha256:sha256(bytes)}]});
 assert.equal(dependencyNotices(root)[0].sourceUrl,'https://example.invalid/upstream/commit/LICENSE');
 write(root,'apps/native/licenses/alpha-1.2.3.txt',bytes+'modified');
 assert.throws(()=>dependencyNotices(root),/hash differs/);
});

test('Linux search packaging retains verified musl and Rust notices and refuses incomplete provenance',t=>{
 const root=fixture(t);json(root,'package.json',{});json(root,'ui-workshop/package.json',{});
 const directory='apps/native/licenses',source=path.join(appRoot,directory);
 for(const file of ['ripgrep-provenance.json','ripgrep-15.0.0-third-party.txt','ripgrep-linux-x64-provenance.json','rust-1.88.0-library-COPYRIGHT.html','musl-1.2.3-COPYRIGHT.txt'])write(root,`${directory}/${file}`,fs.readFileSync(path.join(source,file)));
 const collect=()=>dependencyNotices(root,undefined,{platform:'linux',arch:'x64'});
 assert.deepEqual(collect().map(item=>item.filename),['THIRD-PARTY-NOTICES.txt','PROVENANCE.json','rust-1.88.0-library-COPYRIGHT.html','musl-1.2.3-COPYRIGHT.txt','PROVENANCE-linux-x64.json']);
 const provenance=JSON.parse(fs.readFileSync(path.join(source,'ripgrep-linux-x64-provenance.json')));
 json(root,`${directory}/ripgrep-linux-x64-provenance.json`,{...provenance,notices:provenance.notices.slice(0,1)});assert.throws(collect,/Invalid Linux/);
 json(root,`${directory}/ripgrep-linux-x64-provenance.json`,{...provenance,binarySha256:'0'.repeat(64)});assert.throws(collect,/Invalid Linux/);
 json(root,`${directory}/ripgrep-linux-x64-provenance.json`,provenance);write(root,`${directory}/musl-1.2.3-COPYRIGHT.txt`,'changed');assert.throws(collect,/notice bytes differ/);
});

test('current native closure contains every worker and profile module without build or development scaffolding',()=>{
 const files=runtimeClosure(appRoot);
 for(const relative of ['apps/native/main.mjs','apps/native/preload.cjs','apps/native/profile-paths.mjs','packages/source-foundation/src/adapters/filesystem-worker.mjs','packages/desktop-host/src/repository-runtime/file-management-worker.mjs','packages/desktop-host/src/repository-import/worker.mjs'])assert.ok(files.includes(relative),relative);
 assert.ok(files.every(relative=>!/(?:node_modules|\.storybook|\/tests\/|\.test\.|build\.mjs|package\.mjs)/.test(relative)));
 assert.deepEqual(files.filter(relative=>relative.endsWith('preload.cjs')),['apps/native/preload.cjs'],'only the main-window preload ships');
 assert.ok(files.every(relative=>!relative.includes('outline-window')&&!relative.includes('outline-preload')),'the integrated Outline has no native companion runtime');
});
