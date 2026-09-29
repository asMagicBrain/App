import {runCli} from './automation-cli.mjs';
import {createLocalAutomation} from './local-automation.mjs';
import {app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, protocol, session, shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createArtifactHost, ARTIFACT_SCHEME} from './artifact-host.mjs';
import {saveExportDestination} from './export-destination.mjs';
import {createNativeService} from './host-service.mjs';
import {prepareNativeStorage} from './storage-admission.mjs';
import {loadBundledDocs} from './bundled-docs-manifest.mjs';
import {createExternalFileTickets} from './external-file-tickets.mjs';
import {ensurePhysicalDirectory, admitNativeProfile} from './profile-paths.mjs';
import {resolveNativeStartup, startupFailureMessage} from './startup.mjs';
import {createLinuxRuntimeTemporaryDirectory} from './linux-runtime-temp.mjs';
import {assertGitRuntime} from '../../packages/desktop-host/src/git-executable.mjs';
import {createGitHubAuth} from './github-auth.mjs';
import {createApplicationAuth, applicationAccountMethods} from './application-auth.mjs';
import {applicationAccount} from './application-config.mjs';
import {AuthClient} from './dist-host/application-sdk.mjs';
import {createCloneCoordinator} from './clone-coordinator.mjs';
import {createUpdateCoordinator} from './update-coordinator.mjs';
import {createApplyCoordinator} from './apply-coordinator.mjs';
import {githubApp} from './github-config.mjs';
import {createGitHubAccountCoordinator, githubAccountMethods} from './github-account-coordinator.mjs';

// Explicit CLI mode connects to the running host before any profile/window setup.
const cliIndex=process.argv.indexOf('--automation-cli');
if(cliIndex>=0)process.exit(await runCli(process.argv.slice(cliIndex+1)));

const here = fileURLToPath(new URL('.', import.meta.url));
let packageMetadata, buildConfig, testRoot, profilePaths, dataRoot, profileRoot, temporaryRoot, linuxTemporaryDirectory, startupFailure;
const pageURL = 'app://asmagicbrain/index.html';
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true}}, ARTIFACT_SCHEME]);

// Resolve and admit the host-owned profile before Chromium opens a session.
// Report failures through a native dialog instead of an uncaught JavaScript box.
try {
  if (app.commandLine.hasSwitch('no-sandbox')) throw Object.assign(Error('Open asMagicBrain with its sandbox enabled.'), {code: 'SANDBOX_REQUIRED'});
  app.enableSandbox();
  packageMetadata = app.isPackaged ? JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'native-package.json'), 'utf8')) : null;
  const startup = resolveNativeStartup({args: process.argv, packaged: app.isPackaged, metadata: packageMetadata,
    sourceTestRoot: app.isPackaged ? undefined : process.env.ASMB_TEST_ROOT,
    home: app.getPath('home'), appData: app.getPath('appData')});
  buildConfig = startup.configuration; testRoot = startup.testRoot; profilePaths = startup.paths;
  app.setName(buildConfig.channel === 'preview' ? 'asMagicBrain Preview' : app.isPackaged ? 'asMagicBrain' : 'asMagicBrain Native Preview');
  assertGitRuntime({packaged: app.isPackaged});
  admitNativeProfile({args: process.argv, testRoot, channel: buildConfig.channel, paths: profilePaths});
  ({dataRoot, profileRoot, temporaryRoot} = profilePaths);
  ensurePhysicalDirectory(path.dirname(dataRoot));
  ensurePhysicalDirectory(profileRoot);
  if (process.platform === 'linux') {
    linuxTemporaryDirectory = createLinuxRuntimeTemporaryDirectory();
    temporaryRoot = linuxTemporaryDirectory.directory;
  } else ensurePhysicalDirectory(temporaryRoot);
  app.setPath('temp', temporaryRoot);
  process.env.TMPDIR = temporaryRoot; process.env.TMP = temporaryRoot; process.env.TEMP = temporaryRoot;
  app.setPath('userData', profileRoot);
  app.setPath('sessionData', ensurePhysicalDirectory(path.join(profileRoot, 'session')));
  app.setAppLogsPath(ensurePhysicalDirectory(path.join(profileRoot, 'logs')));
} catch (error) {startupFailure = error;}

