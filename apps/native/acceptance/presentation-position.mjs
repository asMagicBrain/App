import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(testRoot,'presentation-position-'));
const data=path.join(output,'data');await fs.mkdir(data,{mode:0o700});
const repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
const source='# Position fixture\n\n## Long list\n\n'+Array.from({length:120},(_,n)=>`- Item ${n}: nested teaching material.\n\n`).join('');
async function leadingLine(page){return page.locator('.document-presentation-content').evaluate(root=>{const top=root.getBoundingClientRect().top;const node=Array.from(root.querySelectorAll('li[data-source-line]')).find(node=>node.getBoundingClientRect().bottom>top+1);return Number(node?.dataset.sourceLine)||1;});}
let expectedLine;
try{
 let page=await driver.launch();await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();
 await fs.writeFile(path.join(repo,'README.md'),source);
 page=await driver.launch();await page.getByRole('button',{name:'README.md',exact:true}).first().click();await page.getByRole('button',{name:'Edit this file',exact:true}).click();
 const editor=page.locator('.cm-content').first();await editor.waitFor();await until(()=>editor.evaluate(node=>!node.cmTile.root.view.state.readOnly));
 const selection=await editor.evaluate(node=>node.cmTile.root.view.state.selection.toJSON());
 await page.getByRole('button',{name:'Present',exact:true}).click();await page.locator('.document-presentation-content').press('End');
 const line=await until(async()=>{const value=await leadingLine(page);return value>100?value:false;},{label:'long list scroll settled'});
 expectedLine=line;
 await page.locator('.document-presentation-content').press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});await until(()=>driver.app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).isFullScreen()),{label:'native exit settled'});
 await until(()=>editor.evaluate((node,line)=>{const view=node.cmTile.root.view,at=view.state.doc.line(line).from;return view.visibleRanges.some(range=>at>=range.from&&at<=range.to);},line),{label:'matching source block revealed'});
 await page.getByRole('button',{name:'Present',exact:true}).click();await until(async()=>Math.abs(await leadingLine(page)-line)<=2,{label:'same content position resumed despite source viewport clamping'});
 await page.locator('.document-presentation-content').press('Meta+=');await until(async()=>Math.abs(await leadingLine(page)-line)<=2,{label:'content position retained during font resize'});
 await driver.screenshot('long-list-resume');
 await page.locator('.document-presentation-content').press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});await until(()=>driver.app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).isFullScreen()),{label:'native exit settled'});
 assert.deepEqual(await editor.evaluate(node=>node.cmTile.root.view.state.selection.toJSON()),selection);
 await editor.press('Meta+Home');await until(()=>editor.evaluate(node=>node.cmTile.root.view.state.doc.lineAt(node.cmTile.root.view.lineBlockAtHeight(node.cmTile.root.view.scrollDOM.scrollTop).from).number<=2));
 await page.getByRole('button',{name:'Present',exact:true}).click();await until(()=>page.locator('.document-presentation-content').evaluate(node=>node.scrollTop<2),{label:'explicit editor navigation overrides resume'});
 await page.locator('.document-presentation-content').press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});await until(()=>driver.app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).isFullScreen()),{label:'native exit settled'});
 await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).setFullScreen(true));
 await until(()=>driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).isFullScreen()),{label:'previous fullscreen state'});
 await page.getByRole('button',{name:'Present',exact:true}).click();await page.locator('.document-presentation-content').press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});
 assert.equal(await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).isFullScreen()),true);
 await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.getParentWindow()).setFullScreen(false));
 assert.equal(await fs.readFile(path.join(repo,'README.md'),'utf8'),source);
 await driver.closeNormally();await driver.report({status:'passed',scope:'nested source position, resume, text resize and explicit editor navigation'});console.log(output);
}catch(error){try{console.log(JSON.stringify({expectedLine,actualLine:await leadingLine(driver.page)}));await driver.screenshot('position-failure');await fs.writeFile(path.join(output,'failure-aria.yml'),await driver.page.locator('body').ariaSnapshot());}catch{}await driver.report({status:'failed',error:String(error)});try{await driver.closeNormally();}catch{}throw error;}
