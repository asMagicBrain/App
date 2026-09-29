import fs from 'node:fs';
import path from 'node:path';
import {persistentIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import {createPrivateStore} from '../private-store.mjs';
import {pinDirectory, checkDirectory} from '../physical-roots.mjs';
import {inspectPluginPackage, PLUGIN_HOST_API_VERSION} from './format.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validRequestId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;
function directory(filename) {
  try { fs.mkdirSync(filename, {mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid() !== null && stat.uid !== uid())) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
  return pinDirectory(filename);
}
function syncDirectory(pin) {
  checkDirectory(pin); const fd = fs.openSync(pin.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { if (persistentIdentity(fs.fstatSync(fd)) !== pin.identity) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  checkDirectory(pin);
}
function writeArchive(parent, filename, bytes) {
  checkDirectory(parent); const target = path.join(parent.path, filename);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(parent); return target;
}
function readArchive(parent, name = 'package.asmbplugin') {
  checkDirectory(parent); const filename=path.join(parent.path,name);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (uid() !== null && stat.uid !== uid())) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), live = fs.lstatSync(filename);
    if (before.dev !== live.dev || before.ino !== live.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    checkDirectory(parent); return bytes;
  } finally { fs.closeSync(fd); }
}
function optionalDirectory(filename) {
  try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return pinDirectory(filename);
}
function validDescriptor(value) {
  return exact(value, ['version','digest','directory','manifest']) && typeof value.version === 'string' && validHash(value.digest)
    && value.directory === value.digest && value.manifest?.version === value.version && validId(value.manifest?.id);
}
function validEntry(value) {
  return exact(value, ['id','current','previous','enabled']) && validId(value.id) && validDescriptor(value.current)
    && (value.previous === null || validDescriptor(value.previous)) && value.current.manifest.id === value.id
    && (value.previous === null || value.previous.manifest.id === value.id) && typeof value.enabled === 'boolean';
}
function validReceipt(value) {
  return exact(value, ['requestId','kind','pluginId','digest']) && validRequestId(value.requestId)
    && ['install','rollback','uninstall'].includes(value.kind) && validId(value.pluginId) && (value.digest === null || validHash(value.digest));
}
function validPending(value) {
  if (value === null || !exact(value, value?.kind === 'install'
    ? ['kind','requestId','pluginId','target','stageIdentity'] : ['kind','requestId','pluginId','sourceIdentity'])) return value === null;
  return validRequestId(value.requestId) && validId(value.pluginId) && (value.kind === 'install'
    ? validDescriptor(value.target) && value.target.manifest.id === value.pluginId && typeof value.stageIdentity === 'string' && /^\d+:\d+$/u.test(value.stageIdentity)
    : value.kind === 'uninstall' && typeof value.sourceIdentity === 'string' && /^\d+:\d+$/u.test(value.sourceIdentity));
}
function validState(value) {
  return exact(value, ['schemaVersion','plugins','pending','receipts']) && value.schemaVersion === 1 && Array.isArray(value.plugins)
    && value.plugins.length <= 64 && value.plugins.every(validEntry) && new Set(value.plugins.map(item => item.id)).size === value.plugins.length
    && validPending(value.pending) && Array.isArray(value.receipts) && value.receipts.length <= 64 && value.receipts.every(validReceipt)
    && new Set(value.receipts.map(item => item.requestId)).size === value.receipts.length;
}
const copy = value => structuredClone(value);

/** Host-owned local package lifecycle. Installed archives remain inert bytes. */
export function createPluginPackageManager({privateRoot, bindingHash, hostApiVersion = PLUGIN_HOST_API_VERSION, hooks = {}} = {}) {
  if (typeof privateRoot !== 'string' || !path.isAbsolute(privateRoot) || typeof bindingHash !== 'string' || !validHash(bindingHash)) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
  const root = pinDirectory(privateRoot), ledger = directory(path.join(root.path, 'ledger')),
    installed = directory(path.join(root.path, 'installed')), staging = directory(path.join(root.path, 'staging')),
    retired = directory(path.join(root.path, 'retired'));
  const store = createPrivateStore({privateRoot:ledger.path, bindingHash, hooks:{at:(point, detail)=>hooks.at?.(`plugin-store:${point}`,detail)}});
  let scan = store.ensureDurable(store.scan());
  if (scan.blocked) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
  for (const event of scan.events) if (!validState(event.payload)) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
  let state = scan.events.at(-1)?.payload ?? {schemaVersion:1,plugins:[],pending:null,receipts:[]};
  function persist(next) {
    if (!validState(next)) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    if (scan.tailRecords >= 24 || scan.coveredFiles.length) scan = store.compact(scan, state);
    scan = store.append(scan, 'draft', next); if (scan.blocked) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED'); state = next;
  }
  const pluginDirectory = (pluginId, create = false) => {
    const filename = path.join(installed.path, pluginId), stat = (() => {try{return fs.lstatSync(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}})();
    if (!stat) { if (!create) return null; return directory(filename); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED'); return pinDirectory(filename);
  };
  function verifyDescriptor(descriptor) {
    try {
      const parent=pluginDirectory(descriptor.manifest.id), version=parent&&optionalDirectory(path.join(parent.path,descriptor.directory));
      if(!parent||!version)fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');checkDirectory(parent);
      const inspected = inspectPluginPackage(readArchive(version), {hostApiVersion});
      if (!inspected.compatible || inspected.digest !== descriptor.digest || inspected.manifest.id !== descriptor.manifest.id
        || inspected.manifest.version !== descriptor.version || JSON.stringify(inspected.manifest) !== JSON.stringify(descriptor.manifest)) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
      return inspected;
    } catch (error) { if(error?.code==='PLUGIN_PACKAGE_RECOVERY_REQUIRED')throw error;fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED'); }
  }
  function receipt(next, value) { return [...next.slice(-63), value]; }
  function completeInstall(pending) {
    const stagePath = path.join(staging.path, pending.requestId), parent = pluginDirectory(pending.pluginId, true), destination = path.join(parent.path, pending.target.directory);
    const stage = optionalDirectory(stagePath), target = optionalDirectory(destination);
    if (stage && target) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    if (stage) {
      if (stage.identity !== pending.stageIdentity) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
      const inspected = inspectPluginPackage(readArchive(stage), {hostApiVersion});
      if (!inspected.compatible || inspected.digest !== pending.target.digest || inspected.manifest.id !== pending.pluginId) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
      hooks.at?.('plugin-install-before-publish', {pluginId:pending.pluginId,requestId:pending.requestId});
      fs.renameSync(stage.path, destination); syncDirectory(parent); hooks.at?.('plugin-install-published', {pluginId:pending.pluginId,requestId:pending.requestId});
    } else if (!target || target.identity !== pending.stageIdentity) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    verifyDescriptor(pending.target);
    const prior = state.plugins.find(item => item.id === pending.pluginId), entry = {id:pending.pluginId,current:pending.target,
      previous:prior?.current?.digest === pending.target.digest ? prior.previous : prior?.current ?? null, enabled:prior?.enabled ?? false};
    const plugins = [...state.plugins.filter(item=>item.id!==pending.pluginId),entry].sort((a,b)=>a.id.localeCompare(b.id));
    const next = {schemaVersion:1,plugins,pending:null,receipts:receipt(state.receipts,{requestId:pending.requestId,kind:'install',pluginId:pending.pluginId,digest:pending.target.digest})};
    hooks.at?.('plugin-install-before-terminal', {pluginId:pending.pluginId,requestId:pending.requestId}); persist(next);
    hooks.at?.('plugin-install-completed', {pluginId:pending.pluginId,requestId:pending.requestId}); return copy(entry);
  }
  function completeUninstall(pending) {
    const sourcePath=path.join(installed.path,pending.pluginId),retiredPath=path.join(retired.path,pending.requestId);
    const source=optionalDirectory(sourcePath), target=optionalDirectory(retiredPath);
    if (source && target) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    if (source) {
      if (source.identity!==pending.sourceIdentity) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
      hooks.at?.('plugin-uninstall-before-retire',{pluginId:pending.pluginId,requestId:pending.requestId});fs.renameSync(source.path,retiredPath);syncDirectory(installed);
      hooks.at?.('plugin-uninstall-retired',{pluginId:pending.pluginId,requestId:pending.requestId});
    } else if (!target || target.identity!==pending.sourceIdentity) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    const next={schemaVersion:1,plugins:state.plugins.filter(item=>item.id!==pending.pluginId),pending:null,
      receipts:receipt(state.receipts,{requestId:pending.requestId,kind:'uninstall',pluginId:pending.pluginId,digest:null})};
    hooks.at?.('plugin-uninstall-before-terminal',{pluginId:pending.pluginId,requestId:pending.requestId});persist(next);
    hooks.at?.('plugin-uninstall-completed',{pluginId:pending.pluginId,requestId:pending.requestId});
    try { fs.rmSync(retiredPath,{recursive:true}); syncDirectory(retired); } catch { /* terminal state is authoritative; retained private bytes are inert */ }
    return Object.freeze({pluginId:pending.pluginId,uninstalled:true});
  }
  function recover() {
    if (state.pending?.kind === 'install') completeInstall(state.pending);
    else if (state.pending?.kind === 'uninstall') completeUninstall(state.pending);
    for (const entry of state.plugins) { verifyDescriptor(entry.current); if (entry.previous) verifyDescriptor(entry.previous); }
    for (const item of state.receipts.filter(item=>item.kind==='uninstall')) {
      const filename=path.join(retired.path,item.requestId);try{fs.rmSync(filename,{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return list();
  }
  function list() { return Object.freeze(state.plugins.map(entry=>{verifyDescriptor(entry.current);if(entry.previous)verifyDescriptor(entry.previous);return Object.freeze({id:entry.id,name:entry.current.manifest.name,version:entry.current.version,
    digest:entry.current.digest,enabled:entry.enabled,rollbackAvailable:Boolean(entry.previous),manifest:copy(entry.current.manifest)});}));
  }
  function inspect(bytes) { return inspectPluginPackage(bytes,{hostApiVersion}); }
  function install({bytes,requestId}) {
    if (!validRequestId(requestId)) fail('PLUGIN_PACKAGE_INVALID_REQUEST');
    if(!(bytes instanceof Uint8Array)&&!(bytes instanceof ArrayBuffer))fail('PLUGIN_PACKAGE_INVALID_REQUEST');
    const archive=Buffer.from(bytes instanceof ArrayBuffer?new Uint8Array(bytes):bytes), inspected=inspect(archive);
    if (!inspected.compatible) fail('PLUGIN_PACKAGE_INCOMPATIBLE');
    const previous=state.receipts.find(item=>item.requestId===requestId);
    if (previous) {if(previous.kind!=='install'||previous.pluginId!==inspected.manifest.id||previous.digest!==inspected.digest)fail('PLUGIN_PACKAGE_REQUEST_REUSED');return copy(state.plugins.find(item=>item.id===previous.pluginId));}
    if (state.pending) fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');
    const current=state.plugins.find(item=>item.id===inspected.manifest.id);
    if(current&&[current.current,current.previous].filter(Boolean).some(item=>item.version===inspected.manifest.version&&item.digest!==inspected.digest))fail('PLUGIN_PACKAGE_CONFLICT');
    if (current?.current.digest===inspected.digest) {
      verifyDescriptor(current.current);
      persist({...state,receipts:receipt(state.receipts,{requestId,kind:'install',pluginId:inspected.manifest.id,digest:inspected.digest})});return copy(current);
    }
    if(current?.previous?.digest===inspected.digest){verifyDescriptor(current.previous);verifyDescriptor(current.current);const next={...current,current:current.previous,previous:current.current};
      persist({...state,plugins:state.plugins.map(item=>item.id===current.id?next:item),receipts:receipt(state.receipts,{requestId,kind:'install',pluginId:inspected.manifest.id,digest:inspected.digest})});return copy(next);}
    const stage=directory(path.join(staging.path,requestId));writeArchive(stage,'package.asmbplugin',archive);
    const target={version:inspected.manifest.version,digest:inspected.digest,directory:inspected.digest,manifest:copy(inspected.manifest)};
    const pending={kind:'install',requestId,pluginId:inspected.manifest.id,target,stageIdentity:stage.identity};
    persist({...state,pending});hooks.at?.('plugin-install-intent',{pluginId:pending.pluginId,requestId});return completeInstall(pending);
  }
  function setEnabled({pluginId,enabled}) {
    if (!validId(pluginId)||typeof enabled!=='boolean'||state.pending) fail('PLUGIN_PACKAGE_INVALID_REQUEST');
    const entry=state.plugins.find(item=>item.id===pluginId);if(!entry)fail('PLUGIN_PACKAGE_MISSING');verifyDescriptor(entry.current);if(entry.previous)verifyDescriptor(entry.previous);
    if(entry.enabled===enabled)return copy(entry);const next={...entry,enabled};persist({...state,plugins:state.plugins.map(item=>item.id===pluginId?next:item)});return copy(next);
  }
  function rollback({pluginId,requestId}) {
    if(!validId(pluginId)||!validRequestId(requestId))fail('PLUGIN_PACKAGE_INVALID_REQUEST');
    const done=state.receipts.find(item=>item.requestId===requestId);if(done){if(done.kind!=='rollback'||done.pluginId!==pluginId)fail('PLUGIN_PACKAGE_REQUEST_REUSED');return copy(state.plugins.find(item=>item.id===pluginId));}
    if(state.pending)fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');const entry=state.plugins.find(item=>item.id===pluginId);if(!entry)fail('PLUGIN_PACKAGE_MISSING');if(!entry.previous)fail('PLUGIN_PACKAGE_NO_ROLLBACK');
    verifyDescriptor(entry.current);verifyDescriptor(entry.previous);const next={...entry,current:entry.previous,previous:entry.current};
    persist({...state,plugins:state.plugins.map(item=>item.id===pluginId?next:item),receipts:receipt(state.receipts,{requestId,kind:'rollback',pluginId,digest:next.current.digest})});return copy(next);
  }
  function uninstall({pluginId,requestId}) {
    if(!validId(pluginId)||!validRequestId(requestId))fail('PLUGIN_PACKAGE_INVALID_REQUEST');
    const done=state.receipts.find(item=>item.requestId===requestId);if(done){if(done.kind!=='uninstall'||done.pluginId!==pluginId)fail('PLUGIN_PACKAGE_REQUEST_REUSED');return Object.freeze({pluginId,uninstalled:true});}
    if(state.pending)fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');const entry=state.plugins.find(item=>item.id===pluginId);if(!entry)fail('PLUGIN_PACKAGE_MISSING');
    const source=pluginDirectory(pluginId);if(!source)fail('PLUGIN_PACKAGE_RECOVERY_REQUIRED');const pending={kind:'uninstall',requestId,pluginId,sourceIdentity:source.identity};
    persist({...state,pending});hooks.at?.('plugin-uninstall-intent',{pluginId,requestId});return completeUninstall(pending);
  }
  recover();
  return Object.freeze({inspect,list,install,setEnabled,rollback,uninstall,recover});
}