let automationTransport,automationConnection,automationDirectory;
let storageAdmission, window, artifactHost, service, applicationAuth, githubAuth, githubAccount, cloneCoordinator, updateCoordinator, applyCoordinator, externalTickets, pickerPending=false, pendingClose = null, allowQuit = false, terminalFailure = null, recoveryDialog = false;
const isApplicationPage = value => {try {const url = new URL(value); url.hash = ''; return url.href === pageURL;} catch {return false;}};
const trusted = event => Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isApplicationPage(event.senderFrame.url));
const openExternal = value => {try {const url = new URL(value); if (['https:', 'http:', 'mailto:'].includes(url.protocol)) void shell.openExternal(url.href).catch(error => console.error('External link could not open:', error.message));} catch {}};
const publicErrors = Object.freeze({ENOENT:'This file or folder is no longer available. Refresh the repository and try again.',ENOTDIR:'This file or folder is no longer available. Refresh the repository and try again.',DRAFT_CONFLICT:'This file has an unsaved draft. Save or resolve the draft, then review a new request.',STALE_PLAN:'The saved files or drafts changed. Prepare a new review before applying changes.',CHOICE_REQUIRED:'Choose a resolution for each proposed change.',PERMISSION_DENIED:'Enable the required repository permission in Local automation.',OPERATION_NOT_REVIEWABLE:'This request is no longer waiting for review.',ROLLBACK_CONFLICT:'Files changed after this update. Resolve those changes before rolling back.'});
const respondError = error => ({ok: false, error: {code: typeof error?.code === 'string' ? error.code : 'NATIVE_OPERATION_FAILED', message: publicErrors[error?.code] ?? (typeof error?.publicMessage === 'string' ? error.publicMessage : typeof error?.message === 'string' ? error.message : 'Native operation failed.')}});
const methods = new Set(['approveAutomation','cancelAutomation','packageStatus','reviewPackageBase','registerPackageBase','reviewPackageUpdate','applyPackageUpdate','recoverPackageUpdate','rollbackPackageUpdate','reviewPackageExport','cancelPackagePlan','getReadingEvidence','getReadingReference','resolveReadingReference','readingHistory','catalog', 'read', 'readAsset', 'revealItem', 'bootstrap', 'request', 'importArchive', 'createRepository', 'getRepositoryUpdates', 'reviewRepositoryUpdate', 'readRepositoryUpdateFile', 'renameRepository', 'duplicateRepository', 'trashRepository', 'listTrashedRepositories', 'restoreRepository', 'getAppearance', 'setAppearance', 'getRepositoryPins', 'setRepositoryPinned', 'listRepositoryFiles', 'searchRepositoryText', 'cancelRepositorySearch']);

