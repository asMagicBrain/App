import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import {EditorState} from '@codemirror/state';
import {defaultKeymap} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {installComments} from '../../apps/desktop/ui/markdown-comments.mjs';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
import {buildDocumentOutline} from '../src/outline-model.ts';
import {findProVisualBlocks} from '../src/pro-editor/blocks.mjs';
import {analyzeReferences} from '../../apps/native/automation-validation-parser.mjs';
import {renderOffline} from '../../packages/desktop-host/src/package-exchange/offline-reader.mjs';
import {splitTeachStudentSections} from '../src/teach-document.mjs';
const render=text=>renderSourcePreview(text,'README.md',{technical:true,sourceMap:true});
test('comments hide inline and multiline content without changing source heading coordinates',()=>{
 const source='# Visible <!-- hidden title -->\r\n\r\n<!--\r\n# Hidden heading\r\n![secret](secret.png)\r\n\r\n```mermaid\r\nA---B\r\n```\r\n-->\r\n\r\n## After\r\n\r\nBefore <!-- hidden inline --> after.\r\n';
 const result=render(source),outline=buildDocumentOutline(source);
 assert.doesNotMatch(result.html,/hidden|Hidden|secret|technical-diagram/);assert.match(result.html,/Before  after/);assert.deepEqual(result.images,[]);
 assert.deepEqual(outline.map(e=>[e.title,e.line]),[['Visible',1],['After',12]]);assert.equal(source.slice(outline[1].from,outline[1].to),'## After\r\n');
 assert.deepEqual(result.headings.map(h=>h.id),outline.map(h=>h.id));assert.match(result.html,/data-source-line="12"/);assert.deepEqual(findProVisualBlocks(source),[]);
 assert.deepEqual(analyzeReferences({path:'README.md',text:source}).references,[]);
});
test('code examples, escaped comments and arbitrary HTML remain literal/inert',()=>{
 const source='`<!-- inline example -->`\n\n```html\n<!-- fenced example -->\n```\n\n    <!-- indented example -->\n\n\\<!-- escaped example -->\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<!-- <script>hidden()</script> -->\n';
 const result=render(source);for(const term of ['inline example','fenced example','indented example','escaped example'])assert.match(result.html,new RegExp(term));
 assert.match(result.html,/&lt;script&gt;/);assert.match(result.html,/&lt;img/);assert.doesNotMatch(result.html,/<script|<img|hidden\(\)/);
});
test('comment containers, unfinished blocks and inline end boundaries match Markdown-it grammar',()=>{
 const parser=new MarkdownIt({html:false});installComments(parser);
 for(const source of ['left <!-- note --> right','<!-- note -->\n\nText','<!-- unfinished\n\n# hidden','> <!--\n> # hidden\n> -->\n\n# visible','- <!-- hidden -->\n\nParagraph','<!-- note --> same closing line','x <!-- unfinished','x <!--> y','x <!---> y']){
  const expected=new MarkdownIt({html:true});expected.renderer.rules.html_block=()=>'';expected.renderer.rules.html_inline=()=>'';
  assert.equal(parser.render(source),expected.render(source),source);assert.equal(parser.options.html,false);
 }
});
test('accessible heading/image labels and table cells omit comments',()=>{
 const result=render('# Heading <!-- hide --> end\n\n![Visible <!-- hide --> alt](image.png)\n\n| Column |\n| --- |\n| Before <!-- hide --> after<br>Line |');
 assert.doesNotMatch(JSON.stringify(result),/hide/);assert.equal(result.images[0].alt,'Visible  alt');assert.match(result.html,/Before  after<br/);
 assert.equal(buildDocumentOutline('# ![Alt <!-- hide -->](x.png)')[0].title,'Alt');
});
test('offline reader hides comments while input Markdown bytes remain untouched',()=>{
 const bytes=Buffer.from('# Public\n\n<!-- private note\n[Hidden](missing.md)\n-->\n\nVisible.\n');const original=Buffer.from(bytes);
 const result=renderOffline({files:[{path:'README.md',bytes}]});const html=result.files.find(f=>f.path==='reader/README.md.html').bytes.toString();
 assert.doesNotMatch(html,/private note|missing.md/);assert.match(html,/Visible/);assert.deepEqual(result.warnings,[]);assert.deepEqual(bytes,original);
});
test('CM6 existing comment shortcut toggles without losing selected Markdown',()=>{
 let state=EditorState.create({doc:'A **teacher note**',selection:{anchor:0,head:18},extensions:[markdown()]});const target={get state(){return state;},dispatch(spec){state=state.update(spec).state;}};
 const shortcut=defaultKeymap.find(binding=>binding.key==='Mod-/');assert.ok(shortcut);assert.equal(shortcut.run(target),true);assert.equal(state.doc.toString(),'<!-- A **teacher note** -->');assert.equal(render(state.doc.toString()).html,'');
 assert.equal(shortcut.run(target),true);assert.equal(state.doc.toString(),'A **teacher note**');
});
test('student section parsing ignores commented headings but retains exact source for review',()=>{
 const source='# Course\n\n<!--\n## Teaching Schedule\nHidden content\n-->\n\n## Course Description\nVisible\n';
 const sections=splitTeachStudentSections(source);assert.equal(sections.some(section=>section.title==='Teaching Schedule'),false);assert.ok(sections.some(section=>section.title==='Course Description'));
});
