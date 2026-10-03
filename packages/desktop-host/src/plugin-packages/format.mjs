import {createHash} from 'node:crypto';
import {createPackageZip} from '../package-exchange/archive.mjs';
import {readZipFiles} from '../zip-import/index.mjs';
import {isPortableRelativePath, portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

export const PLUGIN_PACKAGE_FORMAT = 'asMagicBrain-plugin';
export const PLUGIN_PACKAGE_SCHEMA_VERSION = 1;
export const PLUGIN_HOST_API_VERSION = 1;
export const PLUGIN_PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  memberBytes: 16 * 1024 * 1024,
  entries: 512,
  files: 258,
  manifestBytes: 64 * 1024,
  integrityBytes: 512 * 1024,
  resources: 256,
});

const MANIFEST_PATH = 'manifest.json';
const INTEGRITY_PATH = 'integrity.json';
const RESOURCE_TYPES = new Set(['markdown-template', 'text', 'data', 'image']);
const RESOURCE_EXTENSIONS = new Set(['.json', '.md', '.markdown', '.txt', '.csv', '.tsv', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TYPE_EXTENSIONS = Object.freeze({
  'markdown-template':new Set(['.md','.markdown']), text:new Set(['.txt','.md','.markdown']),
  data:new Set(['.json','.csv','.tsv']), image:new Set(['.png','.jpg','.jpeg','.gif','.webp']),
});
const EXECUTABLE_EXTENSIONS = /\.(?:c?js|mjs|jsx|ts|tsx|html?|wasm|node|sh|command|bat|cmd|ps1|py|rb|php|jar|class|app|exe|dll|dylib|so)$/iu;
const decoder = new TextDecoder('utf-8', {fatal: true});
const ZIP_LIMITS=Object.freeze({archiveBytes:PLUGIN_PACKAGE_LIMITS.archiveBytes,expandedBytes:PLUGIN_PACKAGE_LIMITS.expandedBytes,
  memberBytes:PLUGIN_PACKAGE_LIMITS.memberBytes,entries:PLUGIN_PACKAGE_LIMITS.entries,extractedEntries:PLUGIN_PACKAGE_LIMITS.files,
  pathBytes:1024,pathDepth:16});
const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const validId = value => boundedText(value, 100) && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value);
const validVersion = value => typeof value === 'string' && value.length <= 40 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function json(bytes, limit) {
  if (bytes.length > limit) fail('PLUGIN_PACKAGE_LIMIT');
  try { return JSON.parse(decoder.decode(bytes)); } catch { fail('PLUGIN_PACKAGE_INVALID'); }
}
function resourcePath(value) {
  if (typeof value !== 'string' || !value.startsWith('content/') || !isPortableRelativePath(value)
    || value.split('/').length > 16 || EXECUTABLE_EXTENSIONS.test(value)) return false;
  const dot = value.lastIndexOf('.');
  return dot > value.lastIndexOf('/') && RESOURCE_EXTENSIONS.has(value.slice(dot).toLowerCase());
}
function validateManifest(value) {
  if (!exact(value, ['format','schemaVersion','id','name','version','publisher','hostApi','execution','permissions','resources','signature'])
    || value.format !== PLUGIN_PACKAGE_FORMAT || value.schemaVersion !== PLUGIN_PACKAGE_SCHEMA_VERSION
    || !validId(value.id) || !boundedText(value.name, 80) || !validVersion(value.version)
    || !exact(value.publisher, ['id','name','website']) || !validId(value.publisher.id) || !boundedText(value.publisher.name, 80)
    || !(value.publisher.website === null || (boundedText(value.publisher.website, 2048) && /^https:\/\//u.test(value.publisher.website)))
    || !exact(value.hostApi, ['min','max']) || !Number.isSafeInteger(value.hostApi.min) || !Number.isSafeInteger(value.hostApi.max)
    || value.hostApi.min < 1 || value.hostApi.max < value.hostApi.min
    || !exact(value.execution, ['kind']) || value.execution.kind !== 'declarative'
    || !Array.isArray(value.permissions) || value.permissions.length !== 0
    || !Array.isArray(value.resources) || value.resources.length > PLUGIN_PACKAGE_LIMITS.resources
    || value.signature !== null) fail('PLUGIN_PACKAGE_INVALID');
  const ids = new Set(), paths = new Set(), resources = [];
  for (const item of value.resources) {
    if (!exact(item, ['id','type','path','title']) || !validId(item.id) || !item.id.startsWith(`${value.id}.`)
      || !RESOURCE_TYPES.has(item.type) || !resourcePath(item.path) || !TYPE_EXTENSIONS[item.type].has(item.path.slice(item.path.lastIndexOf('.')).toLowerCase()) || !boundedText(item.title, 80)
      || ids.has(item.id) || paths.has(portablePathKey(item.path))) fail('PLUGIN_PACKAGE_INVALID');
    ids.add(item.id); paths.add(portablePathKey(item.path)); resources.push(Object.freeze({...item}));
  }
  return Object.freeze({...value, publisher:Object.freeze({...value.publisher}), hostApi:Object.freeze({...value.hostApi}),
    execution:Object.freeze({kind:'declarative'}), permissions:Object.freeze([]), resources:Object.freeze(resources)});
}
function validateIntegrity(value) {
  if (!exact(value, ['schemaVersion','algorithm','files']) || value.schemaVersion !== 1 || value.algorithm !== 'sha256'
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > PLUGIN_PACKAGE_LIMITS.files - 1) fail('PLUGIN_PACKAGE_INVALID');
  const paths = new Set(), result = [];
  for (const item of value.files) {
    if (!exact(item, ['path','bytes','sha256']) || typeof item.path !== 'string' || item.path === INTEGRITY_PATH
      || !(item.path === MANIFEST_PATH || resourcePath(item.path)) || paths.has(portablePathKey(item.path))
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > PLUGIN_PACKAGE_LIMITS.memberBytes || !validHash(item.sha256)) fail('PLUGIN_PACKAGE_INVALID');
    paths.add(portablePathKey(item.path)); result.push(Object.freeze({...item}));
  }
  return Object.freeze(result);
}
function copyInput(input) {
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) fail('PLUGIN_PACKAGE_INVALID');
  if (input.byteLength > PLUGIN_PACKAGE_LIMITS.archiveBytes) fail('PLUGIN_PACKAGE_LIMIT');
  if (input.buffer instanceof SharedArrayBuffer) fail('PLUGIN_PACKAGE_INVALID');
  return Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input);
}

/** Inspect an immutable local package. No archive member is executed or rendered. */
export function inspectPluginPackage(input, {hostApiVersion = PLUGIN_HOST_API_VERSION} = {}) {
  const archive = copyInput(input); let parsed;
  try { parsed = readZipFiles(archive, {stripRoot:false,limits:ZIP_LIMITS}); }
  catch (error) {
    if (error?.code === 'ZIP_LIMIT_EXCEEDED') fail('PLUGIN_PACKAGE_LIMIT');
    if (error?.code === 'ZIP_UNSAFE_PATH' || error?.code === 'ZIP_CONFLICT') fail('PLUGIN_PACKAGE_UNSAFE');
    fail(error?.code === 'ZIP_INTEGRITY' ? 'PLUGIN_PACKAGE_INTEGRITY' : 'PLUGIN_PACKAGE_INVALID');
  }
  const {files, manifest:zip} = parsed;
  if (zip.summary.skippedEntries || zip.summary.totalEntries > PLUGIN_PACKAGE_LIMITS.entries || zip.summary.expandedBytes > PLUGIN_PACKAGE_LIMITS.expandedBytes
    || files.length < 2 || files.length > PLUGIN_PACKAGE_LIMITS.files
    || files.some(file => file.bytes.length > PLUGIN_PACKAGE_LIMITS.memberBytes)) fail('PLUGIN_PACKAGE_LIMIT');
  if (zip.entries.some(entry=>!entry.skipped && entry.kind==='directory' && !(entry.path==='content'||entry.path?.startsWith('content/')))) fail('PLUGIN_PACKAGE_UNSAFE');
  const namespace = new Map();
  for (const file of files) {
    const key = portablePathKey(file.path);
    if (namespace.has(key)) fail('PLUGIN_PACKAGE_UNSAFE');
    namespace.set(key, file);
    if (!(file.path === MANIFEST_PATH || file.path === INTEGRITY_PATH || resourcePath(file.path))) fail('PLUGIN_PACKAGE_UNSAFE');
  }
  const manifestFile = namespace.get(portablePathKey(MANIFEST_PATH)), integrityFile = namespace.get(portablePathKey(INTEGRITY_PATH));
  if (!manifestFile || !integrityFile) fail('PLUGIN_PACKAGE_INVALID');
  const manifest = validateManifest(json(manifestFile.bytes, PLUGIN_PACKAGE_LIMITS.manifestBytes));
  const integrity = validateIntegrity(json(integrityFile.bytes, PLUGIN_PACKAGE_LIMITS.integrityBytes));
  const declared = new Map(integrity.map(item => [portablePathKey(item.path), item]));
  const actual = files.filter(file => file.path !== INTEGRITY_PATH);
  if (declared.size !== actual.length || actual.some(file => {
    const item = declared.get(portablePathKey(file.path));
    return !item || item.path !== file.path || item.bytes !== file.bytes.length || item.sha256 !== sha256(file.bytes);
  })) fail('PLUGIN_PACKAGE_INTEGRITY');
  if (manifest.resources.length !== actual.length - 1 || manifest.resources.some(resource => !declared.has(portablePathKey(resource.path)))
    || actual.some(file => file.path !== MANIFEST_PATH && !manifest.resources.some(resource => resource.path === file.path))) fail('PLUGIN_PACKAGE_INTEGRITY');
  const compatible = Number.isSafeInteger(hostApiVersion) && manifest.hostApi.min <= hostApiVersion && hostApiVersion <= manifest.hostApi.max;
  return Object.freeze({digest:sha256(archive), archiveBytes:archive.length, expandedBytes:zip.summary.expandedBytes,
    fileCount:files.length, compatible, manifest, integrity});
}

/** Deterministic package builder for first-party tooling and test fixtures. */
export function createPluginPackage({manifest, resources = [], compression='deflate'}) {
  const normalized = validateManifest(manifest);
  if (!Array.isArray(resources) || resources.length !== normalized.resources.length) fail('PLUGIN_PACKAGE_INVALID');
  const supplied = new Map();
  for (const item of resources) {
    if (!exact(item, ['path','bytes']) || !resourcePath(item.path) || supplied.has(portablePathKey(item.path))) fail('PLUGIN_PACKAGE_INVALID');
    supplied.set(portablePathKey(item.path), {path:item.path, bytes:Buffer.from(item.bytes)});
  }
  if (normalized.resources.some(resource => supplied.get(portablePathKey(resource.path))?.path !== resource.path)) fail('PLUGIN_PACKAGE_INVALID');
  const manifestBytes = Buffer.from(JSON.stringify(normalized, null, 2)+'\n');
  const payload = [{path:MANIFEST_PATH, bytes:manifestBytes}, ...normalized.resources.map(resource => supplied.get(portablePathKey(resource.path)))];
  const integrity = {schemaVersion:1, algorithm:'sha256', files:payload.map(item => ({path:item.path, bytes:item.bytes.length, sha256:sha256(item.bytes)}))};
  const archive = createPackageZip([...payload, {path:INTEGRITY_PATH, bytes:Buffer.from(JSON.stringify(integrity, null, 2)+'\n')}],{compression});
  inspectPluginPackage(archive); return archive;
}
