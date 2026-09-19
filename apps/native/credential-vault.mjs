import fs from 'node:fs/promises';
import {constants, openSync, closeSync, fsyncSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const MAX_CIPHERTEXT = 64 * 1024;
const MAX_PLAINTEXT = 24 * 1024;
const fail = () => Object.assign(Error('The GitHub connection could not be stored securely. Disconnect it and reconnect after checking local storage.'), {code: 'GITHUB_STORAGE_UNAVAILABLE'});

async function physicalDirectory(directory) {
  const absolute = path.resolve(directory), parent = path.dirname(absolute);
  if (parent !== absolute) await physicalDirectory(parent);
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw fail();
  return stat;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const privateFile = (stat, allowEmpty = false) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (allowEmpty || stat.size > 0) && stat.size <= MAX_CIPHERTEXT && !(stat.mode & 0o177) && owned(stat);

/** Host-only ciphertext. Never put this directory in repository exports or catalogs. */
export function createCredentialVault({profileRoot, clientId, storage, namespace = 'github-auth', errorCode = 'GITHUB_STORAGE_UNAVAILABLE'}) {
  const fail = () => Object.assign(Error(namespace === 'github-auth' ? 'The GitHub connection could not be stored securely. Disconnect it and reconnect after checking local storage.' : 'The application account could not be stored securely. Sign out and try again after checking local storage.'), {code: errorCode});
  if (!['github-auth', 'application-auth'].includes(namespace) || !['GITHUB_STORAGE_UNAVAILABLE', 'ACCOUNT_STORAGE_UNAVAILABLE'].includes(errorCode)) throw fail();
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot) || typeof clientId !== 'string' || !clientId) throw fail();
  const directory = path.join(profileRoot, namespace);
  const filename = path.join(directory, createHash('sha256').update(clientId).digest('hex') + '.bin');
  const pendingFile = filename + '.pending';
  let identity, queue = Promise.resolve();
  const serial = operation => {
    const task = queue.then(operation).catch(reason => {const safe = fail(); if (reason?.publicationPending === true) safe.publicationPending = true; throw safe;});
    queue = task.catch(() => {});
    return task;
  };
  const ensure = async () => {
    if (!owned(await physicalDirectory(profileRoot))) throw fail();
    try {await fs.mkdir(directory, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
    const stat = await physicalDirectory(directory);
    if (!owned(stat) || (stat.mode & 0o077)) throw fail();
    if (identity && !sameFile(identity, stat)) throw fail();
    identity ??= stat;
  };
  const inspect = async (name = filename) => {
    try {
      const stat = await fs.lstat(name);
      if (!privateFile(stat, name === pendingFile)) throw fail();
      return stat;
    } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  };
  const secure = async () => {if (!storage || !await storage.isAvailable()) throw fail();};
  const syncDirectory = async () => {const handle = await fs.open(directory, constants.O_RDONLY); try {await handle.sync();} finally {await handle.close();}};
  // The final marker removal and in-memory publication run in one host turn.
  // Cancellation after this durable boundary observes a completed connection.
  const clearPending = () => {
    try {
      unlinkSync(pendingFile);
      const handle = openSync(directory, constants.O_RDONLY);
      try {fsyncSync(handle);} finally {closeSync(handle);}
    } catch (reason) {
      // If marker removal reached disk but its directory sync failed, restore a
      // hold before returning uncertainty. A filesystem refusing this write as
      // well cannot provide a durable restart guarantee; the caller stays held.
      try {
        const marker = openSync(pendingFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {writeFileSync(marker, JSON.stringify({schemaVersion: 1})); fsyncSync(marker);} finally {closeSync(marker);}
        const handle = openSync(directory, constants.O_RDONLY);
        try {fsyncSync(handle);} finally {closeSync(handle);}
      } catch {}
      throw reason;
    }
  };
  const requireSettled = async () => {if (await inspect(pendingFile)) throw fail();};
  const readCiphertext = async before => {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!sameFile(before, opened) || !privateFile(opened)) throw fail();
      const encrypted = await handle.readFile();
      if (encrypted.length > MAX_CIPHERTEXT) throw fail();
      return encrypted;
    } finally {await handle.close();}
  };
  const temporaryCiphertext = async bytes => {
    const name = path.join(directory, '.pending-' + randomUUID());
    const handle = await fs.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await handle.writeFile(bytes); await handle.sync();}
    catch (reason) {await handle.close(); await fs.unlink(name).catch(() => {}); throw reason;}
    await handle.close();
    return name;
  };
  return {
    load: () => serial(async () => {
      await ensure(); await requireSettled();
      const before = await inspect();
      if (!before) return null;
      await secure();
      const encrypted = await readCiphertext(before);
      await ensure();
      if (!sameFile(before, await inspect())) throw fail();
      const plain = await storage.decrypt(encrypted);
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_PLAINTEXT) throw fail();
      const record = JSON.parse(plain);
      if (!record || ![1, 2].includes(record.schemaVersion) || record.clientId !== clientId || !record.credential) throw fail();
      return record.credential;
    }),
    save: (credential, {isCurrent = () => true, onCommitted = () => {}} = {}) => serial(async () => {
      await ensure(); await requireSettled(); await secure();
      // Version 2 prevents earlier readers from accepting a replaced credential
      // without understanding this version's pending-publication marker.
      const plain = JSON.stringify({schemaVersion: 2, clientId, credential});
      if (Buffer.byteLength(plain) > MAX_PLAINTEXT) throw fail();
      const encrypted = await storage.encrypt(plain);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_CIPHERTEXT) throw fail();
      if (!isCurrent()) return false;
      const before = await inspect(), previousBytes = before ? await readCiphertext(before) : null;
      let temporary, rollback, marked = false, published = false;
      try {
        temporary = await temporaryCiphertext(encrypted);
        await ensure();
        const current = await inspect();
        if (Boolean(before) !== Boolean(current) || (before && !sameFile(before, current))) throw fail();
        if (!isCurrent()) return false;
        const marker = await fs.open(pendingFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        marked = true;
        try {await marker.writeFile(JSON.stringify({schemaVersion: 1})); await marker.sync();} finally {await marker.close();}
        await syncDirectory(); await ensure();
        if (!isCurrent()) {clearPending(); marked = false; return false;}
        await fs.rename(temporary, filename);
        temporary = null; published = true;
        const publishedIdentity = await inspect();
        await syncDirectory(); await ensure();
        if (!isCurrent()) {
          // Restore exact previous ciphertext: rollback must not need an
          // unlocked keychain or perform another encryption operation.
          if (previousBytes) rollback = await temporaryCiphertext(previousBytes);
          await ensure(); if (!sameFile(publishedIdentity, await inspect())) throw fail();
          if (rollback) {await fs.rename(rollback, filename); rollback = null;} else await fs.unlink(filename);
          await syncDirectory(); clearPending(); marked = false; return false;
        }
        clearPending(); marked = false; onCommitted(); return true;
      } catch (reason) {
        // An uncertain publication remains marked. Restart refuses it until an
        // explicit Disconnect; neither old nor replacement identity is guessed.
        if (marked && !published) {
          try {await ensure(); const current = await inspect(); if (Boolean(before) === Boolean(current) && (!before || sameFile(before, current))) {clearPending(); marked = false;}} catch {}
        }
        const safe = fail(); if (marked) safe.publicationPending = true; throw safe;
      } finally {
        for (const name of [temporary, rollback]) if (name) try {await fs.unlink(name);} catch (error) {if (error.code !== 'ENOENT') throw error;}
      }
    }),
    remove: () => serial(async () => {
      await ensure(); const current = await inspect(), pending = await inspect(pendingFile);
      if (current) {await fs.unlink(filename); await syncDirectory();}
      if (pending) clearPending();
    }),
    drain: () => queue,
  };
}
