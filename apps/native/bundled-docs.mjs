import {persistentIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createPrivateStore} from '../../packages/desktop-host/src/private-store.mjs';
import {pinDirectory, checkDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';
import {initializeEmptyRepository} from '../../packages/desktop-host/src/local-git/initialize-empty.mjs';
import {gitExecutable, gitEnvironment} from '../../packages/desktop-host/src/git-executable.mjs';
import {renameDirectoryStep} from '../../packages/desktop-host/src/repository-import/rename-directory.mjs';
import {docsHash, verifyBundledDocsPayload} from './bundled-docs-manifest.mjs';

const NAME = 'asMagicBrain-Docs';
const fail = () => {throw Object.assign(Error('Documentation storage needs recovery. Existing documentation and user files are preserved.'), {code: 'DOCS_RECOVERY_REQUIRED'});};
const exists = filename => {try {return fs.lstatSync(filename);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}};
const identity = persistentIdentity;
const markerName = '.git/asmagicbrain-docs.json';
const idValid = value => typeof value === 'string' && /^\d+:\d+$/.test(value);
const uuidValid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const nameValid = value => typeof value === 'string' && /^asMagicBrain-Docs(?:-\d+)?$/.test(value);
const activeValid = value => value && nameValid(value.name) && idValid(value.identity) && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) && typeof value.version === 'string' && /^[a-f0-9]{40}$/.test(value.head) && Array.isArray(value.files);
function syncTree(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) syncTree(filename);
    else if (entry.isFile()) {const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
    else fail();
  }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function syncDirectory(pin) {
  checkDirectory(pin);
  const fd = fs.openSync(pin.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(fs.fstatSync(fd)) !== pin.identity) fail();
    fs.fsyncSync(fd); checkDirectory(pin);
  } finally {fs.closeSync(fd);}
}
const git = (directory, ...args) => execFileSync(gitExecutable(), ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-C', directory, ...args], {
  env: gitEnvironment({GIT_AUTHOR_NAME: 'asMagicBrain Documentation', GIT_AUTHOR_EMAIL: 'docs@asmagicbrain.invalid', GIT_COMMITTER_NAME: 'asMagicBrain Documentation', GIT_COMMITTER_EMAIL: 'docs@asmagicbrain.invalid'}), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
}).trim();

/** Called only while the native profile lock is held, before any repository
 * session opens. Every replacement moves the complete old directory to an
 * owned preserved location; changed content is never reset or deleted. */
