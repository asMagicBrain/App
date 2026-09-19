import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRepositoryCatalog, importRepositoryArchive, suggestRepositoryName, validateRepositoryName} from '../src/repository-catalog.ts';

const catalog={organization:'asMagicBrain',capability:'local-import-capability',repositories:[{name:'Workspace',privateRepo:true}],limits:{archiveBytes:1024}};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('repository catalog reads live entries and rejects an unavailable or incompatible service',async()=>{
  let request;
  assert.deepEqual(await loadRepositoryCatalog(async(url,options)=>{request={url,options};return json(catalog);}),catalog);
  assert.equal(request.url,'/__repository-import');assert.equal(request.options.cache,'no-store');
  for(const body of [null,{}, {...catalog,organization:'other'}, {...catalog,capability:''}, {...catalog,repositories:[{name:'Unknown'}]}, {...catalog,limits:{archiveBytes:0}}]) {
    await assert.rejects(loadRepositoryCatalog(async()=>json(body)),/catalog is unavailable/);
  }
  await assert.rejects(loadRepositoryCatalog(async()=>new Response('<html>not the local service</html>')),/service is unavailable/);
});

test('ZIP import sends original file bytes once with the catalog capability',async()=>{
  const file=new File([new Uint8Array([80,75,3,4,0,255,17])],'example-main.zip',{type:'application/zip'});
  const result={name:'example',organization:'asMagicBrain',head:'a'.repeat(40),files:1,bytes:7,excludedEntries:0};
  const calls=[];
  const value=await importRepositoryArchive(file,'example',catalog,async(url,options)=>{calls.push({url,options});return json({ok:true,value:result});});
  assert.deepEqual(value,result);assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/__repository-import?name=example');
  assert.equal(calls[0].options.headers['Content-Type'],'application/zip');
  assert.equal(calls[0].options.headers['X-asMagicBrain-Capability'],catalog.capability);
  assert.equal(calls[0].options.body,file);assert.equal(calls[0].options.method,'POST');
});

test('invalid ZIP submissions do not send a mutation and name conflicts remain retryable',async()=>{
  const zip=new File(['test'],'example.zip');
  const unexpected=async()=>assert.fail('Invalid import must not reach the host');
  for(const name of ['', '../outside', '/absolute', '.hidden', 'name/', 'name.', 'a'.repeat(101)]) {
    assert.equal(typeof validateRepositoryName(name),'string');
    await assert.rejects(importRepositoryArchive(zip,name,catalog,unexpected));
  }
  await assert.rejects(importRepositoryArchive(new File(['test'],'example.txt'),'example',catalog,unexpected),/ZIP archive/);
  await assert.rejects(importRepositoryArchive(new File([],'example.zip'),'example',catalog,unexpected),/empty/);
  await assert.rejects(importRepositoryArchive(new File([new Uint8Array(1025)],'example.zip'),'example',catalog,unexpected),/size limit/);
  let count=0;
  await assert.rejects(importRepositoryArchive(zip,'example',catalog,async()=>{count++;return json({ok:false,error:{code:'NAME_CONFLICT',message:'Choose another repository name.'}},409);}),error=>error.code==='NAME_CONFLICT'&&/another repository name/.test(error.message));
  assert.equal(count,1,'Rejected imports are not retried automatically');
});

test('ZIP names are suggested without GitHub branch suffixes and response identity is checked',async()=>{
  assert.equal(suggestRepositoryName('example-main.zip'),'example');
  assert.equal(suggestRepositoryName('Example-master.ZIP'),'Example');
  assert.equal(suggestRepositoryName('Project notes.zip'),'Project-notes');
  assert.equal(suggestRepositoryName('archive-feature.zip'),'archive-feature');
  assert.equal(validateRepositoryName('my.project_1-archive'),null);
  await assert.rejects(importRepositoryArchive(new File(['test'],'example.zip'),'example',catalog,async()=>json({ok:true,value:{name:'wrong',organization:'asMagicBrain'}})),/response could not be verified/);
});
