import {createHash} from 'node:crypto';
import {crc32, deflateRawSync} from 'node:zlib';
import {readZipFiles, ZIP_IMPORT_LIMITS} from '../zip-import/index.mjs';
import {isPortableRelativePath, portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

export const PACKAGE_MANIFEST = 'asmagicbrain-package.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const failure = code => { throw Object.assign(new Error(code), {code}); };
export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validLabel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(value);
export const safePath = value => typeof value === 'string' && isPortableRelativePath(value) && value.split('/').length <= 32
  && !value.split('/').some(part => ['.git','.asmagicbrain','__macosx','.ds_store'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.asmb-'));
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
export function validateFileList(files) {
  if (!Array.isArray(files) || files.length > ZIP_IMPORT_LIMITS.extractedEntries) failure('INVALID_PACKAGE');
  const namespace = new Map();
  for (const entry of files) {
    if (!exact(entry, ['path','sha256']) || !safePath(entry.path) || entry.path === PACKAGE_MANIFEST || !validHash(entry.sha256)) failure('INVALID_PACKAGE');
    for (const [index, part] of entry.path.split('/').entries()) {
      const name = entry.path.split('/').slice(0,index+1).join('/'), key = portablePathKey(name), kind = name === entry.path ? 'file' : 'directory', previous = namespace.get(key);
      if (previous && (previous.name !== name || previous.kind !== kind || kind === 'file')) failure('PACKAGE_COLLISION');
      namespace.set(key, {name,kind});
    }
  }
  return files;
}
export function parsePackage(archive) {
  const raw = Buffer.from(archive), {files,manifest:zip} = readZipFiles(raw);
  // Update packages never silently omit hidden/private/SCM members.
  if (zip.summary.skippedEntries) failure('PACKAGE_RESERVED_PATH');
  let metadata = null;
  const manifestFile = files.find(file => file.path === PACKAGE_MANIFEST);
  if (manifestFile) {
    if (manifestFile.bytes.length > 2 * 1024 * 1024) failure('LIMIT_EXCEEDED');
    try { metadata = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestFile.bytes)); } catch { failure('INVALID_PACKAGE'); }
    const fields = ['format','schemaVersion','collectionId','version','semantics','files', ...(Object.hasOwn(metadata??{},'base')?['base']:[]),...(Object.hasOwn(metadata??{},'excluded')?['excluded']:[])];
    if (!exact(metadata,fields) || metadata.format !== 'asMagicBrain-package' || metadata.schemaVersion !== 1) failure('UNSUPPORTED_FORMAT');
    if (!validLabel(metadata.collectionId) || !validLabel(metadata.version) || !['snapshot','patch'].includes(metadata.semantics)) failure('INVALID_PACKAGE');
    validateFileList(metadata.files);
    if (metadata.excluded !== undefined) {
      if(!Array.isArray(metadata.excluded)||metadata.excluded.length>ZIP_IMPORT_LIMITS.extractedEntries)failure('INVALID_PACKAGE');
      const keys=new Set(metadata.files.map(entry=>portablePathKey(entry.path)));
      for(const entry of metadata.excluded){if(!exact(entry,['path','reason'])||!safePath(entry.path)||entry.reason!=='suspected-credential-filename'||keys.has(portablePathKey(entry.path)))failure('INVALID_PACKAGE');keys.add(portablePathKey(entry.path));}
    }
    if (metadata.base !== undefined) {
      if (!exact(metadata.base,['version','files']) || !validLabel(metadata.base.version)) failure('INVALID_PACKAGE');
      validateFileList(metadata.base.files);
    }
  }
  const source = files.filter(file => file.path !== PACKAGE_MANIFEST);
  const hashes = source.map(file => ({path:file.path,sha256:sha256(file.bytes)}));
  validateFileList(hashes);
  if (metadata && (metadata.files.length !== hashes.length || metadata.files.some(entry => hashes.find(item => item.path === entry.path)?.sha256 !== entry.sha256))) failure('PACKAGE_INTEGRITY');
  if (!source.length) failure('EMPTY_PACKAGE');
  return {digest:sha256(raw),files:source,metadata,summary:zip.summary};
}

/** Deterministic bounded ZIP (DEFLATE), followed by the independent admission
 * parser. It is not an archive executable, and contains no symbolic links. */
export function createPackageZip(files) {
  if (!Array.isArray(files) || files.length > ZIP_IMPORT_LIMITS.entries) failure('LIMIT_EXCEEDED');
  const locals = [], centrals = []; let offset=0, expanded=0;
  for (const item of [...files].sort((a,b)=>a.path.localeCompare(b.path))) {
    if (!safePath(item.path)) failure('INVALID_PATH');
    const name=Buffer.from(item.path), bytes=Buffer.from(item.bytes);
    if (bytes.length > ZIP_IMPORT_LIMITS.memberBytes || (expanded += bytes.length) > ZIP_IMPORT_LIMITS.expandedBytes) failure('LIMIT_EXCEEDED');
    const compressed=deflateRawSync(bytes), sum=crc32(bytes), header=Buffer.alloc(30), central=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8); header.writeUInt16LE(33,12);
    header.writeUInt32LE(sum,14); header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt16LE(8,10); central.writeUInt16LE(33,14);
    central.writeUInt32LE(sum,16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(bytes.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(0x81a40000,38); central.writeUInt32LE(offset,42);
    locals.push(header,name,compressed); centrals.push(central,name); offset += header.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(centrals), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  const result=Buffer.concat([...locals,directory,end]); readZipFiles(result,{stripRoot:false}); return result;
}
