import { types } from 'node:util';
export function snapshotStringArray(input, maxItems, maxBytes) {
  if (types.isProxy(input) || !Array.isArray(input)) throw new TypeError('INVALID_SOURCE_ARRAY');
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  if (length > maxItems) throw new TypeError('INVALID_SOURCE_ARRAY');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== length + 1) throw new TypeError('INVALID_SOURCE_ARRAY');
  const snapshot = []; let bytes = 0;
  for (let i = 0; i < length; i += 1) {
    const item = descriptors[i];
    if (!item || !Object.hasOwn(item, 'value') || typeof item.value !== 'string') throw new TypeError('INVALID_SOURCE_ARRAY');
    bytes += Buffer.byteLength(item.value);
    if (bytes > maxBytes) throw new RangeError('SOURCE_ARRAY_TOO_LARGE');
    snapshot.push(item.value);
  }
  return snapshot;
}
export function isExactDataRecord(input, keys) {
  if (types.isProxy(input) || !input || typeof input !== 'object') return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(input);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'));
}
