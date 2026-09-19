import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryMenuActions,suggestDuplicateRepositoryName} from '../src/catalog-management.ts';

test('repository actions keep a renamed managed default recoverable and distinguish missing capabilities',()=>{
  const options={defaultRepository:'MyWorkspace',manage:true,reveal:true};
  const mandatory=repositoryMenuActions('MyWorkspace',options),ordinary=repositoryMenuActions('Notes',options);
  assert.equal(mandatory.find(item=>item.id==='trash').disabled,true);
  assert.equal(mandatory.find(item=>item.id==='trash').unavailable,false);
  assert.equal(ordinary.find(item=>item.id==='trash').disabled,false);
  assert.equal(ordinary.find(item=>item.id==='move').disabled,true);
  assert.equal(ordinary.find(item=>item.id==='move').unavailable,true);
  assert(ordinary.every(item=>repositoryMenuActions('Notes',{...options,busy:true}).find(next=>next.id===item.id).disabled));
});

test('implemented repository actions stay visible when disabled by context or a missing host capability',()=>{
  for(const options of [{manage:false,reveal:false},{manage:true,reveal:true,busy:true}]){
    const actions=repositoryMenuActions('Workspace',{defaultRepository:'Workspace',...options});
    for(const id of ['rename','duplicate','reveal','trash']){
      const action=actions.find(item=>item.id===id);
      assert.equal(action.disabled,true,`${id} is unavailable in this context`);
      assert.equal(action.unavailable,false,`${id} remains an implemented feature`);
    }
    assert.equal(actions.find(item=>item.id==='move').unavailable,true);
  }
});

test('duplicate names avoid case-insensitive collisions without exceeding host name length',()=>{
  const repository='A'.repeat(100),suggested=suggestDuplicateRepositoryName(repository,[]);
  assert.equal(suggested.length,100);assert(suggested.endsWith('-copy'));
  const next=suggestDuplicateRepositoryName(repository,[suggested.toLowerCase()]);
  assert.equal(next.length,100);assert(next.endsWith('-copy-2'));
  assert.equal(suggestDuplicateRepositoryName('Notes',['notes-copy','NOTES-COPY-2']),'Notes-copy-3');
});

test('read-only docs keep Open, Reveal and editable-copy Duplicate while destructive commands are disabled',()=>{
  const actions=repositoryMenuActions('asMagicBrain-Docs',{defaultRepository:'Workspace',readOnly:true,manage:true,reveal:true,move:true});
  for(const id of ['rename','move','trash'])assert.equal(actions.find(item=>item.id===id).disabled,true);
  for(const id of ['open','duplicate','reveal'])assert.equal(actions.find(item=>item.id===id).disabled,false);
});
