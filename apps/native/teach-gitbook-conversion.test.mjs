import test from 'node:test';
import assert from 'node:assert/strict';
import {convertGitBookMarkdown,rewriteGitBookAnchors} from './teach-gitbook-conversion.mjs';
import {studentNavigation} from './teach-navigation.mjs';
import {renderSourcePreview} from '../desktop/ui/markdown-preview.mjs';
test('reviewed GitBook conversion retains metadata, code, captions, tables and details without active HTML',()=>{
 const code='```xml\n<robot name="test"><link/></robot>\n```';
 const source='---\ndescription: Mechanics\n---\n# Mechanics <a id="original" ></a>\n\n'+code+'\n\n<figure><img src="assets/image.png" alt="Test"><figcaption>Caption</figcaption></figure>\n\n<table><tr><th>Week</th><th>Topic</th></tr><tr><td>01</td><td>One<br>Two</td></tr></table>\n\n<details><summary>Derivation</summary>Kept.</details>';
 const result=convertGitBookMarkdown(source);assert.ok(result.text.startsWith('---\ndescription: Mechanics\n---'));assert.ok(result.text.includes(code));assert.match(result.text,/!\[Test\]\(assets\/image.png\)/);assert.match(result.text,/One<br>Two/);assert.match(result.text,/Kept\./);assert.equal(result.anchors.original,'mechanics');
 const html=renderSourcePreview(result.text).html;assert.doesNotMatch(html,/description: Mechanics|<figure|<details/);assert.match(html,/<table/);
});
test('explicit cross-page and home anchors match the actual Markdown renderer',()=>{
 const a=convertGitBookMarkdown('# Intro <a id="intro-custom"></a>\n'),b=convertGitBookMarkdown('# Class <a id="lesson"></a>\n');const docs=new Map([['2026-spring/student.md',a],['2026-spring/Class01.md',b]]);
 const text=rewriteGitBookAnchors('[home](README.md#intro-custom) [class](Class01.md#lesson) [self](./#intro-custom)','2026-spring/student.md',docs,{'2026-spring/README.md':'2026-spring/student.md'});assert.equal(text,'[home](#intro) [class](Class01.md#class) [self](#intro)');
});
test('active and unsupported HTML is rejected; code examples and comments remain source',()=>{
 for(const s of ['<script>alert(1)</script>','<img src="x" onerror="x">','<a href="javascript:alert(1)">x</a>','<table><tr><td colspan="2">x</td></tr></table>'])assert.throws(()=>convertGitBookMarkdown(s),{code:'PUBLICATION_UNSUPPORTED_HTML'});
 const source='`<script>x</script>`\n\n<!-- private review -->';assert.equal(convertGitBookMarkdown(source).text,source);
});
test('navigation preserves module groups, labels, order and one home',()=>{
 const text=studentNavigation({folder:'2026-spring',studentPath:'2026-spring/student.md',homeAliases:{'2026-spring/README.md':'2026-spring/student.md'},documents:[{path:'2026-spring/student.md',title:'Course'},{path:'2026-spring/Class10.md',title:'Ten'},{path:'2026-spring/Class02.md',title:'Two'}],sourceSummary:'# Summary\n* [Home](README.md)\n## Module A\n* [Second class](Class02.md)\n* [Tenth class](Class10.md)'});assert.equal((text.match(/student.md/g)||[]).length,1);assert.ok(text.indexOf('Class02.md')<text.indexOf('Class10.md'));assert.match(text,/## Module A/);assert.match(text,/Second class/);
});
test('GitBook inline double-dollar math works without changing currencies or source code',()=>{
 const html=renderSourcePreview('Value $$x^2$$ and $5.\n\n```text\n$$x$$\n```','note.md',{technical:true}).html;assert.equal((html.match(/data-copy-math/g)||[]).length,1);assert.match(html,/\$5/);
 assert.match(renderSourcePreview('---\nordinary text\n---').html,/ordinary text/);
});
