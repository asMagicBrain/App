import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runWithStorageIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import {pinDirectory, checkDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';
import {ensurePhysicalDirectory} from './profile-paths.mjs';
import {acquireNativeProfileLock} from './host-service.mjs';
import {inspectLegacyStorage} from './storage-preflight.mjs';
import {probeStorageVolume, backupStorageProfile} from './storage-backup.mjs';

const markerName = '.asmb-storage-volume.json';
const pendingName = '.asmb-storage-volume.pending';
const fail = (code = 'STORAGE_RECOVERY_UNSAFE') => {throw Object.assign(Error(code), {code});};
const hash = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const exists = filename => {try {return fs.lstatSync(filename);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}};
const rawIdentity = stat => `${stat.dev}:${stat.ino}`;

function readRecord(filename, allowPublicationLink = false) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && !(allowPublicationLink && stat.nlink === 2))
    || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) fail();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (rawIdentity(before) !== rawIdentity(stat)) fail();
    const bytes = Buffer.alloc(stat.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || rawIdentity(fs.lstatSync(filename)) !== rawIdentity(stat)) fail();
    let value; try {value = JSON.parse(bytes.subarray(0, count));} catch {fail();}
    return {value, bytes: bytes.subarray(0, count), stat};
  } finally {fs.closeSync(fd);}
}

function decodeMarker(observed, root, volumeId) {
  const value = observed.value, stat = fs.lstatSync(root);
  if (!exact(value, ['body', 'checksum']) || !exact(value.body, ['schemaVersion', 'root', 'rootInode', 'owner', 'namespaceDevice', 'volumeId'])
    || value.checksum !== hash(value.body) || value.body.schemaVersion !== 1
    || value.body.root !== root || value.body.rootInode !== String(stat.ino) || value.body.owner !== stat.uid
    || value.body.volumeId !== volumeId || !Number.isSafeInteger(value.body.namespaceDevice) || value.body.namespaceDevice < 0) fail('STORAGE_IDENTITY_MISMATCH');
  return {...value.body, currentDevice: stat.dev};
}

// This hint is untrusted until inspectLegacyStorage verifies all original
// binding hashes, checksums, chain continuity and live root identities.
function legacyNamespace(root) {
  const directory = path.join(root, 'state/native/.asmb-host');
  pinDirectory(directory);
  const names = fs.readdirSync(directory).sort();
  const name = names.includes('checkpoint.json') ? 'checkpoint.json' : names.find(value => /^\d{16}\.json$/.test(value));
  if (!name) fail();
  const {value} = readRecord(path.join(directory, name));
  const payload = name === 'checkpoint.json' ? value?.body?.payload?.state : value?.body?.payload;
  const organization = payload?.roots?.organization, state = payload?.roots?.state;
  if (![organization, state].every(value => typeof value === 'string' && /^\d+:\d+$/.test(value))
    || organization.split(':')[0] !== state.split(':')[0]) fail();
  const device = Number(organization.split(':')[0]);
  if (!Number.isSafeInteger(device) || device < 0) fail();
  return device;
}

function syncRoot(root) {
  const pin = pinDirectory(root), fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {checkDirectory(pin); fs.fsyncSync(fd); checkDirectory(pin);} finally {fs.closeSync(fd);}
}

function finishPublication(root, observed) {
  const pending = path.join(root, pendingName), final = path.join(root, markerName);
  if (exists(pending)) {
    const staged = readRecord(pending, true);
    if (rawIdentity(staged.stat) !== rawIdentity(observed.stat) || !staged.bytes.equals(observed.bytes)) fail();
    fs.unlinkSync(pending); syncRoot(root);
  } else if (observed.stat.nlink !== 1) fail();
  const live = readRecord(final);
  if (!live.bytes.equals(observed.bytes)) fail();
}

function publish(root, context, at) {
  const {currentDevice: _current, ...body} = context;
  const bytes = Buffer.from(JSON.stringify({body, checksum: hash(body)}) + '\n');
  const pending = path.join(root, pendingName), final = path.join(root, markerName);
  if (exists(pending)) {
    if (!readRecord(pending).bytes.equals(bytes)) fail();
  } else {
    const fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    syncRoot(root);
  }
  at?.('before-identity-publication');
  fs.linkSync(pending, final); syncRoot(root);
  at?.('after-identity-publication');
  finishPublication(root, readRecord(final, true));
}

/** Trusted native startup only. This factory has no renderer/IPC entry point.
 * Original ledgers are never rewritten. Legacy recovery binds their existing
 * numeric namespace to the current verified filesystem UUID after inspection.
 */
export async function prepareNativeStorage({dataRoot, confirmRecovery, probe = probeStorageVolume, backup = backupStorageProfile, hooks = {}}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || path.normalize(dataRoot) !== dataRoot) fail();
  ensurePhysicalDirectory(dataRoot);
  const rootPin = pinDirectory(dataRoot), stat = fs.lstatSync(dataRoot);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail();
  const volumeId = await probe(dataRoot);
  if (typeof volumeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(volumeId)) fail('STORAGE_VOLUME_UNAVAILABLE');
  checkDirectory(rootPin);
  const final = path.join(dataRoot, markerName), pending = path.join(dataRoot, pendingName);
  const observed = exists(final) ? readRecord(final, true) : null;
  const names = fs.readdirSync(dataRoot).filter(name => !['.asmagicbrain-channel.json', '.asmb-native.lock', pendingName].includes(name));
  const fresh = !observed && names.length === 0;
  let context = observed ? decodeMarker(observed, dataRoot, volumeId) : {
    schemaVersion: 1, root: dataRoot, rootInode: String(stat.ino), owner: stat.uid,
    namespaceDevice: fresh ? stat.dev : legacyNamespace(dataRoot), volumeId, currentDevice: stat.dev,
  };
  if (!observed && exists(pending)) {
    const stagedContext = decodeMarker(readRecord(pending), dataRoot, volumeId);
    if (!fresh && stagedContext.namespaceDevice !== context.namespaceDevice) fail();
    context = stagedContext;
  }
  return await runWithStorageIdentity(context, async () => {
    const admittedRoot = pinDirectory(dataRoot);
    const profileLock = acquireNativeProfileLock(dataRoot);
    try {
      checkDirectory(admittedRoot);
      if (observed) {
        finishPublication(dataRoot, observed);
        return {context, profileLock};
      }
      let backupPath;
      // With an unchanged device namespace, adding the UUID anchor does not
      // reinterpret a single identity. Leave normal journal recovery to the host.
      // Changed-device legacy profiles have no prior UUID anchor: inspect and
      // back them up before the first reinterpretation.
      if (!fresh && context.currentDevice !== context.namespaceDevice) {
        const before = inspectLegacyStorage({dataRoot, context});
        if (!confirmRecovery || !await confirmRecovery({dataRoot})) fail('STORAGE_RECOVERY_CANCELLED');
        checkDirectory(admittedRoot);
        backupPath = await backup({dataRoot});
        hooks.at?.('after-backup');
        const after = inspectLegacyStorage({dataRoot, context});
        if (JSON.stringify(before.fingerprint) !== JSON.stringify(after.fingerprint) || await probe(dataRoot) !== volumeId) fail();
      }
      checkDirectory(admittedRoot);
      publish(dataRoot, context, hooks.at);
      return {context, profileLock, backupPath};
    } catch (error) {try {profileLock.release();} catch {} throw error;}
  });
}
