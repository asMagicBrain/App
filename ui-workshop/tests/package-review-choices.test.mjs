import test from 'node:test';import assert from 'node:assert/strict';
import {selectNonconflictingUpdates} from '../src/package-review-choices.mjs';
test('bulk update review protects conflicts, removals, private drafts and manual choices',()=>{
 const rows=[{path:'new.md',action:'add',choices:['keep-current','use-incoming']},{path:'updated.md',action:'update',choices:['keep-current','use-incoming']},{path:'deleted.md',action:'remove',choices:['keep-current','use-incoming']},{path:'conflict.md',action:'conflict',conflict:true,choices:['keep-current','use-incoming','keep-both']},{path:'draft.md',action:'update',protectedDraft:true,choices:['keep-current']},{path:'manual.md',action:'update',choices:['keep-current','use-incoming']}];
 const current={'manual.md':'keep-current'};
 assert.deepEqual(selectNonconflictingUpdates(rows,current),{'manual.md':'keep-current','new.md':'use-incoming','updated.md':'use-incoming','draft.md':'keep-current'});assert.deepEqual(current,{'manual.md':'keep-current'});
 assert.deepEqual(selectNonconflictingUpdates(rows,{'conflict.md':'keep-both'}),{'conflict.md':'keep-both','new.md':'use-incoming','updated.md':'use-incoming','draft.md':'keep-current','manual.md':'use-incoming'});
});
