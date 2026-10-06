import test from 'node:test';
import assert from 'node:assert/strict';
import {convertGitBookMarkdown,rewriteGitBookAnchors} from './teach-gitbook-conversion.mjs';
import {studentNavigation} from './teach-navigation.mjs';
import {renderSourcePreview} from '../desktop/ui/markdown-preview.mjs';
import {portableHeadingOutput} from './teach-portable-headings.mjs';

test('portable Chinese heading output is deterministic, idempotent and leaves metadata/code untouched',()=>{
 const front='\ufeff---\r\ndescription: 中文\r\n---\r\n',code='```md\r\n## 不应转换\r\n```\r\n';
 const source=front+'## 实验步骤\r\nParagraph.\r\n\r\n## 实验步骤\r\n\r\n'+code;
 const result=portableHeadingOutput(source);
 assert.ok(result.text.startsWith(front));assert.ok(result.text.includes(code));
 assert.notEqual(result.anchors['实验步骤'],result.anchors['实验步骤-1']);
 assert.match(result.text, /<a id="asmb-h-[a-f0-9]+"><\/a>\r\n\r\nParagraph/);
 assert.equal(portableHeadingOutput(result.text).text,result.text);
 const rendered=renderSourcePreview(result.text.slice(1),'class.md',{sourceMap:true});
 assert.deepEqual(rendered.headings.map(h=>h.title),['实验步骤','实验步骤']);
 assert.ok(rendered.html.includes(`data-explicit-heading-anchor="${result.anchors['实验步骤']}"`));
 const rewritten=rewriteGitBookAnchors('[Go](class.md#%E5%AE%9E%E9%AA%8C%E6%AD%A5%E9%AA%A4) `class.md#实验步骤`','home.md',new Map([['class.md',result]]));
 assert.ok(rewritten.includes('class.md#'+result.anchors['实验步骤']));assert.ok(rewritten.includes('`class.md#实验步骤`'));
});
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


test('direct converted output rewrites cross-page explicit anchors without changing saved bytes',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const {pinDirectory}=await import('../../packages/desktop-host/src/physical-roots.mjs'),{buildAudiencePublication}=await import('./teach-publication.mjs');
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'direct-anchors-'));try{fs.mkdirSync(path.join(root,'2026-autumn'));const home='# Course\n\n[Class](class.md#custom)\n',lesson='# Lesson <a id="custom"></a>\n';fs.writeFileSync(path.join(root,'2026-autumn/student.md'),home);fs.writeFileSync(path.join(root,'2026-autumn/class.md'),lesson);const out=buildAudiencePublication({root:pinDirectory(root),folder:'2026-autumn',studentPath:'2026-autumn/student.md',direct:true,convertGitBook:true});assert.match(out.files.find(f=>f.path.endsWith('student.md')).bytes.toString(),/class.md#lesson/);assert.equal(fs.readFileSync(path.join(root,'2026-autumn/class.md'),'utf8'),lesson);assert.equal(fs.readFileSync(path.join(root,'2026-autumn/student.md'),'utf8'),home);assert.ok(out.conversions.some(c=>c.path.endsWith('student.md')&&c.changes.includes('Heading links')));}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('direct delivery proposes matching Chinese anchors and links, preserves saved bytes and repeats without changes',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const {pinDirectory}=await import('../../packages/desktop-host/src/physical-roots.mjs'),{buildAudiencePublication}=await import('./teach-publication.mjs');
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'portable-delivery-'));
 try{
  fs.mkdirSync(path.join(root,'2026-autumn'));
  const home='# Course\n\n[Class](class.md#实验步骤)\n',lesson='# 第一课\n\n## 实验步骤\nParagraph.\n';
  fs.writeFileSync(path.join(root,'2026-autumn/student.md'),home);fs.writeFileSync(path.join(root,'2026-autumn/class.md'),lesson);
  const build=()=>buildAudiencePublication({root:pinDirectory(root),folder:'2026-autumn',studentPath:'2026-autumn/student.md',direct:true,convertGitBook:false});
  const output=build(),classFile=output.files.find(f=>f.path.endsWith('/class.md')),homeFile=output.files.find(f=>f.path.endsWith('/student.md'));
  const anchor=portableHeadingOutput(lesson).anchors['实验步骤'];
  assert.ok(classFile.generated);assert.equal(classFile.before,lesson);assert.ok(homeFile.generated);assert.equal(homeFile.before,home);
  assert.ok(homeFile.bytes.toString().includes('class.md#'+anchor));assert.ok(classFile.bytes.toString().includes(`id="${anchor}"`));
  assert.equal(fs.readFileSync(path.join(root,'2026-autumn/class.md'),'utf8'),lesson);assert.equal(fs.readFileSync(path.join(root,'2026-autumn/student.md'),'utf8'),home);
  for(const file of output.files)fs.writeFileSync(path.join(root,file.path),file.bytes);
  const repeat=build();for(const name of ['class.md','student.md']){const file=repeat.files.find(f=>f.path.endsWith('/'+name));assert.equal(file.generated,undefined);assert.equal(file.bytes.toString(),fs.readFileSync(path.join(root,file.path),'utf8'));}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
