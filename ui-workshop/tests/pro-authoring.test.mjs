import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {history,undo} from '@codemirror/commands';
import {CompletionContext} from '@codemirror/autocomplete';
import {formatCommand,completionSource,relativeLink,insertTemplate} from '../src/pro-editor/authoring.ts';
function view(doc,from=0,to=doc.length,readOnly=false){const v={state:EditorState.create({doc,selection:{anchor:from,head:to},extensions:[markdown(),history(),EditorState.readOnly.of(readOnly)]}),composing:false,dispatch(spec){v.state=spec.state??v.state.update(spec).state;}};return v;}
for(const [kind,mark] of [['bold','**'],['italic','*'],['strike','~~'],['code','`']])test(`${kind} toggles selected content and undoes in one step`,()=>{const v=view('hello');formatCommand(kind)(v);assert.equal(v.state.doc.toString(),mark+'hello'+mark);formatCommand(kind)(v);assert.equal(v.state.doc.toString(),'hello');const whole=view(mark+'hello'+mark);formatCommand(kind)(whole);assert.equal(whole.state.doc.toString(),'hello');const one=view('hello');formatCommand(kind)(one);undo(one);assert.equal(one.state.doc.toString(),'hello');});
test('line formatting respects last line boundary and heading replacement',()=>{const v=view('first\nsecond\nthird',0,13);formatCommand('ordered')(v);assert.equal(v.state.doc.toString(),'1. first\n2. second\nthird');const h=view('## Title');formatCommand('heading3')(h);assert.equal(h.state.doc.toString(),'### Title');formatCommand('heading0')(h);assert.equal(h.state.doc.toString(),'Title');});
test('link selects destination and snippet placeholders are inserted',()=>{const v=view('title');formatCommand('link')(v);assert.equal(v.state.doc.toString(),'[title](destination)');assert.equal(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to),'destination');const t=view('');insertTemplate('table')(t);assert.match(t.state.doc.toString(),/\| Column 1 \| Column 2 \|/);});
test('readonly, composition and fenced code are protected',()=>{const v=view('hello',0,5,true);assert.equal(formatCommand('bold')(v),false);const c=view('hello');c.composing=true;assert.equal(insertTemplate('table')(c),false);const code=view('```js\nhello\n```',6,11);assert.equal(formatCommand('bold')(code),false);});
const source=completionSource(()=>['notes/Other file.md','assets/a(b)#.png','README.md'],()=> 'notes/current.md');
const complete=(doc,explicit=false)=>source(new CompletionContext(EditorState.create({doc,extensions:[markdown()]}),doc.length,explicit));
test('local link paths are relative, encoded and image-filtered',()=>{assert.equal(relativeLink('notes/current.md','assets/a(b)#.png'),'../assets/a%28b%29%23.png');const links=complete('[Other](');assert.ok(links.options.some(o=>o.label==='Other%20file.md'));const images=complete('![image](');assert.deepEqual(images.options.map(o=>o.label),['../assets/a%28b%29%23.png']);});
test('snippets and fence languages are contextual, prose and code stay quiet',()=>{assert.equal(complete('ordinary prose'),null);assert.equal(complete('```js\n/table'),null);assert.ok(complete('```py').options.some(o=>o.label==='python'));assert.deepEqual(complete('/tab').options.map(o=>o.label),['table']);assert.ok(complete('',true).options.some(o=>o.label==='diagram'));});

test('italic adds to existing bold rather than stripping its markers',()=>{const v=view('**hello**');formatCommand('italic')(v);assert.equal(v.state.doc.toString(),'***hello***');});

test('formatting retains mixed source line endings and BOM through the shared session',async()=>{
 const {createFileSession}=await import('../src/repository-file-session.ts');const {createRepositoryDocumentSession}=await import('../src/repository-document-session.ts');
 const raw='\ufefffirst\r\nsecond\nthird\r';const file=createFileSession({documentId:'format',path:'a.md',sourceHash:'a'.repeat(64),text:raw,readOnly:false});const session=createRepositoryDocumentSession(file,{repositoryId:'r',revision:''},[markdown()]);
 session.dispatch([session.state.update({selection:{anchor:0,head:session.state.doc.length}})]);
 const v={get state(){return session.state;},composing:false,dispatch(spec){session.dispatch([spec.startState?spec:session.state.update(spec)]);}};
 formatCommand('bold')(v);assert.ok(file.buffer.getRawText().includes('first\r\nsecond\nthird\r'));undo(v);assert.equal(file.buffer.getRawText(),raw);
});

test('link command selects an existing destination without nesting',()=>{const v=view('[hello](other.md)',2,2);formatCommand('link')(v);assert.equal(v.state.doc.toString(),'[hello](other.md)');assert.equal(v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to),'other.md');});
