import {createCredentialVault} from './credential-vault.mjs';

const MAX_RECORD_BYTES = 24 * 1024;
const failure = code => Object.assign(Error('The account session could not be retained. Sign in again.'), {code});

export function validateAccountStoragePolicy(policy) {
  if (!['session', 'persistent'].includes(policy)) throw TypeError('Unknown account storage policy.');
  return policy;
}

/** One host-service lifetime. No filesystem, encryption adapter or OS storage calls. */
export function createSessionCredentialVault({errorCode = 'GITHUB_STORAGE_UNAVAILABLE'} = {}) {
  let record = null, closed = false, queue = Promise.resolve();
  const guard = () => {if (closed) throw failure(errorCode);};
  const serial = operation => {
    const task = queue.then(() => {guard(); return operation();}).catch(() => {throw failure(errorCode);});
    queue = task.then(() => undefined, () => undefined);
    return task;
  };
  const copy = value => {
    const next = structuredClone(value);
    if (!next || typeof next !== 'object' || Array.isArray(next) || Buffer.byteLength(JSON.stringify(next)) > MAX_RECORD_BYTES) throw failure(errorCode);
    return next;
  };
  return Object.freeze({
    policy: 'session',
    isAvailable: async () => !closed,
    load: () => serial(() => record === null ? null : structuredClone(record)),
    save: (credential, {isCurrent = () => true, onCommitted = () => {}} = {}) => {
      let next;
      try {guard(); next = copy(credential);} catch {return Promise.reject(failure(errorCode));}
      return serial(() => {
        if (!isCurrent()) return false;
        // Commit and publication occupy the same host turn. Later cancellation
        // observes success; cancellation before this point keeps the old record.
        record = next;
        onCommitted();
        return true;
      });
    },
    remove: () => serial(() => {record = null;}),
    drain: () => queue,
    close: async () => {closed = true; await queue; record = null;},
  });
}

/** Explicit policy selection. Session mode never constructs the legacy disk vault. */
export function createAccountVault({storagePolicy = 'persistent', storage, ...options}) {
  validateAccountStoragePolicy(storagePolicy);
  if (storagePolicy === 'session') return createSessionCredentialVault({errorCode: options.errorCode});
  const vault = createCredentialVault({...options, storage});
  return Object.freeze({
    ...vault,
    policy: 'persistent',
    isAvailable: async () => Boolean(storage && await storage.isAvailable()),
    close: () => vault.drain(),
  });
}
