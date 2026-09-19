import test from 'node:test';
import assert from 'node:assert/strict';
import {orderRepositories,isRepositoryPinned} from '../src/repository-pins.ts';
import {documentationLast,isDocumentationRepository} from '../src/repository-capabilities.mjs';

test('managed default stays first, then pinned groups dominate either name sort',()=>{
  const rows=['Zulu','Alpha','Workspace','Notes10','Notes2'].map(name=>({name,privateRepo:true}));
  const before=JSON.stringify(rows);
  assert.deepEqual(orderRepositories(rows,'Workspace',['Zulu','Alpha']).map(x=>x.name),['Workspace','Alpha','Zulu','Notes2','Notes10']);
  assert.deepEqual(orderRepositories(rows,'Workspace',['Zulu','Alpha'],'desc').map(x=>x.name),['Workspace','Zulu','Alpha','Notes10','Notes2']);
  assert.equal(JSON.stringify(rows),before);
});

test('renamed default is mandatory and stale or duplicate pins never create rows',()=>{
  const rows=['Workspace','Renamed workspace','Alpha'].map(name=>({name}));
  assert.deepEqual(orderRepositories(rows,'Renamed workspace',['missing','Alpha','Alpha'],'desc').map(x=>x.name),['Renamed workspace','Alpha','Workspace']);
  assert.equal(isRepositoryPinned('Renamed workspace','Renamed workspace',[]),true);
  assert.equal(isRepositoryPinned('Workspace','Renamed workspace',[]),false);
  assert.equal(isRepositoryPinned('Alpha','Renamed workspace',['Alpha']),true);
});

test('filtering may omit the default without fabricating it or losing pin priority',()=>{
  const rows=[{name:'Archive'},{name:'Alpha'}];
  assert.deepEqual(orderRepositories(rows,'Workspace',['Archive']).map(x=>x.name),['Archive','Alpha']);
  assert.deepEqual(orderRepositories([],'Workspace',['Workspace']),[]);
});

test('official documentation stays last across name sorts, pins and filtered lists; names alone never grant the capability',()=>{
  const docs={name:'asMagicBrain-Docs-2',builtin:'documentation',readOnly:true},user={name:'asMagicBrain-Docs'},rows=[docs,{name:'Zulu'},user,{name:'Workspace'},{name:'Alpha'}];
  for(const order of ['asc','desc'])assert.equal(orderRepositories(rows,'Workspace',[docs.name,'Zulu'],order).at(-1),docs);
  assert.equal(orderRepositories(rows,docs.name,[docs.name],'desc').at(-1),docs);
  assert.equal(orderRepositories(rows.filter(item=>item.name.includes('Docs')),'Workspace',[docs.name],'desc').at(-1),docs);
  assert.deepEqual(documentationLast(rows),[rows[1],user,rows[3],rows[4],docs]);
  assert.equal(isDocumentationRepository(user),false);assert.equal(isDocumentationRepository({name:docs.name,readOnly:true}),false);
});
