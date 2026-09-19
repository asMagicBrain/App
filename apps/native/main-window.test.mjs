import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {parseSync} from '../../ui-workshop/node_modules/oxc-parser/src-js/index.js';
import {resolveBuildConfiguration} from './build-channel.mjs';
import {startupFailureMessage} from './startup.mjs';

const mainURL = new URL('./main.mjs', import.meta.url);
const mainSource = fs.readFileSync(mainURL, 'utf8');
const parsed = parseSync(mainURL.pathname, mainSource);
assert.equal(parsed.errors.length, 0);
// Run the actual startup/IPC/close implementation with injected platform services.
// Only imports and import.meta.url need substitution to execute it in node:vm.
let executable = mainSource;
for (const statement of [...parsed.program.body].reverse()) {
  if (statement.type === 'ImportDeclaration') executable = executable.slice(0, statement.start) + executable.slice(statement.end);
}
executable = executable.replaceAll('import.meta.url', JSON.stringify(mainURL.href));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

async function harness({drain, channel = 'development', startupError, temporaryError, platform = 'darwin', sandboxDisabled = false, pickerChoice = 0, pickerSelection = {canceled: false, filePaths: ['/fixture/originals/note.md']}} = {}) {
  const events = [], windows = [], dialogs = [], timers = new Set(), handlers = new Map(), errors = [];
  const openedExternal = [], revealed = [], pickerDialogs = [], registered = [], authOptions = [];
  let sandboxEnables = 0, serviceOptions, temporaryAllocations = 0;
  const paths = new Map(), environment = {};
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, getPath: () => '/fixture/app-data', setPath: (key, value) => paths.set(key, value), setName() {}, setAppLogsPath() {},
    commandLine: {hasSwitch: name => name === 'no-sandbox' && sandboxDisabled}, enableSandbox: () => {sandboxEnables++;},
    requestSingleInstanceLock: () => true, whenReady: async () => {},
    quit: () => {events.push('app.quit'); app.emit('quit', {}, 0);}, exit: code => events.push(`app.exit:${code}`),
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      const contents = this.webContents = new EventEmitter();
      Object.assign(contents, {
        id: windows.length, mainFrame: {url: ''}, getURL: () => contents.mainFrame.url,
        send: (channel, message) => events.push({channel, message}),
        setWindowOpenHandler: callback => {contents.windowOpenHandler = callback;},
      });
    }
    async loadURL(url) {this.webContents.mainFrame.url = url; events.push(`load:${url}`);}
    isDestroyed() {return this.destroyed;}
    destroy() {
      assert.equal(this.destroyed, false, 'main window is destroyed only once');
      this.destroyed = true; events.push('window.destroy'); this.webContents.emit('destroyed'); this.emit('closed');
    }
    show() {} restore() {} focus() {} minimize() {events.push('window.minimize');} maximize() {this.maximized = true;} unmaximize() {this.maximized = false;} isMaximized() {return Boolean(this.maximized);}
  }
  const lifecycle = name => ({
    prepareClose: async () => {events.push(`${name}.prepare`);},
    resume: () => events.push(`${name}.resume`),
    drain: async () => {events.push(`${name}.drain`);},
    close: async () => {events.push(`${name}.close`);},
  });
  const service = {
    prepareSearchClose: async () => {events.push('service.prepare');}, resumeSearch: () => events.push('service.resume'),
    drain: async () => {events.push('service.drain'); if (drain) await drain.promise;},
    close: async () => {events.push('service.close');},
  };
  const applicationAuth = lifecycle('application'), githubAuth = lifecycle('github');
  const clone = lifecycle('clone'), update = lifecycle('update'), apply = lifecycle('apply'), githubAccount = lifecycle('githubAccount');
  const externalTickets = {releaseOwner: () => events.push('tickets.release'), register: async (owner, paths) => {registered.push({owner, paths}); return {ticket: 'fixture-ticket'};}};
  const Menu = {buildFromTemplate: template => template, setApplicationMenu: menu => {Menu.menu = menu;}};
  const protocol = {registerSchemesAsPrivileged() {}, handle() {}};
  const session = {defaultSession: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}}};
  const dialog = {showMessageBox: async (_window, options) => {dialogs.push(options); return {response: options.title === 'Import files and folders' ? pickerChoice : 0};}, showErrorBox: (title, content) => dialogs.push({title, content}),
    showOpenDialog: async (_window, options) => {pickerDialogs.push(options); return await pickerSelection;}};
  vm.runInNewContext(executable, {
    app, BrowserWindow, dialog, ipcMain, Menu, protocol, session,
    shell: {openExternal: async value => {openedExternal.push(value);}, showItemInFolder: value => revealed.push(value)},
    fs, path, URL, Response, fileURLToPath, randomUUID: () => `close-${timers.size + events.length}`,
    process: {argv: ['fixture', `--channel=${channel}`], env: environment, platform}, console: {error: (...args) => errors.push(args)},
    setTimeout: () => {const timer = {unref() {}}; timers.add(timer); return timer;}, clearTimeout: timer => timers.delete(timer),
    resolveNativeStartup: options => {if (startupError) throw startupError; return {configuration: resolveBuildConfiguration(options), testRoot: '/fixture/asMagicBrain-Test', paths: {dataRoot: '/fixture/data', profileRoot: '/fixture/profile', temporaryRoot: '/fixture/tmp'}};},
    startupFailureMessage, ensurePhysicalDirectory: value => value,
    createLinuxRuntimeTemporaryDirectory: () => {temporaryAllocations++; if (temporaryError) throw temporaryError; return {directory: '/run/user/fixture/asmb-short', cleanup: () => events.push('linux-temp.cleanup')};},
    assertGitRuntime: () => ({kind:'bundled'}),
    loadBundledDocs: () => ({root: '/fixture/docs', manifest: {version: '0.2.10'}}),
    admitNativeProfile: options => assert.equal(options.channel, channel),
    createNativeService: async options => {serviceOptions = options; events.push('service.created'); return service;}, createExternalFileTickets: () => externalTickets,
    createApplicationAuth: options => {authOptions.push(options); return applicationAuth;}, applicationAccountMethods: new Set(), applicationAccount: {origin: 'https://account.example.invalid'}, AuthClient: class {},
    createGitHubAuth: options => {authOptions.push(options); return githubAuth;}, githubApp: {clientId: 'fixture'}, createCloneCoordinator: () => clone,
    createUpdateCoordinator: () => update, createApplyCoordinator: () => apply,
    createGitHubAccountCoordinator: () => githubAccount, githubAccountMethods: new Set(),
  }, {filename: fileURLToPath(mainURL)});
  await settle();
  if (startupError || temporaryError || sandboxDisabled) return {events, dialogs, windows, errors, sandboxEnables, temporaryAllocations, paths, environment};
  assert.deepEqual(errors, []); assert.equal(windows.length, 1);
  const window = windows[0], sender = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
  const close = Menu.menu.find(item => item.label === 'Window').submenu.find(item => item.label === 'Close').click;
  const quit = Menu.menu[0].submenu[0].click;
  const closeMessage = () => events.filter(event => event?.channel === 'asmb:prepare-close' && !event.message.cancelled).at(-1)?.message;
  return {app, windows, window, sender, handlers, ipcMain, close, quit, closeMessage, events, dialogs, timers, errors, sandboxEnables, openedExternal, revealed, pickerDialogs, registered, authOptions, serviceOptions, temporaryAllocations, paths, environment};
}

