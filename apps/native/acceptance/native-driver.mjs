import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual-Electron acceptance helpers. No launch occurs on import. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
export const appRoot=fileURLToPath(new URL('../../../',import.meta.url));
const projectRoot=path.resolve(appRoot,'../..');
import {_electron} from '../../../tools/playwright.mjs';
export const packagedExecutable=process.env.ASMB_PACKAGED_EXECUTABLE?path.resolve(process.env.ASMB_PACKAGED_EXECUTABLE):null;
export const testRoot=path.resolve(process.env.ASMB_ACCEPTANCE_RUN_ROOT??path.join(developmentTestRoot,'runs',packagedExecutable?'native-package':'native-operations'));
assert.ok(testRoot.startsWith(path.join(developmentTestRoot,'runs')+path.sep),'Acceptance output must remain inside Test/runs.');
export function nativeTarget(dataRoot){
 assertTestPath(dataRoot);
 if(packagedExecutable){assert.ok(packagedExecutable.includes('.app/Contents/MacOS/'),'Packaged acceptance requires a .app executable');const allowed=[path.join(appRoot,'releases')+path.sep,path.join(developmentTestRoot,'runs/native-package')+path.sep];assert.ok(allowed.some(root=>packagedExecutable.startsWith(root)),'Package must be a canonical release or isolated Test candidate');return {executablePath:packagedExecutable,args:['--test-data-root='+dataRoot]};}
 return {executablePath:path.join(appRoot,'.tooling/electron-44.4.0-darwin-arm64/Electron.app/Contents/MacOS/Electron'),args:[path.join(appRoot,'apps/native/main.mjs'),'--test-data-root='+dataRoot]};
}
async function inspectPackage(output){
 if(!packagedExecutable)return null;
 const bundle=packagedExecutable.slice(0,packagedExecutable.indexOf('.app/Contents/MacOS/')+4),files=[],links=[];
 assert.equal(await fs.realpath(bundle),bundle,'Bundle root must be physical');
 async function walk(relative){for(const entry of await fs.readdir(path.join(bundle,relative),{withFileTypes:true})){const name=path.posix.join(relative,entry.name),full=path.join(bundle,name);if(entry.isSymbolicLink()){const resolved=await fs.realpath(full);assert.ok(resolved.startsWith(bundle+path.sep),'No bundle link may resolve outside its .app');links.push({path:name,target:await fs.readlink(full),resolved});}else if(entry.isDirectory())await walk(name);else if(entry.isFile()){const hash=createHash('sha256');for await(const chunk of createReadStream(full))hash.update(chunk);files.push({path:name,size:(await fs.stat(full)).size,sha256:hash.digest('hex')});}}}
 await walk('');const evidence={bundle,files,links};await fs.writeFile(path.join(output,'package-integrity.json'),JSON.stringify(evidence,null,2));return {bundle,fileCount:files.length,linkCount:links.length};
}
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function until(check,{timeout=10000,interval=50,label='condition'}={}) {const end=Date.now()+timeout;let last;do{try{last=await check();if(last)return last;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,interval));}while(Date.now()<end);throw new Error(`Timed out waiting for ${label}: ${String(last)}`);}
export function assertTestPath(value){const full=path.resolve(value);assert.ok(full.startsWith(testRoot+'/'),'All test data/profile/log paths must stay within run root');return full;}
export async function createDriver({executablePath,args,env={},output,workspacePath}){
 output=assertTestPath(output);workspacePath=assertTestPath(workspacePath);await fs.mkdir(output,{recursive:true});const temp=path.join(output,'tmp');await fs.mkdir(temp,{recursive:true});
 const packageIntegrity=await inspectPackage(output);
 const errors=[],consoleMessages=[],assertions=[];let application,page,stderr;
 const record=(name,detail={})=>assertions.push({name,at:new Date().toISOString(),...detail});
 async function launch(){
  application=await _electron.launch({executablePath,args,cwd:output,env:{...env,ASMB_TEST_ROOT:developmentTestRoot,PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME,TMPDIR:temp,NODE_DISABLE_COMPILE_CACHE:'1'},timeout:30000});
  stderr=[];application.process().stderr?.on('data',bytes=>stderr.push(bytes.toString()));
  page=await application.firstWindow({timeout:30000});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push({at:new Date().toISOString(),message:error.message}));page.on('console',message=>{if(message.type()==='error')consoleMessages.push({at:new Date().toISOString(),text:message.text()});});
  await page.waitForLoadState('domcontentloaded');
  if(packagedExecutable){const actual=await application.evaluate(({app})=>({packaged:app.isPackaged,name:app.getName(),version:app.getVersion(),appPath:app.getAppPath(),resourcesPath:process.resourcesPath,execPath:process.execPath,cwd:process.cwd(),argv:process.argv,userData:app.getPath('userData')}));assert.equal(actual.packaged,true);assert.equal(actual.execPath,packagedExecutable);assert.equal(actual.cwd,output);assert.ok(actual.appPath.startsWith(packageIntegrity.bundle+'/Contents/Resources/'));assert.ok(actual.resourcesPath.startsWith(packageIntegrity.bundle+'/Contents/'));assert.ok(!actual.argv.some(value=>value===path.join(appRoot,'apps/native/main.mjs')));assertTestPath(actual.userData);record('packaged-runtime-paths',{runtime:actual});}
  record('actual-electron-launch',{pid:application.process().pid,url:page.url()});return page;
 }
 async function closeNormally(){
  const started=Date.now(),exit=application.waitForEvent('close',{timeout:15000});
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&!w.getParentWindow());if(!window)throw Error('No native window');window.close();}).catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error;});
  await exit;record('native-window-close-and-process-exit',{elapsedMs:Date.now()-started});await fs.writeFile(path.join(output,`native-stderr-${assertions.length}.log`),stderr.join(''));
 }
 async function screenshot(name){await page.screenshot({path:path.join(output,name+'.png')});record('screenshot',{file:name+'.png'});}
 async function inspectFile(relative){assert.ok(!path.isAbsolute(relative)&&!relative.split('/').includes('..'));const bytes=await fs.readFile(path.join(workspacePath,relative));return {bytes,sha256:sha(bytes)};}
 async function report(extra={}){await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({platform:process.platform,arch:process.arch,executablePath,args,workspacePath,packageIntegrity,assertions,rendererErrors:errors,consoleErrors:consoleMessages,...extra},null,2));}
 return {launch,closeNormally,screenshot,inspectFile,report,record,errors,get app(){return application},get page(){return page},workspacePath,output};
}
