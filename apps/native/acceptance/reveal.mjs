import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged Explorer gestures on disposable Test data; shell dispatch is observed, not replaced by a direct service call. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const appRoot=fileURLToPath(new URL('../../../',import.meta.url)),testRoot=developmentTestRoot;
const runRoot=path.join(testRoot,'runs/native-reveal-20260917'),executable=process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2),['--run-isolated'],'Pass --run-isolated explicitly.');
assert.ok(executable&&path.isAbsolute(executable)&&executable.includes('.app/Contents/MacOS/'),'Supply ASMB_PACKAGED_EXECUTABLE.');
assert.ok([path.join(appRoot,'releases')+'/',testRoot+'/runs/native-package/'].some(prefix=>executable.startsWith(prefix)),'Use a release or isolated package candidate.');
import {_electron} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot,{recursive:true});
const output=await fs.mkdtemp(runRoot+'/acceptance-'),data=output+'/data',tmp=output+'/tmp',fixture=output+'/fixture',repo='Reveal-QA',workspace=data+'/workspaces/asMagicBrain/'+repo;
await fs.mkdir(tmp);await fs.mkdir(fixture+'/notes',{recursive:true});
const initial='# Reveal QA\n\nSaved bytes stay unchanged.\n',marker='Private reveal draft retained.';
await fs.writeFile(fixture+'/README.md',initial);await fs.writeFile(fixture+'/other.md','# Other\n');await fs.writeFile(fixture+'/notes/spaced Ω.txt','Nested bytes Ω\n');
const zip=output+'/fixture.zip';execFileSync('/usr/bin/zip',['-q','-r',zip,'.'],{cwd:fixture,env:{PATH:'/usr/bin:/bin',TMPDIR:tmp}});
const bundle=executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4),metadata=JSON.parse(await fs.readFile(bundle+'/Contents/Resources/app/native-package.json','utf8'));
const events=[],errors=[],consoleErrors=[];let app,page,failure;
const record=(name,detail={})=>events.push({name,at:new Date().toISOString(),...detail});
const button=name=>page.getByRole('button',{name,exact:true}),item=()=>page.getByRole('menuitem',{name:'Reveal the file',exact:true});
const node=name=>page.locator(`.rex-node[data-explorer-path="${name}"]`);
const git=(...args)=>execFileSync('/usr/bin/git',['-C',workspace,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}}).trim();
async function until(check,label,timeout=15000){const end=Date.now()+timeout;let value;do{try{value=await check();if(value)return value;}catch(e){value=e.message;}await new Promise(r=>setTimeout(r,50));}while(Date.now()<end);throw Error(`Timeout ${label}: ${value}`);}
async function launch(){
 app=await _electron.launch({executablePath:executable,args:['--test-data-root='+data],cwd:output,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:tmp}});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});await button(/^Switch local repository:/).waitFor();
 const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,exe:process.execPath,cwd:process.cwd(),profile:app.getPath('userData')}));
 assert.equal(runtime.packaged,true);assert.equal(runtime.exe,executable);assert.equal(runtime.cwd,output);assert.equal(runtime.profile,data+'-electron-profile');
 // Observe calls at the native shell boundary. Separate CUA evidence qualifies actual Finder selection.
 await app.evaluate(({shell})=>{global.__revealCalls=[];global.__originalShowItemInFolder=shell.showItemInFolder;shell.showItemInFolder=filename=>{global.__revealCalls.push({path:filename,at:Date.now()});};});
 record('packaged-launch',{runtime,shellObservation:'Calls recorded at shell.showItemInFolder; actual Finder behavior qualified separately.'});
}
async function calls(){return app.evaluate(()=>global.__revealCalls);}
async function close(){const closed=app.waitForEvent('close',{timeout:20000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close()).catch(e=>{if(!/closed|destroyed/i.test(String(e)))throw e;});await closed;record('normal-native-close');}
async function shot(name){await page.screenshot({path:output+'/'+name+'.png'});record('screenshot',{file:name+'.png'});}
async function select(){await button(/^Switch local repository:/).click();await page.locator('.rh-list').getByRole('button',{name:new RegExp(repo)}).click();if(await button('Leave editor').isVisible())await button('Leave editor').click();await until(async()=>await page.locator('.rc-identity h1').innerText()===repo,'selected repo');}
async function open(name){await node(name).click();await button('More actions for '+name).click();await page.getByRole('menuitem',{name:'Open',exact:true}).click();await until(async()=>await button('Edit this file').isVisible()||await page.locator('.cm-content[contenteditable=true]').isVisible(),'file or retained draft open');}
async function edit(){const editor=page.locator('.cm-content[contenteditable=true]');if(!await editor.isVisible()){await button('Edit this file').waitFor();await button('Edit this file').click();}await editor.waitFor();}
async function append(){const cm=page.locator('.cm-content[contenteditable=true]');await cm.click();await cm.press('Meta+ArrowDown');await page.keyboard.insertText(marker);}
async function mode(enabled){const control=page.getByRole('switch',{name:'Hide unavailable functions'});if((await control.getAttribute('aria-checked')==='true')!==enabled)await control.click();}
async function menu(kind,target){
 if(kind==='dropdown')await button(target===null?'Repository file actions':'More actions for '+target).click();
 else if(target!==null)await node(target).click({button:'right'});
 else {const bounds=await page.locator('.rex-viewport').boundingBox();assert.ok(bounds);await page.mouse.click(bounds.x+Math.min(80,bounds.width/2),bounds.y+bounds.height-16,{button:'right'});}
 await item().waitFor();assert.equal(await item().isEnabled(),true);assert.equal(await item().getAttribute('data-unavailable'),null);
}
async function reveal(kind,target,name){
 const before=(await calls()).length;await menu(kind,target);await shot(name);await item().click();await until(async()=>(await calls()).length===before+1,'shell dispatch');
 const dispatch=(await calls()).at(-1);assert.equal(dispatch.path,path.join(workspace,target??''));await until(()=>button('Repository file actions').isEnabled(),'reveal settled');record('menu-to-native-shell',{kind,target,dispatch});
}
async function boundary(args,code){const before=(await calls()).length;const response=await page.evaluate(args=>window.asMagicBrain.revealItem(args),args);assert.equal(response.ok,false);assert.equal(response.error.code,code);assert.equal((await calls()).length,before);record('invalid-reveal-refused',{args,code});}
async function inventory(){const files={};for(const file of ['README.md','other.md','notes/spaced Ω.txt'])files[file]=createHash('sha256').update(await fs.readFile(path.join(workspace,file))).digest('hex');return{files,head:git('rev-parse','HEAD'),status:git('status','--porcelain')};}

try{
 await launch();await button('Create new options').click();await button('Import repository').click();await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(zip);await page.getByLabel('Repository name',{exact:true}).fill(repo);await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).click();await page.locator('.zi-dialog').waitFor({state:'detached',timeout:60000});
 git('tag','qa-reveal-baseline');await select();await button('README.md').first().click();await edit();await append();const before=await inventory();await page.locator('.cm-content').evaluate(e=>{window.__revealEditor=e;});
 for(const kind of ['context','dropdown'])for(const target of ['README.md','notes',null])await reveal(kind,target,`${kind}-${target??'root'}`);
 assert.equal(await page.locator('.cm-content').evaluate(e=>e===window.__revealEditor),true,'Reveal preserves mounted CM6 editor');
 const keyboardBefore=(await calls()).length;await menu('dropdown',null);await item().focus();await item().press('Enter');await until(async()=>(await calls()).length===keyboardBefore+1,'keyboard shell dispatch');assert.equal((await calls()).at(-1).path,workspace);record('keyboard-reveal-activation');
 await button('Expand notes').click();await reveal('context','notes/spaced Ω.txt','nested-unicode-context');
 // A context action addresses the clicked entry, including when selection contains another item.
 await node('README.md').click();await node('other.md').click({modifiers:['Meta']});await reveal('context','other.md','multiselect-clicked-file');
 await open('README.md');await edit();assert.match(await page.locator('.cm-content').innerText(),new RegExp(marker));
 await mode(true);await reveal('dropdown',null,'implemented-mode');
 await button('asMagicBrain Theme').click();await page.locator('.fw-theme-picker select').selectOption({label:'GitHub Dark Default'});await page.locator('.fw-theme-picker').getByRole('button',{name:'Done',exact:true}).click();await reveal('context','README.md','dark-theme');
 assert.deepEqual(await inventory(),before);assert.equal(await fs.readFile(workspace+'/README.md','utf8'),initial);assert.match(await page.locator('.cm-content').innerText(),new RegExp(marker));record('source-head-draft-preserved',{before});
 // A missing physical entry must not dispatch a Finder action even if the UI was previously loaded.
 await boundary({repo,path:'missing.md'},'REVEAL_NOT_FOUND');await boundary({repo,path:'../outside'},'INVALID_PATH');await boundary({repo,path:workspace+'/README.md'},'INVALID_PATH');await boundary({repo,path:'.git/config'},'INVALID_PATH');await boundary({repo:'Unregistered-QA',path:''},'UNKNOWN_REPOSITORY');await boundary({repo,path:'README.md',ref:'qa-reveal-baseline'},'HISTORICAL_REVISION');
 await fs.writeFile(output+'/outside.txt','Outside bytes\n');await fs.symlink(output+'/outside.txt',workspace+'/linked.txt');await boundary({repo,path:'linked.txt'},'DENIED');
 await mode(false);await button(/^Switch branches\/tags:/).click();await page.getByRole('tab',{name:'Tags',exact:true}).click();await page.locator('.rp-list').getByRole('button',{name:'qa-reveal-baseline',exact:true}).click();await until(()=>button('Edit this file').isDisabled(),'historical revision ready');
 await button('More actions for README.md').click();assert.equal(await item().isEnabled(),false);await shot('historical-disabled');await page.keyboard.press('Escape');await mode(true);await button('More actions for README.md').click();assert.equal(await item().isVisible(),false);await shot('historical-implemented-hidden');await page.keyboard.press('Escape');record('historical-grey-and-hidden-modes');
 await button(/^Switch branches\/tags:/).click();await page.getByRole('tab',{name:'Branches',exact:true}).click();await page.locator('.rp-list').getByRole('button',{name:/main/}).click();await edit();assert.match(await page.locator('.cm-content').innerText(),new RegExp(marker));await close();
 await launch();await select();await button('README.md').first().click();await edit();assert.match(await page.locator('.cm-content').innerText(),new RegExp(marker));assert.equal(await fs.readFile(workspace+'/README.md','utf8'),initial);await reveal('dropdown',null,'restart-root');record('normal-restart-preserves-draft');
 // The final gesture invokes the original Electron shell method as well. Leave Finder's selected file for independent CUA inspection after normal app close.
 await app.evaluate(({shell})=>{shell.showItemInFolder=filename=>{global.__revealCalls.push({path:filename,at:Date.now(),realDispatch:true});global.__originalShowItemInFolder(filename);};});
 await reveal('context','README.md','real-finder-reveal');record('real-finder-dispatch-requested',{path:workspace+'/README.md',verification:'Independent CUA must verify Finder selection; this event alone does not prove OS presentation.'});
 assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);await close();
}catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);try{await shot('failure');await fs.writeFile(output+'/failure-dom.txt',await page.locator('body').innerText());}catch{}try{if(app)await close();}catch{}process.exitCode=1;}
finally{await fs.writeFile(output+'/receipt.json',JSON.stringify({status:failure?'failed':'passed',failure,executable,metadata,data,events,errors,consoleErrors,definitionSha256:createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex')},null,2));console.log(JSON.stringify({status:failure?'failed':'passed',output}));}
