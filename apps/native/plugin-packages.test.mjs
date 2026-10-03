import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createNativeService} from './host-service.mjs';
import {createPluginPackage, inspectPluginPackage} from '../../packages/desktop-host/src/plugin-packages/format.mjs';
import {createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {readZipFiles} from '../../packages/desktop-host/src/zip-import/index.mjs';

function manifest(version='1.0.0', hostApi={min:1,max:1}) { return {
  format:'asMagicBrain-plugin',schemaVersion:1,id:'org.example.course-templates',name:'Course templates',version,
  publisher:{id:'org.example',name:'Example Publisher',website:'https://example.org'},hostApi,
  execution:{kind:'declarative'},permissions:[],resources:[{id:'org.example.course-templates.starter',type:'markdown-template',path:'content/starter.md',title:'Starter'}],signature:null,
}; }
function plugin(version='1.0.0', text='# Starter\n', hostApi={min:1,max:1}) {
  return createPluginPackage({manifest:manifest(version,hostApi),resources:[{path:'content/starter.md',bytes:Buffer.from(text)}]});
}
function fixture(t,hooks={}) {
  const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'plugin-packages-')),dataRoot=path.join(parent,'data');let service;
  t.after(async()=>{await service?.close();fs.rmSync(parent,{recursive:true,force:true});});
  return {dataRoot,get service(){return service;},async open(nextHooks=hooks){service=await createNativeService({dataRoot,hooks:nextHooks});return service;},async restart(nextHooks={}){await service.close();service=await createNativeService({dataRoot,hooks:nextHooks});return service;}};
}

test('plugin package inspection validates exact declarative bytes without installing', async t => {
  const f=fixture(t),service=await f.open(),bytes=plugin(),before=fs.readdirSync(path.join(f.dataRoot,'workspaces/asMagicBrain'));
  const result=await service.inspectPluginPackage({bytes});
  assert.equal(result.compatible,true);assert.equal(result.manifest.execution.kind,'declarative');assert.equal(result.manifest.signature,null);
  assert.deepEqual(await service.listPluginPackages(),[]);assert.deepEqual(fs.readdirSync(path.join(f.dataRoot,'workspaces/asMagicBrain')),before);
});

test('install, enable, upgrade, rollback and uninstall persist across restart', async t => {
  const f=fixture(t),service=await f.open(),first=plugin(),second=plugin('1.1.0','# Revised\n');
  let installed=await service.installPluginPackage({bytes:first,requestId:randomUUID()});
  assert.equal(installed.current.version,'1.0.0');assert.equal(installed.enabled,false);
  await service.setPluginPackageEnabled({pluginId:manifest().id,enabled:true});await f.restart();
  assert.deepEqual((await f.service.listPluginPackages()).map(item=>[item.version,item.enabled,item.rollbackAvailable]),[['1.0.0',true,false]]);
  installed=await f.service.installPluginPackage({bytes:second,requestId:randomUUID()});
  assert.equal(installed.current.version,'1.1.0');assert.equal(installed.previous.version,'1.0.0');assert.equal(installed.enabled,true);
  const rollbackId=randomUUID();let rolled=await f.service.rollbackPluginPackage({pluginId:manifest().id,requestId:rollbackId});
  assert.equal(rolled.current.version,'1.0.0');assert.equal(rolled.previous.version,'1.1.0');
  rolled=await f.service.rollbackPluginPackage({pluginId:manifest().id,requestId:rollbackId});assert.equal(rolled.current.version,'1.0.0');
  const readopted=await f.service.installPluginPackage({bytes:second,requestId:randomUUID()});assert.equal(readopted.current.version,'1.1.0');
  await assert.rejects(f.service.installPluginPackage({bytes:plugin('1.1.0','# Different bytes\n'),requestId:randomUUID()}),{code:'PLUGIN_PACKAGE_CONFLICT'});
  const uninstallId=randomUUID();assert.equal((await f.service.uninstallPluginPackage({pluginId:manifest().id,requestId:uninstallId})).uninstalled,true);
  assert.deepEqual(await f.service.listPluginPackages(),[]);await f.restart();assert.deepEqual(await f.service.listPluginPackages(),[]);
  assert.equal(fs.existsSync(path.join(f.dataRoot,'workspaces/asMagicBrain/Workspace/plugins')),false);
});

