import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExplorerTree, selectedRoots, canMoveSelection, moveSelectionProblem, externalDropDestination, directFolderDropDestination, activeDirectDropDestination, renameProblem} from '../src/repository-explorer-model.ts';

test('flat entries become folders-first trees with unloaded parent folders and stable path identities', () => {
  const entries = [{path:'README.md',type:'file'},{path:'docs/z.md',type:'file'},{path:'empty',type:'directory'},{path:'docs/a.md',type:'file'},{path:'__proto__/safe.md',type:'file'}];
  const before = JSON.stringify(entries), tree = buildExplorerTree(entries);
  assert.deepEqual(tree.map(node => node.path), ['__proto__','docs','empty','README.md']);
  assert.deepEqual(tree.find(node => node.path === 'docs').children.map(node => node.id), ['docs/a.md','docs/z.md']);
  assert.deepEqual(tree.find(node => node.path === 'empty').children, []);
  assert.equal(tree.find(node => node.path === 'README.md').children, undefined);
  assert.equal(JSON.stringify(entries), before);
});

test('tree construction ignores invalid paths and keeps dotted filenames', () => {
  const tree = buildExplorerTree(['','/abs','a//b','../out','a\\b','.gitignore','a.b'].map(path => ({path,type:'file'})));
  assert.deepEqual(tree.map(node => node.path), ['.gitignore','a.b']);
});

test('multiselect host commands suppress duplicate and covered descendant paths', () => {
  assert.deepEqual(selectedRoots(['docs/a.md','README.md','docs','docs/a.md','docs-old/a.md']), ['README.md','docs','docs-old/a.md']);
  assert.deepEqual(selectedRoots(['docs/a.md','docs/b.md']), ['docs/a.md','docs/b.md']);
});

test('drop validation rejects self, descendant, and same-directory moves without confusing prefixes', () => {
  assert.equal(canMoveSelection(['docs'], 'docs/sub'), false);
  assert.equal(canMoveSelection(['docs'], 'docs'), false);
  assert.equal(canMoveSelection(['docs/a.md'], 'docs'), false);
  assert.equal(canMoveSelection(['docs/a.md','notes/b.md'], 'docs'), false);
  assert.equal(canMoveSelection(['docs'], 'docs-old'), true);
  assert.equal(canMoveSelection(['docs/a.md'], ''), true);
  assert.equal(canMoveSelection([], ''), false);
});

test('inline rename changes a basename and leaves final filesystem validation to the host', () => {
  for (const name of ['','..','.','a/b','a\\b','a\nb']) assert.equal(typeof renameProblem(name), 'string');
  for (const name of ['readme.md','研究.md','.gitignore','two words.md']) assert.equal(renameProblem(name), null);
});

test('move feedback accepts root and distinct folders without treating sibling prefixes as descendants', () => {
  const entries=new Map(['docs','docs-old','target'].map(path=>[path,{path,type:'directory'}]));
  entries.set('docs/研究.md',{path:'docs/研究.md',type:'file'});
  const before=JSON.stringify([...entries]);
  assert.equal(moveSelectionProblem(['docs/研究.md'],'',entries),null);
  assert.equal(moveSelectionProblem(['docs','docs/研究.md'],'docs-old',entries),null);
  assert.match(moveSelectionProblem(['docs'],'docs',entries),/itself/);
  assert.match(moveSelectionProblem(['docs/研究.md'],'docs',entries),/already in/);
  assert.match(moveSelectionProblem(['docs'],'docs/研究.md',entries),/existing destination folder/);
  assert.match(moveSelectionProblem(['vanished.md'],'target',entries),/no longer available/);
  assert.equal(JSON.stringify([...entries]),before);
});

test('advisory move collision checks cover existing targets and two selected matching basenames', () => {
  const items=[{path:'left',type:'directory'},{path:'right',type:'directory'},{path:'target',type:'directory'},
    {path:'left/note.md',type:'file'},{path:'right/note.md',type:'file'},{path:'target/note.md',type:'file'}];
  const entries=new Map(items.map(item=>[item.path,item]));
  assert.match(moveSelectionProblem(['left/note.md'],'target',entries),/already in the destination/);
  entries.delete('target/note.md');
  assert.match(moveSelectionProblem(['left/note.md','right/note.md'],'target',entries),/already in the destination/);
  assert.equal(moveSelectionProblem(['left/note.md'],'target',entries),null);
});

test('external copy destination distinguishes folder, file parent, root and vanished rows', () => {
  const entries=new Map([{path:'docs',type:'directory'},{path:'docs/note.md',type:'file'},{path:'README.md',type:'file'}].map(item=>[item.path,item]));
  assert.equal(externalDropDestination('docs',entries),'docs');
  assert.equal(externalDropDestination('docs/note.md',entries),'docs');
  assert.equal(externalDropDestination('README.md',entries),'');
  assert.equal(externalDropDestination(null,entries),'');
  assert.equal(externalDropDestination('',entries),'');
  assert.equal(externalDropDestination('missing',entries),null);
});

test('native hover synchronization only selects a real folder center, leaving edge and file semantics to Arborist', () => {
  const entries=new Map([{path:'folder',type:'directory'},{path:'folder/file.md',type:'file'}].map(item=>[item.path,item]));
  for(const y of [9,16,23])assert.equal(directFolderDropDestination('folder',y,32,entries),'folder');
  for(const y of [-1,0,8,24,32,33,NaN])assert.equal(directFolderDropDestination('folder',y,32,entries),null);
  for(const path of ['folder/file.md','missing',null,''])assert.equal(directFolderDropDestination(path,16,32,entries),null);
  for(const height of [0,-1,Infinity,NaN])assert.equal(directFolderDropDestination('folder',16,height,entries),null);
  assert.equal(directFolderDropDestination('folder',16,64,entries),null);
  assert.equal(directFolderDropDestination('folder',32,64,entries),'folder');
});

test('direct visual hover belongs only to the active drag and preserves the explicit root destination', () => {
  const folder={dragId:'source/file.md',destination:'target'},root={...folder,destination:''};
  assert.equal(activeDirectDropDestination(folder,'source/file.md'),'target');
  assert.equal(activeDirectDropDestination(root,'source/file.md'),'');
  for(const dragId of [null,undefined,'','another/file.md'])assert.equal(activeDirectDropDestination(folder,dragId),null);
  assert.equal(activeDirectDropDestination(null,'source/file.md'),null);
  assert.deepEqual(folder,{dragId:'source/file.md',destination:'target'});
});
