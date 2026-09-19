/** Inspect pinned ELF inputs without executing them (also usable when preparing
 * Linux inputs on a Mac). Only ELF64 little-endian x86-64 is admitted. */
export function inspectLinuxElf(bytes) {
  const fail = () => {throw Error('Unsupported or malformed Linux x64 ELF input.');};
  const range = (offset, length) => {if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) fail(); return offset;};
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  const u64 = offset => {const value = Number(bytes.readBigUInt64LE(range(offset, 8))); if (!Number.isSafeInteger(value)) fail(); return value;};
  if (bytes.length < 64 || bytes.subarray(0, 7).toString('hex') !== '7f454c46020101' || u16(18) !== 62 || ![2, 3].includes(u16(16)) || u32(20) !== 1) fail();
  const offset = u64(32), size = u16(54), count = u16(56);
  if (size !== 56 || count < 1 || count > 128) fail();
  range(offset, size * count);
  const segments = Array.from({length: count}, (_, index) => {
    const position = offset + size * index;
    const segment = {type: u32(position), offset: u64(position + 8), address: u64(position + 16), size: u64(position + 32)};
    range(segment.offset, segment.size); return segment;
  });
  const string = (position, end) => {const zero = bytes.indexOf(0, position); if (zero < position || zero >= end) fail(); return bytes.subarray(position, zero).toString('utf8');};
  const interpreters = segments.filter(segment => segment.type === 3);
  if (interpreters.length > 1) fail();
  const interpreter = interpreters.length ? string(interpreters[0].offset, interpreters[0].offset + interpreters[0].size) : null;
  const dynamic = segments.filter(segment => segment.type === 2);
  if (dynamic.length > 1) fail();
  const tags = [];
  if (dynamic.length) {
    const segment = dynamic[0];
    if (segment.size % 16 !== 0) fail();
    for (let position = segment.offset; position < segment.offset + segment.size; position += 16) {
      const tag = u64(position); if (tag === 0) break;
      tags.push([tag, u64(position + 8)]);
    }
  }
  const strings = tags.find(([tag]) => tag === 5)?.[1], stringSize = tags.find(([tag]) => tag === 10)?.[1];
  const needed = [], searchPaths = [];
  for (const [tag, value] of tags.filter(([tag]) => [1, 15, 29].includes(tag))) {
    const segment = segments.find(segment => segment.type === 1 && strings >= segment.address && strings < segment.address + segment.size);
    if (!segment || !stringSize || value >= stringSize) fail();
    const start = segment.offset + strings - segment.address;
    range(start, stringSize);
    (tag === 1 ? needed : searchPaths).push(string(start + value, start + stringSize));
  }
  return {architecture: 'x64', interpreter, needed, searchPaths};
}

export function verifyLinuxElf(bytes, policy) {
  const actual = inspectLinuxElf(bytes);
  if (actual.interpreter !== policy.interpreter || actual.searchPaths.length || actual.needed.some(name => !policy.needed.includes(name))) throw Error('Unapproved Linux ELF interpreter or shared-library dependency.');
  return actual;
}
