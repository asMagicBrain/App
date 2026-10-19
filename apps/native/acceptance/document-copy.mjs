import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';

const output=await fs.mkdtemp(path.join(testRoot,'document-copy-'));
const data=path.join(output,'data'),repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
const source='# Copy fixture\n\nPlain <!-- Hidden instructor note -->Chinese 中文 prose.\n\nBefore $\\alpha + x^2$ after and $\\beta$.\n\n$$\n\\frac{a}{b}=c\n$$\n\n## Details\n\n- First **bold** item\n- Second item\n\n```python\nprint("中文")\n```\n';
let failure;
try {
 let page=await driver.launch();await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();
 await fs.writeFile(path.join(repo,'README.md'),source);page=await driver.launch();
 await page.getByRole('button',{name:'README.md',exact:true}).first().click();
 const article=page.locator('.rfe-preview article').first();await article.locator('[data-math-source]').first().waitFor();
 assert.equal(await article.locator('[data-copy-math]').count(),0);
 const clipboard=()=>driver.app.evaluate(({clipboard})=>clipboard.readText());
 const copy=async(selector,partial=false)=>{
  await article.evaluate((root,{selector,partial})=>{const node=selector?root.querySelector(selector):root;const range=document.createRange();range.selectNodeContents(node);if(partial){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode())&&!text.textContent.trim()){};range.setStart(text,0);range.setEnd(text,1);}const selection=getSelection();selection.removeAllRanges();selection.addRange(range);},{selector,partial});
  await page.keyboard.press('Meta+c');return clipboard();
 };
 assert.equal(await copy('p'),'Plain Chinese 中文 prose.');
 assert.equal(await copy('.preview-math-inline'),'$\\alpha + x^2$');
 assert.equal(await copy('.preview-math-inline',true),'$\\alpha + x^2$');
 assert.equal(await copy('.preview-math-display'),'$$\n\\frac{a}{b}=c\n$$');
 assert.equal(await copy('h2'),'## Details');
 assert.equal(await copy('ul'),'- First **bold** item\n- Second item');
 assert.equal(await copy('pre'),'```python\nprint("中文")\n```');
 assert.equal(await copy(null),source.replace('<!-- Hidden instructor note -->','').trim());
 await copy('p');await page.keyboard.press('Meta+a');await page.keyboard.press('Meta+c');assert.equal(await clipboard(),source.replace('<!-- Hidden instructor note -->','').trim());
 await article.evaluate(root=>{const paragraphs=root.querySelectorAll('p');const range=document.createRange();range.setStart(paragraphs[0].firstChild,6);range.setEnd(paragraphs[1].lastChild,paragraphs[1].lastChild.textContent.length);const s=getSelection();s.removeAllRanges();s.addRange(range);});
 await page.keyboard.press('Meta+c');assert.equal(await clipboard(),'Chinese 中文 prose.\n\nBefore $\\alpha + x^2$ after and $\\beta$.');
 await article.locator('.preview-math-inline').first().click({button:'right'});
 await page.getByRole('menuitem',{name:'Copy TeX',exact:true}).click();
 await until(async()=>await clipboard()==='\\alpha + x^2',{label:'native equation-only clipboard'});
 await page.getByRole('button',{name:'Present',exact:true}).click();await page.locator('.document-presentation-content').waitFor();
 assert.equal(await page.locator('.document-presentation [data-copy-math]').count(),0);
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Edit this file',exact:true}).click();
 const editor=page.locator('.cm-content').first();await editor.waitFor();await editor.press('Meta+a');await editor.press('Meta+c');assert.equal(await clipboard(),source);
 await driver.closeNormally();
 if(process.env.ASMB_PRESENT_LESSONS_ROOT){
  const originals=[];let links='# Lesson clipboard qualification\n\n';
  for(const id of ['class02','class03','class04']){
   const file=path.join(process.env.ASMB_PRESENT_LESSONS_ROOT,id,'lesson.md'),bytes=await fs.readFile(file);originals.push({file,hash:createHash('sha256').update(bytes).digest('hex')});
   const folder=path.join(repo,id);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'lesson.md'),bytes);links+=`[${id}](${id}/lesson.md)\n\n`;
   for(const match of bytes.toString().matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
    const relative=decodeURIComponent(match[1]);if(/^[a-z]+:/i.test(relative))continue;const from=path.resolve(process.env.ASMB_PRESENT_LESSONS_ROOT,id,relative),to=path.resolve(folder,relative);
    assert.ok(from.startsWith(path.resolve(process.env.ASMB_PRESENT_LESSONS_ROOT)+path.sep));assert.ok(to.startsWith(repo+path.sep));await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);
   }
  }
  await fs.writeFile(path.join(repo,'README.md'),links);page=await driver.launch();
  for(const id of ['class02','class03','class04']){
   if(!await page.getByRole('button',{name:'README.md',exact:true}).count())await page.getByRole('button',{name:'Workspace',exact:true}).first().click();await page.getByRole('button',{name:'README.md',exact:true}).first().click();await page.getByRole('link',{name:id,exact:true}).click();
   const roundtrip=async(math)=>{const expected=await math.evaluate(node=>{const source=node.dataset.mathSource;if(!node.classList.contains('preview-math-display'))return `$${source}$`;return `$$${source.startsWith('\n')?'':'\n'}${source}${source.endsWith('\n')?'':'\n'}$$`;});await math.evaluate(node=>{const r=document.createRange();r.selectNodeContents(node);const s=getSelection();s.removeAllRanges();s.addRange(r);});await page.keyboard.press('Meta+c');assert.equal(await clipboard(),expected);};
   await roundtrip(page.locator('.rfe-preview [data-math-source]').first());
   await page.getByRole('button',{name:'Present',exact:true}).click();const content=page.locator('.document-presentation-content');await content.waitFor();
   for(let n=0;n<40&&!await content.locator('[data-math-source]').count();n++)await content.press('ArrowRight');
   assert.equal(await content.locator('[data-copy-math]').count(),0);await roundtrip(content.locator('[data-math-source]').first());await content.press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});
  }
  await driver.closeNormally();for(const original of originals)assert.equal(createHash('sha256').update(await fs.readFile(original.file)).digest('hex'),original.hash);
 }
 assert.deepEqual(driver.errors,[]);
} catch(error){failure=error;console.error(error);await driver.screenshot('failure').catch(()=>{});await driver.closeNormally().catch(()=>{});}
await driver.report({passed:!failure,failure:failure?.stack??null,scope:'Actual native clipboard Markdown/TeX round trips; source editor and Present buttons'});
console.log(output);if(failure)process.exitCode=1;