test('startup storage failure shows a native explanation and exits without opening a workspace or editor', async () => {
  const h=await harness({startupError:Object.assign(Error('storage denied'),{code:'EACCES'})});
  assert.equal(h.windows.length,0);
  assert.equal(h.dialogs.length,1);
  assert.equal(h.dialogs[0].title,'asMagicBrain could not start');
  assert.match(h.dialogs[0].content,/read and write/);
  assert.match(h.dialogs[0].content,/Error: EACCES/);
  assert.ok(!h.events.includes('service.created'));
  assert.deepEqual(h.events,['app.exit:1']);
});

test('native startup creates one sandboxed main window and exposes no companion IPC', async () => {
  const h = await harness();
  assert.equal(h.window.webContents.getURL(), 'app://asmagicbrain/index.html');
  assert.equal(h.window.options.parent, undefined);
  assert.equal(h.window.options.webPreferences.preload, fileURLToPath(new URL('./preload.cjs', import.meta.url)));
  assert.equal(h.window.options.webPreferences.sandbox, true);
  assert.equal(h.window.options.webPreferences.contextIsolation, true);
  assert.equal(h.window.options.webPreferences.nodeIntegration, false);
  assert.equal(h.sandboxEnables, 1);
  assert.deepEqual([...h.handlers.keys()].sort(), ['asmb:external-files', 'asmb:native']);
  assert.deepEqual(h.ipcMain.eventNames(), ['asmb:close-ready']);
  const result = await h.handlers.get('asmb:native')(h.sender, {method: 'setOutlineState', args: {open: true}});
  assert.equal(result.ok, false); assert.match(result.error.message, /Unknown native operation/);
  assert.equal(h.windows.length, 1, 'retired requests cannot create another window');
});

