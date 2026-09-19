import test from 'node:test';
import assert from 'node:assert/strict';
import {externalImportProblem,remapPath,remapSessions,uniqueCopyPath} from '../src/repository-management.ts';
import {createFileSession,createNewFileSession} from '../src/repository-file-session.ts';
test('external admission errors explain correction without replacing recovery instructions',()=>{
 assert.match(externalImportProblem({code:'SYMLINK_UNSUPPORTED',message:'SYMLINK_UNSUPPORTED'}),/Symbolic links/);
 assert.match(externalImportProblem({code:'IMPORT_TICKET_EXPIRED'}),/choose them again/);
 assert.match(externalImportProblem({code:'LIMIT_EXCEEDED'}),/fewer items or a shallower folder/);
 const recovery='Files were retained; recover the interrupted local operation before continuing.';
 assert.equal(externalImportProblem({code:'RECOVERY_REQUIRED',message:recovery}),recovery);
 assert.equal(externalImportProblem(new Error('Disk is full.')),'Disk is full.');
 assert.equal(externalImportProblem(null),'The files could not be imported. Try again.');
});
test('folder moves retain buffer identity, raw draft bytes, proposed rename and independent new drafts',()=>{
 const existing=createFileSession({path:'notes/a.md',documentId:'a',sourceHash:'a'.repeat(64),text:'\ufeff# Saved\r\n',readOnly:false});
 existing.buffer.applyChanges([{from:2,to:2,insert:'Draft '}]);existing.proposedPath='future-name.md';
 const raw=existing.buffer.getRawText(),buffer=existing.buffer,newDraft=createNewFileSession('new','notes/unsaved.md','keep');
 remapSessions([existing,newDraft],[{from:'notes',to:'archive/notes'}]);
 assert.equal(existing.path,'archive/notes/a.md');assert.equal(existing.proposedPath,'future-name.md');assert.equal(existing.buffer,buffer);assert.equal(existing.buffer.getRawText(),raw);assert.equal(existing.id,'a');assert.equal(newDraft.path,'notes/unsaved.md');
 assert.equal(remapPath('notes-other/a.md',[{from:'notes',to:'moved'}]),'notes-other/a.md');
});
test('duplicates preserve extension and choose collision-free adjacent names',()=>{
 assert.equal(uniqueCopyPath('a/report.pdf','file',new Set(['a/report copy.pdf'])),'a/report copy 2.pdf');
 assert.equal(uniqueCopyPath('a/folder.name','directory',new Set()),'a/folder.name copy');
 assert.equal(uniqueCopyPath('.gitignore','file',new Set()),'.gitignore copy');
});