test('package admission rejects incompatible, corrupt, executable and undeclared content', async () => {
  assert.equal(inspectPluginPackage(plugin('1.0.0','# A\n',{min:2,max:2})).compatible,false);
  const valid=readZipFiles(plugin(),{stripRoot:false}).files;
  const corrupt=createPackageZip(valid.map(item=>item.path==='content/starter.md'?{path:item.path,bytes:Buffer.from('# Changed\n')}:item));
  assert.throws(()=>inspectPluginPackage(corrupt),{code:'PLUGIN_PACKAGE_INTEGRITY'});
  const executable=createPackageZip([{path:'manifest.json',bytes:Buffer.from('{}')},{path:'integrity.json',bytes:Buffer.from('{}')},{path:'content/run.js',bytes:Buffer.from('alert(1)')}]);
  assert.throws(()=>inspectPluginPackage(executable),{code:'PLUGIN_PACKAGE_UNSAFE'});
  const extra=createPackageZip([...valid,{path:'README.md',bytes:Buffer.from('extra')}]);
  assert.throws(()=>inspectPluginPackage(extra),{code:'PLUGIN_PACKAGE_UNSAFE'});
  const oversized=createPackageZip([{path:'manifest.json',bytes:Buffer.alloc(16*1024*1024+1)}]);
  assert.throws(()=>inspectPluginPackage(oversized),{code:'PLUGIN_PACKAGE_LIMIT'});
});

test('interrupted install is completed from the durable intent on restart', async t => {
  let armed=true;const f=fixture(t),service=await f.open({pluginPackageAt:point=>{if(armed&&point==='plugin-install-published'){armed=false;throw Error('interrupt install');}}});
  await assert.rejects(service.installPluginPackage({bytes:plugin(),requestId:randomUUID()}),/interrupt install/);
  await f.restart();assert.equal((await f.service.listPluginPackages())[0].version,'1.0.0');
});

test('interrupted uninstall is completed from the durable intent on restart', async t => {
  let armed=false;const f=fixture(t),service=await f.open({pluginPackageAt:point=>{if(armed&&point==='plugin-uninstall-retired'){armed=false;throw Error('interrupt uninstall');}}});
  await service.installPluginPackage({bytes:plugin(),requestId:randomUUID()});armed=true;
  await assert.rejects(service.uninstallPluginPackage({pluginId:manifest().id,requestId:randomUUID()}),/interrupt uninstall/);
  await f.restart();assert.deepEqual(await f.service.listPluginPackages(),[]);
});

test('installed package path replacement is refused without following an alias', async t => {
  const f=fixture(t),service=await f.open();await service.installPluginPackage({bytes:plugin(),requestId:randomUUID()});
  const [{digest}]=await service.listPluginPackages(),base=path.join(f.dataRoot,'state/native/.asmb-plugin-packages/installed',manifest().id),version=path.join(base,digest),preserved=path.join(base,'preserved');
  fs.renameSync(version,preserved);fs.symlinkSync(preserved,version);
  await assert.rejects(service.listPluginPackages(),{code:'PLUGIN_PACKAGE_RECOVERY_REQUIRED'});
  assert.equal(fs.readFileSync(path.join(preserved,'package.asmbplugin')).length,plugin().length);
});

test('committed Pro Editor package has the exact trusted binding identity', () => {
  const filename=new URL('../../packages/pro-editor-plugin/asMagicBrain-Pro-Editor-0.1.0.asmbplugin',import.meta.url),result=inspectPluginPackage(fs.readFileSync(filename));
  assert.equal(result.manifest.id,'asmagicbrain.pro-editor');assert.equal(result.manifest.version,'0.1.0');assert.equal(result.manifest.publisher.id,'asmagicbrain.plugins');
  assert.equal(result.digest,'089d829a2550464662a50642c1e84504209d38affc278a4044e8587e19aa5344');assert.deepEqual(result.manifest.permissions,[]);assert.equal(result.manifest.execution.kind,'declarative');
});

test('replacing the host preserves enabled asTeach, legacy editor archives and course files', async t => {
  const f=fixture(t),service=await f.open();
  const teach=createPluginPackage({manifest:JSON.parse(fs.readFileSync(new URL('../../packages/asteach-plugin/manifest.json',import.meta.url),'utf8')),resources:[{path:'content/about.txt',bytes:fs.readFileSync(new URL('../../packages/asteach-plugin/about.txt',import.meta.url))}]});
  const pro=fs.readFileSync(new URL('../../packages/pro-editor-plugin/asMagicBrain-Pro-Editor-0.1.0.asmbplugin',import.meta.url));
  const teachIdentity=inspectPluginPackage(teach).manifest.id;
  await service.installPluginPackage({bytes:teach,requestId:randomUUID()});
  await service.installPluginPackage({bytes:pro,requestId:randomUUID()});
  await service.setPluginPackageEnabled({pluginId:teachIdentity,enabled:true});
  const filename=path.join(f.dataRoot,'workspaces/asMagicBrain/Workspace/course.md');
  fs.writeFileSync(filename,'# Preserved course\n\nLocal course content.\n');
  const before=(await service.listPluginPackages()).map(entry=>({id:entry.id,digest:entry.digest,enabled:entry.enabled}));
  await f.restart();
  assert.deepEqual((await f.service.listPluginPackages()).map(entry=>({id:entry.id,digest:entry.digest,enabled:entry.enabled})),before);
  assert.equal(fs.readFileSync(filename,'utf8'),'# Preserved course\n\nLocal course content.\n');
});