test('Linux keeps the shared frameless window controls and session-only accounts with a sandbox', async () => {
  const h = await harness({platform: 'linux', channel: 'preview'}), invoke = h.handlers.get('asmb:native');
  assert.equal(h.window.options.frame, false);
  assert.equal(h.window.options.autoHideMenuBar, true);
  assert.equal(h.window.options.webPreferences.sandbox, true);
  assert.equal(h.sandboxEnables, 1);
  await invoke(h.sender, {method: 'windowAction', args: 'minimize'});
  assert.ok(h.events.includes('window.minimize'));
  await invoke(h.sender, {method: 'windowAction', args: 'maximize'}); assert.equal(h.window.isMaximized(), true);
  await invoke(h.sender, {method: 'windowAction', args: 'maximize'}); assert.equal(h.window.isMaximized(), false);
  assert.equal(h.authOptions.length, 2);
  for (const options of h.authOptions) {
    assert.equal(options.storagePolicy, 'session'); assert.equal(options.storage, undefined); assert.equal(options.profileRoot, undefined);
  }
  await invoke(h.sender, {method: 'windowAction', args: 'close'}); await settle();
  assert.ok(h.closeMessage()?.requestId); assert.equal(h.window.isDestroyed(), false);
});

test('an explicit sandbox bypass is rejected before profiles, host services or windows open', async () => {
  const h = await harness({platform: 'linux', sandboxDisabled: true});
  assert.equal(h.windows.length, 0); assert.equal(h.sandboxEnables, 0);
  assert.deepEqual(h.events, ['app.exit:1']);
  assert.match(h.dialogs[0].content, /SANDBOX_REQUIRED/);
});

test('Linux short runtime temp is distinct from durable profiles and cleans only after normal quit', async () => {
  const h = await harness({platform: 'linux'});
  assert.equal(h.temporaryAllocations, 1);
  assert.equal(h.paths.get('temp'), '/run/user/fixture/asmb-short');
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(h.environment[name], '/run/user/fixture/asmb-short');
  assert.equal(h.paths.get('userData'), '/fixture/profile');
  assert.equal(h.paths.get('sessionData'), '/fixture/profile/session');
  assert.equal(h.serviceOptions.dataRoot, '/fixture/data');
  h.close(); await settle(); assert.equal(h.events.includes('linux-temp.cleanup'), false);
  h.ipcMain.emit('asmb:close-ready', h.sender, {...h.closeMessage(), ok: true}); await settle();
  assert.ok(h.events.indexOf('linux-temp.cleanup') > h.events.indexOf('app.quit'));
  assert.ok(h.events.indexOf('linux-temp.cleanup') > h.events.indexOf('service.close'));
  const mac = await harness({platform: 'darwin'});
  assert.equal(mac.temporaryAllocations, 0); assert.equal(mac.paths.get('temp'), '/fixture/tmp');
  assert.equal(mac.environment.TMPDIR, '/fixture/tmp');
  const failed = await harness({platform: 'linux'});
  failed.app.emit('quit', {}, 1); assert.equal(failed.events.includes('linux-temp.cleanup'), false);
});

test('unsafe Linux runtime temp fails before services or windows with a clear retained-data error', async () => {
  const h = await harness({platform: 'linux', temporaryError: Object.assign(Error('unsafe runtime'), {code: 'ASMB_RUNTIME_TEMP'})});
  assert.equal(h.temporaryAllocations, 1); assert.equal(h.windows.length, 0);
  assert.equal(h.events.includes('service.created'), false); assert.equal(h.events.includes('linux-temp.cleanup'), false);
  assert.match(h.dialogs[0].content, /XDG_RUNTIME_DIR/); assert.match(h.dialogs[0].content, /Existing files and recovery records are retained/);
  assert.match(h.dialogs[0].content, /ASMB_RUNTIME_TEMP/);
});

