import test from 'node:test';
import assert from 'node:assert/strict';
import {searchSelection} from '../src/workspace-navigation.ts';

test('saved search selection uses UTF-16 columns for emoji and Unicode',()=>{
 const text='Intro\n😀 café Ω\n';const target={repo:'Workspace',path:'note.md',line:2,column:4,endColumn:8,lineText:'😀 café Ω\n'};
 const selected=searchSelection(text,target);assert.equal(text.slice(selected.from,selected.to),'café');
});
test('changed saved lines never select a misleading range in a retained draft',()=>{
 const target={repo:'Workspace',path:'note.md',line:2,column:1,endColumn:5,lineText:'Saved value'};
 assert.equal(searchSelection('Intro\nPrivate draft value',target),null);
 assert.equal(searchSelection('Intro',target),null);
});
test('CRLF result lines map to current normalized editor lines without changing text',()=>{
 const text='One\nTwo café\n';const selected=searchSelection(text,{repo:'Workspace',path:'note.md',line:2,column:5,endColumn:9,lineText:'Two café\r\n'});
 assert.equal(text.slice(selected.from,selected.to),'café');
});
