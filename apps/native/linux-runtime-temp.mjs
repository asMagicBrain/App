import fs from 'node:fs';
import path from 'node:path';

// Linux sockaddr_un has 108 bytes including its terminator. Chromium adds
// /scoped_dirXXXXXX/SingletonSocket (33 bytes) beneath its temporary directory.
export const maximumLinuxTemporaryPathBytes = 64;
const fail = message => {throw Object.assign(Error(message), {code: 'ASMB_RUNTIME_TEMP'});};
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

/** Allocate ephemeral Chromium/native temp only; never a profile or workspace.
 * The filesystem parameter supports tests with real files below external Test.
 * Production always uses the native filesystem and the literal /tmp fallback.
 */
export function createLinuxRuntimeTemporaryDirectory({runtimeDirectory = process.env.XDG_RUNTIME_DIR, uid = process.getuid(), filesystem = fs} = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0) fail('The Linux user identity is unavailable.');
  const fallback = runtimeDirectory === undefined || runtimeDirectory === '';
  const parent = fallback ? '/tmp' : runtimeDirectory;
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.resolve(parent) !== parent || parent.includes('\0')) {
    fail('XDG_RUNTIME_DIR must name an absolute physical directory.');
  }
  function inspectParent() {
    try {
      const stat = filesystem.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || filesystem.realpathSync(parent) !== parent) fail('The Linux temporary parent must be a physical directory.');
      const mode = stat.mode & 0o7777;
      if (fallback ? stat.uid !== 0 || mode !== 0o1777 : stat.uid !== uid || mode !== 0o700) {
        fail(fallback ? 'The Linux /tmp fallback must be root-owned with mode 01777.' : 'XDG_RUNTIME_DIR must belong to this user with mode 0700.');
      }
      return stat;
    } catch (error) {if (error.code === 'ASMB_RUNTIME_TEMP') throw error; fail('The Linux temporary parent is unavailable.');}
  }
  const parentIdentity = inspectParent(), prefix = path.join(parent, 'asmb-');
  if (Buffer.byteLength(prefix, 'utf8') + 6 > maximumLinuxTemporaryPathBytes) fail('XDG_RUNTIME_DIR is too long for Chromium temporary sockets.');
  const directory = filesystem.mkdtempSync(prefix);
  // mkdtemp creates private 0700 directories. Restrictive user umasks are
  // harmless, but restore precisely 0700 before Chromium creates its sockets.
  const identity = filesystem.lstatSync(directory);
  if (!directory.startsWith(prefix) || path.dirname(directory) !== parent || Buffer.byteLength(directory, 'utf8') > maximumLinuxTemporaryPathBytes ||
      !identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== uid || filesystem.realpathSync(directory) !== directory ||
      !sameIdentity(parentIdentity, inspectParent())) fail('The allocated Linux temporary directory changed.');
  const fd = filesystem.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = filesystem.fstatSync(fd);
    if (!opened.isDirectory() || !sameIdentity(opened, identity)) fail('The allocated Linux temporary directory changed.');
    filesystem.fchmodSync(fd, 0o700);
  } finally {filesystem.closeSync(fd);}
  const admitted = filesystem.lstatSync(directory);
  if (!admitted.isDirectory() || admitted.isSymbolicLink() || admitted.uid !== uid || (admitted.mode & 0o7777) !== 0o700 ||
      !sameIdentity(admitted, identity) || filesystem.realpathSync(directory) !== directory || !sameIdentity(inspectParent(), parentIdentity)) {
    fail('The allocated Linux temporary directory changed before admission.');
  }
  let removed = false;
  function cleanup() {
    if (removed) return false;
    // A crash leaves only this session-owned temporary directory. Never scan
    // or prune siblings, and never remove a replacement at the recorded path.
    const current = filesystem.lstatSync(directory, {throwIfNoEntry: false});
    if (!current) return false;
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== uid || (current.mode & 0o7777) !== 0o700 ||
        !sameIdentity(current, identity) || filesystem.realpathSync(directory) !== directory || !sameIdentity(inspectParent(), parentIdentity)) return false;
    // Node removes contained symlinks themselves; it does not traverse targets.
    filesystem.rmSync(directory, {recursive: true}); removed = true; return true;
  }
  return Object.freeze({directory, cleanup});
}