export async function installBundledDocs({organization, privateRoot, bindingHash, payloadRoot, manifest, hooks = {}}) {
  verifyBundledDocsPayload(payloadRoot, manifest);
  const parent = pinDirectory(organization), storage = pinDirectory(privateRoot);
  const store = createPrivateStore({privateRoot, bindingHash});
  let scan = store.ensureDurable(store.scan());
  const valid = value => value?.schemaVersion === 1 && uuidValid(value.ownerId) && (value.active === null || activeValid(value.active)) && Array.isArray(value.previous) && value.previous.length <= 1000 && value.previous.every(activeValid) && (value.pending === null || value.pending && activeValid(value.pending.next) && /^\.asmb-docs-stage-[a-f0-9-]{36}$/.test(value.pending.stage) && /^\.asmb-docs-preserved-[a-f0-9-]{36}$/.test(value.pending.backup) && (value.pending.backupReservation === null || idValid(value.pending.backupReservation)) && (value.pending.targetReservation === null || idValid(value.pending.targetReservation)));
  if (scan.blocked || scan.events.some(event => !valid(event.payload))) fail();
  let record = scan.events.at(-1)?.payload ?? {schemaVersion: 1, ownerId: randomUUID(), active: null, previous: [], pending: null};
  const persist = next => {
    checkDirectory(parent); checkDirectory(storage);
    if (!valid(next)) fail();
    if (scan.tailRecords >= 24 || scan.coveredFiles.length) scan = store.compact(scan, record);
    scan = store.append(scan, 'draft', next); if (scan.blocked) fail(); record = next;
  };
  const at = point => hooks.at?.(point);
  const pin = name => pinDirectory(path.join(organization, name));
  function assertOwned(name, expected) {
    const directory = pin(name); if (directory.identity !== expected.identity) fail();
    pinDirectory(path.join(directory.path, '.git'));
    const filename = path.join(directory.path, markerName), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) fail();
    const marker = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (marker.schemaVersion !== 1 || marker.ownerId !== record.ownerId || marker.digest !== expected.digest) fail();
    return directory;
  }
  function unchanged(active) {
    try {
      const directory = assertOwned(active.name, active);
      const expected = new Map(active.files.map(file => [file.path, file]));
      const seen = new Set();
      function walk(folder, prefix = '') {
        for (const name of fs.readdirSync(folder)) {
          if (!prefix && name === '.git') continue;
          const relative = prefix + name, filename = path.join(folder, name), stat = fs.lstatSync(filename);
          if (stat.isSymbolicLink()) throw Error();
          if (stat.isDirectory()) {if (![...expected.keys()].some(key => key.startsWith(relative + '/'))) throw Error(); walk(filename, relative + '/');}
          else {const file = expected.get(relative); if (!stat.isFile() || stat.nlink !== 1 || !file || stat.size !== file.bytes || docsHash(fs.readFileSync(filename)) !== file.sha256) throw Error(); seen.add(relative);}
        }
      }
      walk(directory.path);
      return seen.size === expected.size && git(directory.path, 'rev-parse', '--verify', 'HEAD') === active.head && git(directory.path, 'remote') === '';
    } catch {return false;}
  }
  function chooseName() {
    const occupied = new Set(fs.readdirSync(organization).map(name => name.toLowerCase()));
    for (let number = 1; number < 10000; number++) {const name = number === 1 ? NAME : `${NAME}-${number}`; if (!occupied.has(name.toLowerCase())) return name;}
    fail();
  }
  function finish() {
    let pending = record.pending;
    if (!pending) return;
    const previous = record.active, target = path.join(organization, pending.next.name);
    if (previous && previous.name === pending.next.name) {
      const current = exists(target), saved = exists(path.join(organization, pending.backup));
      if (current && identity(current) === previous.identity) {
        // The private ledger proves ownership even when the user has edited or
        // removed the in-repository marker. Preserve the entire directory.
        if (pending.backupReservation === null) {
          if (saved) {persist({...record, pending: {...pending, backup: `.asmb-docs-preserved-${randomUUID()}`}}); return finish();}
          const reservation = renameDirectoryStep(parent, {operation: 'reserve', name: pending.backup});
          persist({...record, pending: {...pending, backupReservation: reservation}}); pending = record.pending; at('docs-backup-reserved');
        }
        renameDirectoryStep(parent, {operation: 'rename', repository: previous.name, name: pending.backup, identity: previous.identity, reservationIdentity: pending.backupReservation});
        at('docs-previous-preserved');
      } else if (current && identity(current) !== pending.next.identity && identity(current) !== pending.targetReservation) {
        // Another folder replaced the old documentation. Keep it at its name.
        persist({...record, pending: {...pending, next: {...pending.next, name: chooseName()}, targetReservation: null}}); return finish();
      } else if (saved && identity(saved) !== previous.identity && identity(saved) !== pending.backupReservation) fail();
    }
    pending = record.pending;
    const live = exists(path.join(organization, pending.next.name));
    if (live && identity(live) === pending.next.identity) assertOwned(pending.next.name, pending.next);
    else {
      assertOwned(pending.stage, pending.next);
      if (pending.targetReservation === null) {
        if (live) {persist({...record, pending: {...pending, next: {...pending.next, name: chooseName()}}}); return finish();}
        const reservation = renameDirectoryStep(parent, {operation: 'reserve', name: pending.next.name});
        persist({...record, pending: {...pending, targetReservation: reservation}}); pending = record.pending; at('docs-target-reserved');
      }
      renameDirectoryStep(parent, {operation: 'rename', repository: pending.stage, name: pending.next.name, identity: pending.next.identity, reservationIdentity: pending.targetReservation});
      assertOwned(pending.next.name, pending.next); at('docs-published');
    }
    persist({...record, active: pending.next, previous: record.active ? [...record.previous, record.active] : record.previous, pending: null}); at('docs-completed');
  }
  finish();
  if (!record.active || record.active.digest !== manifest.digest || record.active.version !== manifest.version || !unchanged(record.active)) {
    const previous = record.active, current = previous ? exists(path.join(organization, previous.name)) : null;
    const targetName = previous && (!current || current.isDirectory() && !current.isSymbolicLink() && identity(current) === previous.identity) ? previous.name : chooseName();
    const stage = `.asmb-docs-stage-${randomUUID()}`, stageRoot = path.join(organization, stage);
    fs.mkdirSync(stageRoot, {mode: 0o700});
    await initializeEmptyRepository(stageRoot);
    for (const file of manifest.files) {
      const bytes = fs.readFileSync(path.join(payloadRoot, file.path)); if (docsHash(bytes) !== file.sha256) fail();
      const filename = path.join(stageRoot, file.path); fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700}); fs.writeFileSync(filename, bytes, {flag: 'wx', mode: 0o600});
    }
    git(stageRoot, 'add', '--all', '--', '.'); git(stageRoot, 'commit', '--no-gpg-sign', '-m', `Bundled documentation ${manifest.version}`);
    const next = {name: targetName, identity: pin(stage).identity, version: manifest.version, digest: manifest.digest, files: manifest.files, head: git(stageRoot, 'rev-parse', '--verify', 'HEAD')};
    fs.writeFileSync(path.join(stageRoot, markerName), JSON.stringify({schemaVersion: 1, ownerId: record.ownerId, digest: next.digest}) + '\n', {flag: 'wx', mode: 0o600});
    syncTree(stageRoot);
    // Persist the stage's name in its parent before a durable intent can refer
    // to it. Syncing the stage alone does not persist its directory entry.
    syncDirectory(parent);
    persist({...record, pending: {next, stage, backup: `.asmb-docs-preserved-${randomUUID()}`, backupReservation: null, targetReservation: null}}); at('docs-ready'); finish();
  }
  const active = record.active; assertOwned(active.name, active);
  return Object.freeze({
    entry: Object.freeze({name: active.name, privateRepo: false, builtin: 'documentation', readOnly: true}),
    identity: active.identity,
    previous: record.previous.map(value => ({name: value.name, identity: value.identity})),
    assertCurrent: () => {assertOwned(active.name, active);},
  });
}