async function stopAutomation(){
  try{if(service)await service.setAutomationGrants({enabled:false,grants:[]});}
  finally{try{await automationTransport?.stop();}finally{automationTransport=null;automationConnection=null;if(automationDirectory){try{fs.rmdirSync(automationDirectory);}catch{}automationDirectory=null;}}}
}
function requestClose() {
  if (terminalFailure) {void holdForRecovery(terminalFailure); return;}
  if (recoveryDialog) return;
  if (!window || window.isDestroyed() || pendingClose) return;
  artifactHost?.stop();
  const requestId = randomUUID();
  const timer = setTimeout(() => {
    if (pendingClose?.requestId !== requestId || window.isDestroyed()) return;
    void dialog.showMessageBox(window, {type: 'info', title: 'Preserving your work', message: 'Draft preservation is still running.', detail: 'The window will remain open until pending work is preserved. A late successful response will still complete the close.', buttons: ['Keep waiting']});
  }, 15000);
  timer.unref();
  pendingClose = {requestId, timer, phase: 'preparing'};
  // Settle cancellation before renderer draining observes the clone promise.
  // Publication already completed wins; a cancelled download has no saved work.
  void Promise.all([stopAutomation(),service.prepareSearchClose(), applicationAuth.prepareClose(), githubAccount.prepareClose(), cloneCoordinator.prepareClose(), updateCoordinator.prepareClose(), applyCoordinator.prepareClose()]).then(() => {
    if (pendingClose?.requestId === requestId && !window.isDestroyed()) window.webContents.send('asmb:prepare-close', {requestId});
  }, error => {void closeFailed(error.message);});
}
async function closeFailed(message) {
  const old = pendingClose;
  if (!old) return;
  clearTimeout(old.timer); pendingClose = null;
  service.resumeSearch(); applicationAuth.resume(); githubAccount.resume(); cloneCoordinator.resume(); updateCoordinator.resume(); applyCoordinator.resume();
  if (window && !window.isDestroyed()) {
    window.webContents.send('asmb:prepare-close', {requestId: old.requestId, cancelled: true, error: message});
    await dialog.showMessageBox(window, {type: 'error', title: 'Work is still open', message: 'The window could not close safely.', detail: message, buttons: ['Keep editing']});
  }
}
ipcMain.handle('asmb:external-files',async(event,paths)=>{
  if(!trusted(event))return respondError(Object.assign(Error('Native view is unavailable.'),{code:'VIEW_UNAVAILABLE'}));
  try{
    if(terminalFailure||pendingClose?.phase==='draining')throw Object.assign(Error('The application is closing or needs recovery.'),{code:'SERVICE_CLOSED'});
    return {ok:true,value:await externalTickets.register(event.sender.id,paths)};
  }catch(error){return respondError(error);}
});
ipcMain.handle('asmb:native', async (event, input) => {
  if (!trusted(event)) return respondError(Object.assign(Error('Native view is unavailable.'), {code: 'VIEW_UNAVAILABLE'}));
  try {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['method', 'args'].includes(key)) || typeof input.method !== 'string') throw Error('Invalid native request.');
    if (terminalFailure) throw Error('Local storage needs recovery. The preview is held; reopen only after resolving the reported issue.');
    if (pendingClose?.phase === 'draining') throw Error('The window is closing.');
    if (input.method === 'getBuildConfiguration') {
      if (input.args !== undefined) throw Error('Build configuration takes no arguments.');
      return {ok: true, value: buildConfig};
    }
    if(input.method==='getAutomationStatus')return {ok:true,value:{...await service.getAutomationStatus(),...(automationConnection?{connectionFile:automationConnection.connectionFile}:{})}};
    if(input.method==='configureAutomation'){
      if(pendingClose)throw Error('The app is closing.');
      const value=await service.setAutomationGrants(input.args);
      if(!value.enabled){await stopAutomation();return {ok:true,value};}
      try{if(!automationTransport){automationDirectory=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':'/tmp','asmb-ipc-'));fs.chmodSync(automationDirectory,0o700);automationTransport=createLocalAutomation({directory:automationDirectory,handleRequest:request=>service.automationRequest(request)});automationConnection=await automationTransport.start();}return {ok:true,value:{...value,connectionFile:automationConnection.connectionFile}};}
      catch(error){await stopAutomation();throw error;}
    }
    const artifactMethods = {reviewArtifact:'review',runArtifact:'run',resetArtifact:'reset',resizeArtifact:'resize',stopArtifact:'stop',artifactStatus:'status'};
    if(Object.hasOwn(artifactMethods,input.method)){
      if(pendingClose||!artifactHost)throw Object.assign(Error('The interactive view is closing.'),{code:'ARTIFACT_CLOSED'});
      return {ok:true,value:await artifactHost[artifactMethods[input.method]](input.args)};
    }
    if (input.method === 'windowAction') {
      if (input.args === 'close') requestClose();
      else if (input.args === 'minimize') window.minimize();
      else if (input.args === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      else throw Error('Unknown window action.');
      return {ok: true};
    }
    if(input.method==='cancelExternalFiles')return {ok:true,value:externalTickets.cancel(event.sender.id,input.args)};
    if(input.method==='importExternalFiles')return {ok:true,value:await externalTickets.consume(event.sender.id,input.args)};
    if(input.method==='cloneRepository')return {ok:true,value:await cloneCoordinator.cloneRepository(input.args)};
    if(input.method==='getCloneProgress')return {ok:true,value:cloneCoordinator.getCloneProgress(input.args)};
    if(input.method==='cancelClone')return {ok:true,value:await cloneCoordinator.cancelClone(input.args)};
    if(input.method==='applyRepositoryUpdate')return {ok:true,value:await applyCoordinator.applyRepositoryUpdate(input.args)};
    if(input.method==='getRepositoryApplyProgress')return {ok:true,value:applyCoordinator.getRepositoryApplyProgress(input.args)};
    if(input.method==='checkRepositoryUpdates')return {ok:true,value:await updateCoordinator.checkRepositoryUpdates(input.args)};
    if(input.method==='getRepositoryUpdateProgress')return {ok:true,value:updateCoordinator.getRepositoryUpdateProgress(input.args)};
    if(input.method==='cancelRepositoryUpdate')return {ok:true,value:await updateCoordinator.cancelRepositoryUpdate(input.args)};
    if(applicationAccountMethods.has(input.method))return {ok:true,value:await applicationAuth.request(input.method,input.args)};
    if(githubAccountMethods.has(input.method))return {ok:true,value:await githubAccount.request(input.method,input.args)};
    if(input.method==='savePackageExport'){
      if(pickerPending||pendingClose)throw Error('Wait for the current file picker or close operation.');
      pickerPending=true;try{
        // Build revalidates the reviewed saved set before any destination is written.
        const output=await service.buildPackageExport(input.args);
        const selected=await dialog.showSaveDialog(window,{title:'Export saved files',defaultPath:output.filename,buttonLabel:'Save export',filters:[{name:'ZIP archive',extensions:['zip']}]});
        if(selected.canceled||!selected.filePath)return {ok:true,value:{saved:false}};
        if(!trusted(event)||pendingClose)throw Error('The document window changed. Review the export again.');
        const saved=saveExportDestination(selected.filePath,output.bytes,[dataRoot,profileRoot]);
        return {ok:true,value:{...saved,sha256:output.sha256}};
      }finally{pickerPending=false;}
    }
    if(input.method==='pickExternalFiles'){
      if(input.args!==undefined||pickerPending)throw Object.assign(Error('A file picker is already open.'),{code:'IMPORT_BUSY'});
      pickerPending=true;
      try{
        let properties=['openFile','openDirectory','multiSelections','noResolveAliases'];
        // Linux portals/GTK cannot select files and directories in one dialog.
        // Keep the shared import command, then choose the native picker mode.
        if(process.platform==='linux'){
          const choice=await dialog.showMessageBox(window,{type:'question',title:'Import files and folders',message:'Choose files or folders to import.',detail:'Copies are added to this repository. Originals stay in their current location.',buttons:['Files','Folders','Cancel'],defaultId:0,cancelId:2});
          if(choice.response!==0&&choice.response!==1)return {ok:true,value:null};
          if(!trusted(event))throw Object.assign(Error('The destination view changed.'),{code:'VIEW_UNAVAILABLE'});
          properties=[choice.response===0?'openFile':'openDirectory','multiSelections'];
        }
        const selected=await dialog.showOpenDialog(window,{title:'Import files and folders',buttonLabel:'Import',message:'Copy into this repository. Original files stay in their current location.',properties});
        if(selected.canceled||!selected.filePaths.length)return {ok:true,value:null};
        if(!trusted(event))throw Object.assign(Error('The destination view changed.'),{code:'VIEW_UNAVAILABLE'});
        return {ok:true,value:await externalTickets.register(event.sender.id,selected.filePaths)};
      }finally{pickerPending=false;}
    }
    if (!methods.has(input.method)) throw Error('Unknown native operation.');
    return {ok: true, value: await service[input.method](input.args)};
  } catch (error) {return respondError(error);}
});
ipcMain.on('asmb:close-ready', async (event, result) => {
  if (!trusted(event) || !pendingClose || pendingClose.phase !== 'preparing' || result?.requestId !== pendingClose.requestId || typeof result.ok !== 'boolean') return;
  if (!result.ok) {await closeFailed(typeof result.error === 'string' ? result.error : 'Drafts could not be preserved.'); return;}
  pendingClose.phase = 'draining';
  try {
    await service.drain();
    try {await Promise.all([cloneCoordinator.drain(), updateCoordinator.drain(), applyCoordinator.drain()]); await artifactHost?.close(); await applicationAuth.close(); await githubAuth.close(); await Promise.all([cloneCoordinator.close(), updateCoordinator.close(), applyCoordinator.close()]); await stopAutomation(); await service.close();} catch (error) {terminalFailure = error.message; throw error;}
    clearTimeout(pendingClose.timer); pendingClose = null; allowQuit = true;
    window.destroy(); app.quit();
  } catch (error) {if (terminalFailure) {clearTimeout(pendingClose.timer); pendingClose = null; await holdForRecovery(terminalFailure);} else await closeFailed(error.message);}
});
async function holdForRecovery(message) {
  if (recoveryDialog || !window || window.isDestroyed()) return;
  recoveryDialog = true;
  try {
    const result = await dialog.showMessageBox(window, {type: 'error', title: 'Local storage needs recovery', message: 'The preview is held because local storage could not close cleanly.', detail: `${message}\nThe editor remains locked. Existing files and recovery records are retained; no further edits can be saved in this session.`, buttons: ['Keep window open', 'Quit preview'], defaultId: 0, cancelId: 0});
    if (result.response === 1) {allowQuit = true; window.destroy(); app.quit();}
  } finally {recoveryDialog = false;}
}
async function recoverRenderer(reason) {
  artifactHost?.stop();
  if (allowQuit || pendingClose?.phase === 'draining' || recoveryDialog) return;
  if (pendingClose) {clearTimeout(pendingClose.timer); pendingClose = null; service.resumeSearch(); applicationAuth.resume(); githubAccount.resume(); cloneCoordinator.resume(); updateCoordinator.resume(); applyCoordinator.resume();}
  recoveryDialog = true;
  try {
    externalTickets?.releaseOwner(window.webContents.id);
    await Promise.all([stopAutomation(),service.prepareSearchClose(), applicationAuth.prepareClose(), githubAccount.prepareClose(), cloneCoordinator.prepareClose(), updateCoordinator.prepareClose(), applyCoordinator.prepareClose()]);
    await service.drain();
    const result = await dialog.showMessageBox(window, {type: 'error', title: 'The editor stopped', message: 'The editor process stopped unexpectedly.', detail: `Reason: ${reason}. Saved files and acknowledged drafts remain in the managed workspace. Edits that had not reached a checkpoint may be missing.`, buttons: ['Reopen editor', 'Quit preview'], defaultId: 0, cancelId: 0});
    if (result.response === 0) {service.resumeSearch(); applicationAuth.resume(); githubAccount.resume(); cloneCoordinator.resume(); updateCoordinator.resume(); applyCoordinator.resume(); await window.loadURL(pageURL);}
    else {await Promise.all([cloneCoordinator.close(), updateCoordinator.close(), applyCoordinator.close()]); await artifactHost?.close(); await applicationAuth.close(); await githubAuth.close(); await stopAutomation(); await service.close(); allowQuit = true; window.destroy(); app.quit();}
  } catch (error) {terminalFailure = error.message;}
  finally {recoveryDialog = false;}
  if (terminalFailure) await holdForRecovery(terminalFailure);
}
app.on('before-quit', event => {if (!allowQuit && window && !window.isDestroyed()) {event.preventDefault(); requestClose();}});
app.on('window-all-closed', () => {if (allowQuit) app.quit();});
app.once('quit', (_event, exitCode) => {
  if (!allowQuit || exitCode !== 0) return;
  try {linuxTemporaryDirectory?.cleanup();} catch (error) {console.error('Linux temporary files were retained:', error.message);}
});

async function start() {
try {
  if (startupFailure) throw startupFailure;
  if (!app.requestSingleInstanceLock()) {allowQuit = true; app.quit();} else {
    app.on('second-instance', () => {if (window && !window.isDestroyed()) {window.restore(); window.focus();}});
    const bundledDocs = loadBundledDocs(path.resolve(here, '../..'), {packaged: app.isPackaged, metadata: packageMetadata});
    await app.whenReady();
    storageAdmission = await prepareNativeStorage({dataRoot, confirmRecovery: async () => {
      const choice = await dialog.showMessageBox({type: 'question', title: 'Restore workspace access',
        message: 'Your computer identifies this drive differently.',
        detail: 'asMagicBrain checked your saved storage records. It can back up your workspace, drafts and local Git history, then restore access. The backup will be kept in asMagicBrain-recovery-backups beside your asMagicBrain folder.',
        buttons: ['Quit', 'Back Up and Restore Access'], defaultId: 0, cancelId: 0, noLink: true});
      return choice.response === 1;
    }});
    service = await createNativeService({dataRoot,bundledDocs,storageIdentity:storageAdmission.context,profileLock:storageAdmission.profileLock,revealInFileManager:filename=>shell.showItemInFolder(filename)});
    externalTickets=createExternalFileTickets({prepare:paths=>service.prepareExternalFiles(paths),importFiles:(request,options)=>service.importExternalFiles(request,options)});
    // Account credentials live only in this main process. Existing encrypted
    // account files are deliberately neither opened nor changed by this policy.
    applicationAuth = createApplicationAuth({config: applicationAccount, AuthClient, storagePolicy: 'session', fetch: (...args) => globalThis.fetch(...args),
      openExternal: value => {const url = new URL(value); if (url.origin !== applicationAccount.origin || url.pathname !== '/auth/v1/authorize') throw Error('Invalid account authorization URL.'); return shell.openExternal(url.href);}});
    githubAuth = createGitHubAuth({clientId:githubApp.clientId,storagePolicy:'session',fetch:(...args)=>globalThis.fetch(...args),
      openExternal:url=>{if(url!=='https://github.com/login/device')throw Error('Invalid GitHub verification URL.');return shell.openExternal(url);}});
    cloneCoordinator = createCloneCoordinator({clone:(request,options)=>service.cloneRepository(request,options),getCredential:()=>githubAuth.getCredential()});
    updateCoordinator = createUpdateCoordinator({check:(request,options)=>service.checkRepositoryUpdates(request,options),getCredential:()=>githubAuth.getCredential()});
    applyCoordinator = createApplyCoordinator({apply:(request,options)=>service.applyRepositoryUpdate(request,options)});
    githubAccount = createGitHubAccountCoordinator({auth:githubAuth,cloneCoordinator,updateCoordinator});
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'clipboard-sanitized-write' && wc === window?.webContents && isApplicationPage(wc.getURL())));
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'clipboard-sanitized-write' && wc === window?.webContents && isApplicationPage(wc.getURL()));
    const dist = path.join(here, 'dist');
    const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};
    protocol.handle('app', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'asmagicbrain' || request.method !== 'GET') return new Response('Unavailable', {status: 404});
        const filename = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
        if (!filename.startsWith(dist + path.sep) || fs.realpathSync(filename) !== filename || !fs.statSync(filename).isFile()) return new Response('Unavailable', {status: 404});
        const type = types[path.extname(filename)];
        if (!type) return new Response('Unavailable', {status: 404});
        return new Response(fs.readFileSync(filename), {headers: {'Content-Type': type, 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff'}});
      } catch {return new Response('Unavailable', {status: 404});}
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label: 'asMagicBrain', submenu: [{label: 'Quit asMagicBrain', accelerator: 'CmdOrCtrl+Q', click: requestClose}]},
      {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
      ...(process.platform === 'darwin' ? [{label: 'View', submenu: [{role: 'togglefullscreen', accelerator: 'Control+Command+F'}]}] : []),
      {label: 'Window', submenu: [{role: 'minimize'}, {role: 'zoom'}, {label: 'Close', accelerator: 'CmdOrCtrl+W', click: requestClose}]},
    ]));
    window = new BrowserWindow({width: 1440, height: 1000, minWidth: 360, minHeight: 480, title: 'asMagicBrain',
      // Native macOS controls sit in the shared 40px titlebar content area. The
      // green button uses AppKit fullscreen; red still reaches the close guard.
      ...(process.platform === 'darwin' ? {frame: true, titleBarStyle: 'hidden', trafficLightPosition: {x: 14, y: 14}, fullscreenable: true} : {frame: false}),
      autoHideMenuBar: process.platform === 'linux', show: false, backgroundColor: '#ffffff', webPreferences: {preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false}});
    artifactHost=createArtifactHost({owner:window,WebContentsView,session,app,readSnapshot:request=>service.prepareArtifactSnapshot(request)});
    window.once('closed',()=>{void artifactHost?.close();});
    window.webContents.setWindowOpenHandler(({url}) => {openExternal(url); return {action: 'deny'};});
    window.webContents.on('will-navigate', (event, url) => {if (!isApplicationPage(url)) {event.preventDefault(); openExternal(url);}});
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const owner=window.webContents.id;
    window.webContents.on('did-start-navigation',details=>{if(details.isMainFrame&&!details.isSameDocument){artifactHost?.stop();externalTickets.releaseOwner(owner);}});
    window.webContents.once('destroyed',()=>{artifactHost?.stop();externalTickets.releaseOwner(owner);});
    window.on('close', event => {if (!allowQuit) {event.preventDefault(); requestClose();}});
    window.once('ready-to-show', () => window.show());
    window.webContents.on('render-process-gone', (_event, details) => {console.error('Native renderer exited:', details.reason); void recoverRenderer(details.reason);});
    await window.loadURL(pageURL);
  }
} catch (error) {
  if (error.code === 'STORAGE_RECOVERY_CANCELLED') {allowQuit = true; app.exit(0); return;}
  console.error('asMagicBrain could not start:', startupFailureMessage(error));
  allowQuit = true;
  await Promise.all([cloneCoordinator?.close().catch(() => {}), updateCoordinator?.close().catch(() => {}), applyCoordinator?.close().catch(() => {})]);
  await artifactHost?.close().catch(() => {});
  await applicationAuth?.close().catch(() => {});
  await githubAuth?.close().catch(() => {});
  await service?.close().catch(() => {});
  try {storageAdmission?.profileLock.release();} catch {}
  dialog.showErrorBox('asMagicBrain could not start', startupFailureMessage(error));
  app.exit(1);
}

}
// Electron waits for ESM evaluation before ready; never await readiness at module scope.
void start();
