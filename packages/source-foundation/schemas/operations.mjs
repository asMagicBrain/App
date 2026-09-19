// The executable descriptor for this in-process boundary. `bytes` denotes an
// intrinsic Uint8Array snapshot, not JSON, a base64 transport or an IPC grant.
export const TRANSACTION_LIMITS = Object.freeze({
  files: 32,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  expectedFiles: 64,
  assets: 64,
});

const record = (properties) => ({ type: 'record', properties });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const uuid = { type: 'uuid' };
const path = { type: 'path' };
const hash = { type: 'hash' };
export const hashFileSchema = record({ path, hash: { type: 'nullableHash' } });
export const observedFilesSchema = record({ files: array(hashFileSchema, TRANSACTION_LIMITS.expectedFiles) });
export const requestIdentitySchema = record({ requestId: uuid, fingerprint: hash });
export const transactionRequestSchema = record({
  schemaVersion: { type: 'literal', value: 1 },
  requestId: uuid,
  target: record({ kind: { type: 'literal', value: 'source' }, spaceId: uuid }),
  expected: observedFilesSchema,
  input: record({
    files: array(record({ path, bytes: { type: 'bytes', maxBytes: TRANSACTION_LIMITS.fileBytes } }), TRANSACTION_LIMITS.files),
    assets: array(record({ path, hash }), TRANSACTION_LIMITS.assets),
  }),
});
// Explicit source transaction v2: up to 1,024 identity metadata dependencies,
// with the same candidate and aggregate byte bounds as v1. Not body inventory.
export const sourceObservedFilesSchema = record({ files: array(hashFileSchema, 1024) });
export const sourceTransactionRequestSchema = record({
  ...transactionRequestSchema.properties,
  schemaVersion: { type: 'literal', value: 2 },
  expected: sourceObservedFilesSchema,
  input: record({ ...transactionRequestSchema.properties.input.properties,
    assets: array(record({ path, hash }), 1024) }),
});
// File effects have an explicit absence candidate. Empty bytes still mean a
// present empty file. Only this version admits bounded binary attachments.
export const fileTransactionRequestSchema = record({
  ...sourceTransactionRequestSchema.properties,
  schemaVersion: { type: 'literal', value: 3 },
  input: record({
    files: array(record({ path, bytes: { type: 'nullableBytes', maxBytes: 4 * 1024 * 1024 } }), TRANSACTION_LIMITS.files),
    assets: array(record({ path, hash }), 1024),
    directories: array(path, 8),
  }),
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const OPERATION_SCHEMAS = freeze({ transaction: transactionRequestSchema,
  observed: observedFilesSchema, identity: requestIdentitySchema,
  sourceTransaction: sourceTransactionRequestSchema, sourceObserved: sourceObservedFilesSchema,
  fileTransaction: fileTransactionRequestSchema });
