/** Actual installed Linux acceptance. CDP observes the renderer while shipped
 * Node inspection fuses remain disabled. No production bridge is added. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from '../../../tools/playwright.mjs';
import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
export const appRoot=fileURLToPath(new URL('../../../',import.meta.url));
export const testRoot=path.resolve(process.env.ASMB_ACCEPTANCE_RUN_ROOT??path.join(developmentTestRoot,'runs/linux-native'));
export const packagedExecutable=process.env.ASMB_PACKAGED_EXECUTABLE;
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
assert.ok(testRoot.startsWith(path.join(developmentTestRoot,'runs')+path.sep));
assert.ok(['/opt/asmagicbrain-preview/asmagicbrain','/opt/asmagicbrain/asmagicbrain'].includes(packagedExecutable),'Use the installed Debian package.');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function until(check,{timeout=120000,interval=100,label='condition'}={}){const end=Date.now()+timeout;let last;do{try{last=await check();if(last)return last;}catch(error){if(error.fatal)throw error;last=error;}await new Promise(resolve=>setTimeout(resolve,interval));}while(Date.now()<end);throw Error(`Timed out waiting for ${label}: ${String(last)}`);}
export function assertTestPath(value){const full=path.resolve(value);assert.ok(full.startsWith(testRoot+path.sep),'Test data must stay inside this run');return full;}
export function nativeTarget(dataRoot){assertTestPath(dataRoot);assert.equal(path.basename(dataRoot),'asMagicBrain');return {executablePath:packagedExecutable,args:[`--test-root=${developmentTestRoot}`,`--test-user-home=${path.dirname(dataRoot)}`]};}

export async function createDriver({executablePath,args,env={},output,workspacePath}){
  output=assertTestPath(output);workspacePath=assertTestPath(workspacePath);await fs.mkdir(output,{recursive:true});
  const temp=path.join(output,'tmp');await fs.mkdir(temp,{recursive:true});
  const metadata=JSON.parse(await fs.readFile(path.join(path.dirname(executablePath),'resources/app/native-package.json'),'utf8'));
  assert.equal(metadata.channel,'preview');assert.equal(metadata.accountRuntimePolicy.electronFuses.wire,'100000011');
  const home=args.find(v=>v.startsWith('--test-user-home='))?.slice('--test-user-home='.length);assertTestPath(home);
  const profile=path.join(home,'.config/asMagicBrain Preview'),portFile=path.join(profile,'session/DevToolsActivePort');
  const events=[],errors=[],consoleErrors=[];let child,browser,page,exitResult,runtimeTemporaryDirectory,normalCloseVerified=false,stderr=[];
  const record=(name,details={})=>{events.push({name,at:new Date().toISOString(),...details});console.log(JSON.stringify({event:name}));};
  async function launch(){
    assert.equal(child?.exitCode===null,false,'Close the previous application normally first.');
    // Remove only the previous test endpoint, never profile or ownership data.
    await fs.unlink(portFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    stderr=[];exitResult=null;runtimeTemporaryDirectory=null;normalCloseVerified=false;
    const childEnv={...process.env,...env,TMPDIR:temp,TMP:temp,TEMP:temp};
    for(const key of ['NODE_OPTIONS','ELECTRON_RUN_AS_NODE','ELECTRON_NO_SANDBOX'])delete childEnv[key];
    child=spawn(executablePath,[...args,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--ozone-platform=${process.env.ASMB_LINUX_OZONE??'x11'}`],{cwd:output,env:childEnv,stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',bytes=>stderr.push(bytes.toString()));child.stdout.on('data',bytes=>stderr.push(bytes.toString()));
    child.once('error',error=>{exitResult={error:error.message};});child.once('exit',(code,signal)=>{exitResult={code,signal};});
    const port=await until(async()=>{if(exitResult)throw Object.assign(Error(JSON.stringify(exitResult)+' '+stderr.join('').slice(-3000)),{fatal:true});try{return (await fs.readFile(portFile,'utf8')).split('\n')[0];}catch{return false;}},{timeout:240000,label:'sandboxed Linux native startup endpoint'});
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:120000});
    page=await until(()=>browser.contexts()[0]?.pages().find(p=>p.url()==='app://asmagicbrain/index.html'),{label:'native application page'});
    page.setDefaultTimeout(120000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
    await page.getByRole('button',{name:'asMagicBrain organization',exact:true}).waitFor();
    await page.context().setOffline(true);
    assert.equal(await page.evaluate(()=>typeof process),'undefined');
    assert.equal((await page.evaluate(()=>window.asMagicBrain.getBuildConfiguration())).value.channel,'preview');
    const processes=[];
    for(const entry of await fs.readdir('/proc')){
      if(!/^\d+$/.test(entry))continue;
      try{const cmd=(await fs.readFile(`/proc/${entry}/cmdline`,'utf8')).replaceAll('\0',' ');if(!cmd.startsWith(executablePath+' ')||!cmd.includes('--type=renderer'))continue;
        const status=await fs.readFile(`/proc/${entry}/status`,'utf8');
        if(!cmd.includes(profile))continue;
        assert.match(status,/^Seccomp:\s+2$/m);assert.match(status,/^NoNewPrivs:\s+1$/m);
        assert.doesNotMatch(cmd,/--no-sandbox|--disable-seccomp/);processes.push({pid:Number(entry),seccomp:2,noNewPrivileges:true});
      }catch(error){if(error.code==='ENOENT'||error.code==='EACCES')continue;throw error;}
    }
    assert.ok(processes.length,'Observe an actual sandboxed renderer');
    const singletonSocket=await fs.readlink(path.join(profile,'SingletonSocket'));
    assert.ok(path.isAbsolute(singletonSocket),'Chromium records its actual runtime socket path.');
    assert.ok(Buffer.byteLength(singletonSocket)<108,'The real singleton socket fits Linux sockaddr_un.');
    assert.equal((await fs.lstat(singletonSocket)).isSocket(),true);
    runtimeTemporaryDirectory=path.dirname(path.dirname(singletonSocket));
    assert.match(path.basename(runtimeTemporaryDirectory),/^asmb-[A-Za-z0-9]{6}$/);
    assert.equal(await fs.realpath(runtimeTemporaryDirectory),runtimeTemporaryDirectory);
    const runtimeStat=await fs.lstat(runtimeTemporaryDirectory);
    assert.equal(runtimeStat.uid,process.getuid());assert.equal(runtimeStat.mode&0o7777,0o700);
    record('installed-linux-launch-sandboxed-offline',{pid:child.pid,executable:executablePath,version:metadata.version,sourceCommit:metadata.sourceCommit,profile,rendererSandbox:processes,ozone:process.env.ASMB_LINUX_OZONE??'x11',runtimeTemporaryDirectory,singletonSocket,socketBytes:Buffer.byteLength(singletonSocket)});
    return page;
  }
  async function closeNormally(){
    if(!child||normalCloseVerified)return;
    assert.equal(exitResult,null,`The app exited before normal close was requested: ${JSON.stringify(exitResult)}`);
    const started=Date.now();await page.getByRole('button',{name:'Close window',exact:true}).click().catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error;});
    await until(()=>exitResult,{timeout:120000,label:'normal close drains and exits'});assert.equal(exitResult.code,0,JSON.stringify(exitResult));
    if(runtimeTemporaryDirectory)assert.equal(await fs.lstat(runtimeTemporaryDirectory).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),false,'Normal quit cleans its exact ephemeral runtime directory.');
    await fs.writeFile(path.join(output,`native-stderr-${events.length}.log`),stderr.join(''));
    record('native-window-close-and-process-exit',{elapsedMs:Date.now()-started,exit:exitResult});
    normalCloseVerified=true;
    await browser?.close();browser=null;
  }
  async function screenshot(name){await page.screenshot({path:path.join(output,name+'.png'),timeout:120000});record('screenshot',{file:name+'.png'});}
  async function report(extra={}){await fs.writeFile(path.join(output,'native-last-stderr.log'),stderr.join(''));await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({platform:process.platform,arch:process.arch,metadata,executablePath,args,workspacePath,assertions:events,rendererErrors:errors,consoleErrors,...extra},null,2)+'\n');}
  return {launch,closeNormally,screenshot,report,record,errors,consoleErrors,get page(){return page;},get app(){return null;},workspacePath,output};
}