test('Linux native picker admits either files or folders and keeps cancellation inert', async () => {
  for (const [pickerChoice, expected] of [[0, 'openFile'], [1, 'openDirectory']]) {
    const h = await harness({platform: 'linux', pickerChoice});
    const result = await h.handlers.get('asmb:native')(h.sender, {method: 'pickExternalFiles'});
    assert.equal(result.ok, true); assert.equal(result.value.ticket, 'fixture-ticket');
    assert.deepEqual(Array.from(h.pickerDialogs[0].properties), [expected, 'multiSelections']);
    assert.deepEqual(h.registered, [{owner: h.window.webContents.id, paths: ['/fixture/originals/note.md']}]);
    assert.equal(h.dialogs[0].cancelId, 2);
  }
  for (const options of [{pickerChoice: 2}, {pickerSelection: {canceled: true, filePaths: []}}]) {
    const h = await harness({platform: 'linux', ...options});
    const result = await h.handlers.get('asmb:native')(h.sender, {method: 'pickExternalFiles'});
    assert.equal(result.ok, true); assert.equal(result.value, null); assert.deepEqual(h.registered, []);
    if (options.pickerChoice === 2) assert.equal(h.pickerDialogs.length, 0);
  }
});

test('macOS retains its combined picker while pending or stale native selections cannot gain tickets', async () => {
  const selection = deferred(), h = await harness({pickerSelection: selection.promise});
  const invoke = h.handlers.get('asmb:native');
  const first = invoke(h.sender, {method: 'pickExternalFiles'});
  await settle();
  assert.equal(h.dialogs.length, 0);
  assert.deepEqual(Array.from(h.pickerDialogs[0].properties), ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases']);
  assert.equal((await invoke(h.sender, {method: 'pickExternalFiles'})).error.code, 'IMPORT_BUSY');
  h.window.webContents.mainFrame = {url: 'app://asmagicbrain/index.html'};
  selection.resolve({canceled: false, filePaths: ['/fixture/originals/note.md']});
  assert.equal((await first).error.code, 'VIEW_UNAVAILABLE'); assert.deepEqual(h.registered, []);
});

test('Linux dispatches admitted external links and reveal paths through Electron shell only', async () => {
  const h = await harness({platform: 'linux'});
  for (const url of ['https://example.invalid/note', 'http://example.invalid/', 'mailto:test@example.invalid']) {
    assert.equal(h.window.webContents.windowOpenHandler({url}).action, 'deny');
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,unsafe', 'invalid']) h.window.webContents.windowOpenHandler({url});
  await settle();
  assert.deepEqual(h.openedExternal, ['https://example.invalid/note', 'http://example.invalid/', 'mailto:test@example.invalid']);
  h.serviceOptions.revealInFileManager('/fixture/repository/图 example.md');
  assert.deepEqual(h.revealed, ['/fixture/repository/图 example.md']);
});

test('the main process exposes its admitted channel read-only to the trusted window', async () => {
  for (const channel of ['development', 'preview']) {
    const h = await harness({channel});
    const invoke = h.handlers.get('asmb:native');
    const result = await invoke(h.sender, {method: 'getBuildConfiguration'});
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, resolveBuildConfiguration({args: [`--channel=${channel}`]}));
    assert.equal((await invoke(h.sender, {method: 'getBuildConfiguration', args: {channel: 'development'}})).ok, false);
    assert.equal((await invoke({...h.sender, senderFrame: {url: 'https://untrusted.invalid/'}}, {method: 'getBuildConfiguration'})).ok, false);
  }
});

test('native Close and Quit preserve renderer acknowledgement and drain ordering', async () => {
  const drain = deferred(), h = await harness({drain});
  assert.equal(h.close, h.quit, 'Close and Quit share the same preservation path');
  h.close(); await settle();
  assert.equal(h.window.isDestroyed(), false); assert.equal(h.timers.size, 1);
  for (const name of ['service', 'application', 'githubAccount', 'clone', 'update', 'apply']) assert.ok(h.events.includes(`${name}.prepare`));
  const request = h.closeMessage(); assert.ok(request?.requestId);
  h.ipcMain.emit('asmb:close-ready', {...h.sender, senderFrame: {url: h.sender.senderFrame.url}}, {...request, ok: true});
  h.ipcMain.emit('asmb:close-ready', h.sender, {requestId: 'stale-request', ok: true});
  await settle(); assert.equal(h.events.includes('service.drain'), false, 'only the current main frame and request can acknowledge');
  h.ipcMain.emit('asmb:close-ready', h.sender, {...request, ok: true});
  await settle(); assert.ok(h.events.includes('service.drain')); assert.equal(h.window.isDestroyed(), false);
  drain.resolve(); await settle();
  assert.equal(h.window.isDestroyed(), true); assert.equal(h.timers.size, 0);
  assert.ok(h.events.indexOf('service.close') < h.events.indexOf('window.destroy'));
  for (const name of ['application', 'github', 'clone', 'update', 'apply']) assert.ok(h.events.indexOf(`${name}.close`) < h.events.indexOf('window.destroy'));
  assert.ok(h.events.indexOf('window.destroy') < h.events.indexOf('app.quit'));
  assert.deepEqual(h.errors, []);
});

test('refused draft preservation leaves the main window alive and supports a normal retry', async () => {
  const h = await harness();
  h.close(); await settle();
  const request = h.closeMessage();
  h.ipcMain.emit('asmb:close-ready', h.sender, {...request, ok: false, error: 'Draft checkpoint failed.'});
  await settle();
  assert.equal(h.window.isDestroyed(), false); assert.equal(h.timers.size, 0); assert.equal(h.events.includes('service.drain'), false);
  for (const name of ['service', 'application', 'githubAccount', 'clone', 'update', 'apply']) assert.ok(h.events.includes(`${name}.resume`));
  assert.equal(h.dialogs[0].title, 'Work is still open');
  h.close(); await settle();
  const retry = h.closeMessage(); assert.notEqual(retry.requestId, request.requestId);
  h.ipcMain.emit('asmb:close-ready', h.sender, {...retry, ok: true}); await settle();
  assert.equal(h.window.isDestroyed(), true); assert.equal(h.timers.size, 0); assert.deepEqual(h.errors, []);
});

test('window close event and system quit enter the same bounded preservation request', async () => {
  const h = await harness(); let prevented = 0;
  h.window.emit('close', {preventDefault: () => {prevented++;}});
  h.app.emit('before-quit', {preventDefault: () => {prevented++;}});
  await settle();
  assert.equal(prevented, 2); assert.equal(h.timers.size, 1);
  assert.equal(h.events.filter(event => event?.channel === 'asmb:prepare-close').length, 1);
  assert.equal(h.window.isDestroyed(), false);
});

test('production preload exposes only the main API and preserves the close handshake', async () => {
  const exposed = new Map(), listeners = new Map(), sent = [], invokes = [];
  vm.runInNewContext(fs.readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {exposeInMainWorld: (name, api) => exposed.set(name, api)}, webUtils: {},
        ipcRenderer: {
          invoke: async (...args) => {invokes.push(args); return {ok: true};},
          on: (name, callback) => listeners.set(name, callback), removeListener: name => listeners.delete(name),
          send: (...args) => sent.push(args),
        },
      };
    },
  });
  assert.deepEqual([...exposed.keys()], ['asMagicBrain']);
  const bridge = exposed.get('asMagicBrain');
  assert.equal(bridge.setOutlineState, undefined); assert.equal(bridge.onOutlineAction, undefined);
  const received = [], unsubscribe = bridge.onPrepareClose(message => received.push(message));
  const request = {requestId: 'draft-drain'};
  listeners.get('asmb:prepare-close')(null, request); assert.deepEqual(received, [request]);
  bridge.closeReady({...request, ok: true}); assert.deepEqual(sent, [['asmb:close-ready', {...request, ok: true}]]);
  unsubscribe(); assert.equal(listeners.size, 0);
  await bridge.windowAction('close');
  assert.equal(invokes[0][0], 'asmb:native'); assert.equal(invokes[0][1].method, 'windowAction'); assert.equal(invokes[0][1].args, 'close');
});
