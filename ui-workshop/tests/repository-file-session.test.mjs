import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileSession,createMediaSession,isReadOnlyMediaSession,createNewFileSession,replaceFileSession,confirmedDiscardSession,completeNewDraftCleanup,fileModes,hasFileChanges,validateFilePath} from '../src/repository-file-session.ts';
import {createLocalWorkspaceClient} from '../src/local-workspace-client.ts';
import {remapSessions} from '../src/repository-management.ts';

test('media classification survives rename without replacing retained text drafts or treating empty media buffers as text',()=>{
 const text=createFileSession({path:'notes.txt',documentId:'text',sourceHash:'a'.repeat(64),text:'saved',readOnly:false});
 text.buffer.applyChanges([{from:5,to:5,insert:' retained draft'}]);const buffer=text.buffer;
 remapSessions([text],[{from:'notes.txt',to:'notes.png'}]);
 assert.equal(isReadOnlyMediaSession(text,true),true);assert.equal(text.buffer,buffer);assert.equal(text.buffer.getRawText(),'saved retained draft');
 remapSessions([text],[{from:'notes.png',to:'notes.txt'}]);
 assert.equal(isReadOnlyMediaSession(text,true),false);assert.equal(text.id,'text');assert.equal(text.buffer,buffer);
 const media=createMediaSession('overlay.png');remapSessions([media],[{from:'overlay.png',to:'overlay.txt'}]);
 assert.equal(media.readOnly,true);assert.equal(isReadOnlyMediaSession(media,true),true);assert.equal(media.sourceHash,null);
 const proposed=createNewFileSession('unsaved','proposal.png','private draft');
 assert.equal(isReadOnlyMediaSession(proposed,true),false);assert.equal(proposed.buffer.getRawText(),'private draft');
});

test('file view offers rendered preview only for Markdown and plain files retain Code',()=>{
 assert.deepEqual(fileModes('docs/readme.MD',false),['preview','source']);
 assert.deepEqual(fileModes('docs/readme.md',true),['source','preview']);
 for(const path of ['LICENSE','notes.txt','main.ts','image.png'])assert.deepEqual(fileModes(path,false),['source']);
});
test('file sessions retain raw BOM and mixed separators through edit, save and undo',()=>{
 const raw='\ufeff# Heading\r\nFirst\nLast\r';
 const session=createFileSession({path:'note.md',documentId:'doc',sourceHash:'a'.repeat(64),text:raw,readOnly:false});
 assert.equal(session.buffer.getText(),'# Heading\nFirst\nLast\n');
 assert.equal(session.buffer.getRawText(),raw);assert.equal(hasFileChanges(session),false);
 const before=session.buffer.captureHistory();
 session.buffer.applyChanges([{from:2,to:2,insert:'New '}]);
 assert.equal(session.buffer.getRawText(),'\ufeff# New Heading\r\nFirst\nLast\r');
 session.saved=session.buffer.getRawText();session.buffer.rebase(session.saved);
 session.buffer.applyChanges([{from:2,to:6,insert:''}],{history:'undo',restore:before});
 assert.equal(session.buffer.getRawText(),raw);assert.equal(hasFileChanges(session),true);
 session.proposedPath='archive/note.md';assert.equal(session.id,'doc');
});
test('restored new drafts have stable independent identities even with colliding paths',()=>{
 const one=createNewFileSession('draft-one','same.md','one');
 const two=createNewFileSession('draft-two','same.md','two');
 assert.notEqual(one.id,two.id);assert.equal(hasFileChanges(one),true);assert.equal(two.buffer.getRawText(),'two');
 assert.equal(validateFilePath('folder/new.md'),null);
 for(const path of ['', '../outside.md','/absolute.md','folder//file.md','.git/config','a/.asmagicbrain/b','x\\y.md'])assert.equal(typeof validateFilePath(path),'string');
});
test('workspace client binds local capability once and does not retry rejected mutations',async()=>{
 const calls=[];let failures=false;
 const request=async(url,options={})=>{calls.push({url,options});return new Response(JSON.stringify(options.method==='POST'?(failures?{ok:false,error:{code:'CONFLICT',message:'Source changed'}}:{ok:true,value:{status:'saved'}}):{capability:'test-capability',local:true,newDrafts:[]}),{status:failures&&options.method==='POST'?409:200,headers:{'Content-Type':'application/json'}});};
 const client=createLocalWorkspaceClient('Workspace',request);
 await client.bootstrap();await client.request('save',{path:'folder/note.md',baseHash:'hash',text:'\ufeffa\r\n'});
 assert.equal(calls.length,2);assert.equal(calls[1].options.headers['X-asMagicBrain-Capability'],'test-capability');
 assert.deepEqual(JSON.parse(calls[1].options.body),{repo:'Workspace',operation:'save',args:{path:'folder/note.md',baseHash:'hash',text:'\ufeffa\r\n'}});
 failures=true;await assert.rejects(client.request('save',{}),error=>error.code==='CONFLICT');assert.equal(calls.length,3);
});

// A newly saved file acquires a host document ID distinct from its draft ID.
test('discarding a newly saved file replaces the old draft session identity',()=>{
 const old=createNewFileSession('draft-id','new.md','saved');old.isNew=false;old.saved='saved';old.buffer.applyChanges([{from:5,to:5,insert:' discarded edit'}]);
 const reopened=createFileSession({path:'new.md',documentId:'host-id',sourceHash:'b'.repeat(64),text:'saved',readOnly:false});
 const sessions=new Map([[old.id,old]]);replaceFileSession(sessions,old,reopened);
 assert.equal(sessions.size,1);assert.equal([...sessions.values()].find(item=>item.path==='new.md').buffer.getRawText(),'saved');assert.equal([...sessions.values()].some(hasFileChanges),false);
});
test('new draft cleanup failure retains its retry marker after file publication',async()=>{
 const session=createNewFileSession('draft-id','new.md','saved');session.isNew=false;
 const calls=[];await assert.rejects(completeNewDraftCleanup(session,async id=>{calls.push(id);throw Error('Storage unavailable');}));
 assert.equal(session.draftId,'draft-id');await completeNewDraftCleanup(session,async id=>{calls.push(id);});
 assert.deepEqual(calls,['draft-id','draft-id']);assert.equal(session.draftId,undefined);
 await completeNewDraftCleanup(session,async()=>assert.fail('Completed cleanup must not run again'));
});

test('discard confirmation cannot follow a late file switch to another retained draft',()=>{
 const original=createNewFileSession('draft-a','a.md','keep a');
 const other=createNewFileSession('draft-b','b.md','keep b');
 const sessions=new Map([[original.id,original],[other.id,other]]);
 const confirmedId=original.id;
 assert.equal(confirmedDiscardSession(sessions,confirmedId,original.id),original);
 assert.throws(()=>confirmedDiscardSession(sessions,confirmedId,other.id),/selected file changed/);
 assert.equal(sessions.get('draft-a').buffer.getRawText(),'keep a');
 assert.equal(sessions.get('draft-b').buffer.getRawText(),'keep b');
 sessions.delete(original.id);
 assert.throws(()=>confirmedDiscardSession(sessions,confirmedId,original.id),/selected file changed/);
});
