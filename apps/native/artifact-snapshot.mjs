import fs from 'node:fs';
import {artifactImage} from './artifact-image.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pinDirectory, checkDirectory, checkSourceSpelling, contains} from '../../packages/desktop-host/src/physical-roots.mjs';

export const ARTIFACT_POLICY_VERSION = 'offline-artifact-1';
export const ARTIFACT_LIMITS = Object.freeze({manifestBytes: 65536, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, files: 64,
  lifetimeMs: 10 * 60 * 1000, loadMs: 15000, memoryKiB: 512 * 1024, sampleMs: 2000});
const fail = (code, detail = '') => {throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), {code});};
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
export const artifactPath = value => bounded(value, 240) && !/^[/.]/.test(value) && !/[\\:%?#]/.test(value)
  && value.split('/').length <= 32 && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.asmagicbrain'].includes(part.toLowerCase()) && !part.toLowerCase().startsWith('.asmb-'));
const mimeTypes = Object.freeze({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'});
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const physicalIdentity = value => `${value.dev}:${value.ino}:${value.mode}:${value.nlink}:${value.mtimeNs}:${value.ctimeNs}`;

/** All source bytes are copied through a checked, non-following descriptor. The caller
 * must admit the managed repository binding before supplying this pinned root. */
function read(root, relative, limit) {
  if (!artifactPath(relative)) fail('ARTIFACT_INVALID_PATH', 'Use a portable repository-relative path.');
  checkDirectory(root); checkSourceSpelling(root.path, relative);
  const filename = path.join(root.path, relative);
  if (!contains(root.path, filename) || fs.realpathSync(filename) !== filename) fail('ARTIFACT_PHYSICAL_CHANGE');
  const parent = pinDirectory(path.dirname(filename));
  const before = fs.lstatSync(filename, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail('ARTIFACT_INVALID_FILE');
  if (before.size > BigInt(limit)) fail('ARTIFACT_LIMIT');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, {bigint: true}))) fail('ARTIFACT_PHYSICAL_CHANGE');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail('ARTIFACT_PHYSICAL_CHANGE'); offset += count;}
    if (!same(before, fs.fstatSync(fd, {bigint: true})) || !same(before, fs.lstatSync(filename, {bigint: true}))) fail('ARTIFACT_PHYSICAL_CHANGE');
    checkDirectory(root); checkDirectory(parent); checkSourceSpelling(root.path, relative);
    return {bytes, physical: `${physicalIdentity(before)}|${parent.chain.map(item => item.rawIdentity).join('|')}`};
  } finally {fs.closeSync(fd);}
}

export function validateArtifactManifest(value) {
  if (!record(value)) fail('ARTIFACT_INVALID_MANIFEST', 'The manifest must be a JSON object.');
  if (value.schemaVersion !== 1) fail('ARTIFACT_INVALID_MANIFEST', 'schemaVersion: expected 1.');
  if (value.network !== 'none') fail('ARTIFACT_INVALID_MANIFEST', 'network: expected none. Network access is not supported.');
  for (const field of ['entryPath','fallbackPath']) if (!artifactPath(value[field])) fail('ARTIFACT_INVALID_MANIFEST', `${field}: use a path relative to the manifest folder.`);
  if (!Array.isArray(value.assets)) fail('ARTIFACT_INVALID_MANIFEST', 'assets: expected a list of saved files with path, bytes, sha256 and role.');
  if (!keys(value, ['schemaVersion', 'id', 'title', 'entryPath', 'fallbackPath', 'posterPath', 'network', 'assets']) || value.schemaVersion !== 1
    || !bounded(value.id, 80) || !/^[a-z][a-z0-9.-]*$/.test(value.id) || !bounded(value.title, 120)
    || !artifactPath(value.entryPath) || !/\.html$/i.test(value.entryPath) || !artifactPath(value.fallbackPath) || !/\.(md|txt)$/i.test(value.fallbackPath)
    || value.entryPath === value.fallbackPath || value.posterPath !== undefined && (!artifactPath(value.posterPath) || !/\.(?:png|jpe?g)$/i.test(value.posterPath))
    || value.network !== 'none' || !Array.isArray(value.assets) || value.assets.length < 2 || value.assets.length > ARTIFACT_LIMITS.files) fail('ARTIFACT_INVALID_MANIFEST');
  let total = 0;
  for (const [index, asset] of value.assets.entries()) {
    if (!record(asset) || !artifactPath(asset.path)) fail('ARTIFACT_INVALID_MANIFEST', `assets[${index}].path: use a portable path relative to the manifest folder.`);
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail('ARTIFACT_INVALID_MANIFEST', `assets[${index}].sha256: expected a lowercase SHA-256 hash.`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > ARTIFACT_LIMITS.fileBytes) fail('ARTIFACT_INVALID_MANIFEST', `assets[${index}].bytes: expected 0 to ${ARTIFACT_LIMITS.fileBytes}.`);
    if (!['entry','script','style','data','fallback'].includes(asset.role)) fail('ARTIFACT_INVALID_MANIFEST', `assets[${index}].role: expected entry, script, style, data or fallback; images use data.`);
    if (!keys(asset, ['path', 'sha256', 'bytes', 'role']) || !artifactPath(asset.path) || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > ARTIFACT_LIMITS.fileBytes
      || !['entry', 'script', 'style', 'data', 'fallback'].includes(asset.role) || !mimeTypes[path.extname(asset.path).toLowerCase()]) fail('ARTIFACT_INVALID_MANIFEST');
    // Only the declared entry is a document. SVG is image-only through CSP; no nested HTML realm.
    if (/\.html$/i.test(asset.path) && asset.role !== 'entry') fail('ARTIFACT_INVALID_MANIFEST', `assets[${index}]: additional HTML pages cannot use the data role. Each interactive page needs its own entry manifest; ordinary document links stay in the main reader.`);
    if ((/\.html$/i.test(asset.path)) !== (asset.role === 'entry') || (asset.role === 'script' && !/\.(?:m?js)$/i.test(asset.path))
      || (asset.role === 'style' && !/\.css$/i.test(asset.path))) fail('ARTIFACT_INVALID_MANIFEST');
    total += asset.bytes;
  }
  if (total > ARTIFACT_LIMITS.totalBytes || new Set(value.assets.map(asset => asset.path.toLowerCase())).size !== value.assets.length
    || value.assets.filter(asset => asset.role === 'entry').length !== 1 || value.assets.filter(asset => asset.role === 'fallback').length !== 1
    || !value.assets.some(asset => asset.path === value.entryPath && asset.role === 'entry')
    || !value.assets.some(asset => asset.path === value.fallbackPath && asset.role === 'fallback')
    || value.posterPath !== undefined && !value.assets.some(asset => asset.path === value.posterPath && asset.role === 'data')) fail('ARTIFACT_INVALID_MANIFEST');
  return structuredClone(value);
}

/** Working-tree-only immutable in-memory snapshot. Existing proposal documents are
 * never silently upgraded or written. A standalone HTML admits exactly its own bytes. */
export function prepareArtifactSnapshot({root, path: relative}) {
  if (!root || !artifactPath(relative) || !/\.(?:artifact\.json|html)$/i.test(relative)) fail('ARTIFACT_INVALID_PATH');
  checkDirectory(root);
  const standalone = /\.html$/i.test(relative), initial = read(root, relative, standalone ? ARTIFACT_LIMITS.fileBytes : ARTIFACT_LIMITS.manifestBytes);
  const base = path.posix.dirname(relative), prefix = base === '.' ? '' : `${base}/`;
  let manifest;
  if (standalone) {
    const entry = path.posix.basename(relative);
    manifest = {schemaVersion: 1, id: 'standalone.html', title: entry, entryPath: entry, fallbackPath: null, network: 'none',
      assets: [{path: entry, role: 'entry', bytes: initial.bytes.length, sha256: hash(initial.bytes)}]};
  } else {
    try {manifest = validateArtifactManifest(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(initial.bytes)));}
    catch (error) {if (error.code) throw error; fail('ARTIFACT_INVALID_MANIFEST');}
  }
  const warnings = [], assets = new Map(), physical = [[relative, initial.physical]];
  for (const entry of manifest.assets) {
    let result;
    try {result = standalone ? initial : read(root, prefix + entry.path, ARTIFACT_LIMITS.fileBytes);}
    catch (error) {if(error.code === 'ENOENT' || error.code === 'PARTIAL') fail('ARTIFACT_MISSING_ASSET', `${entry.path}: missing beside the manifest. Restore the file or correct its assets path.`);if(error.code === 'DENIED') fail('ARTIFACT_INVALID_FILE', `${entry.path}: linked, ambiguous or inaccessible path. Use the exact spelling of a regular local file.`);if(/^ARTIFACT_/.test(error.code ?? '')) fail(error.code, `${entry.path}: admission failed. Keep a regular local file within the manifest folder.`);throw error;}
    if (result.bytes.length !== entry.bytes) fail('ARTIFACT_HASH_MISMATCH', `${entry.path}: manifest ${entry.bytes} bytes; saved file ${result.bytes.length} bytes. Rebuild the manifest from saved files.`);
    const observedHash = hash(result.bytes);
    if (observedHash !== entry.sha256) fail('ARTIFACT_HASH_MISMATCH', `${entry.path}: expected ${entry.sha256}; observed ${observedHash}. Rebuild the manifest from saved files.`);
    const extension=path.extname(entry.path).toLowerCase(), image=/^\.(?:png|jpe?g)$/.test(extension)?artifactImage(result.bytes):null;
    const mime=image?.mime ?? mimeTypes[extension];
    if(image&&image.mime!==mimeTypes[extension])warnings.push(`${entry.path}: saved image format is ${image.mime}; the filename extension differs. Original bytes are preserved.`);
    assets.set(entry.path, {bytes: Buffer.from(result.bytes), mime, role: entry.role});
    physical.push([prefix + entry.path, result.physical]);
  }
  // Recheck every input before admission, not just the last file. Replacement with
  // identical bytes still changes review identity; later execution never rereads URLs.
  for (const [filename, expected] of physical) {
    const current = read(root, filename, filename === relative && !standalone ? ARTIFACT_LIMITS.manifestBytes : ARTIFACT_LIMITS.fileBytes);
    if (current.physical !== expected) fail('ARTIFACT_PHYSICAL_CHANGE');
    const original = filename === relative ? initial.bytes : assets.get(filename.slice(prefix.length))?.bytes;
    if (!original || !current.bytes.equals(original)) fail('ARTIFACT_PHYSICAL_CHANGE');
  }
  checkDirectory(root);
  const contentIdentity = {manifestSha256: hash(initial.bytes), runtimePolicyVersion: ARTIFACT_POLICY_VERSION,
    assets: manifest.assets.map(({path, bytes, sha256}) => ({path, bytes, sha256})).sort((a, b) => a.path.localeCompare(b.path))};
  const identity = hash(JSON.stringify({contentIdentity, root: root.chain.map(item => item.rawIdentity), physical: physical.sort((a, b) => a[0].localeCompare(b[0]))}));
  let fallback = standalone ? 'This standalone HTML has no separate poster or text fallback. Its source remains available without running it.' : '';
  if (!standalone) {try {fallback = new TextDecoder('utf-8', {fatal: true}).decode(assets.get(manifest.fallbackPath).bytes);}
    catch {fail('ARTIFACT_INVALID_FALLBACK');}}
  let poster = null;
  if (manifest.posterPath) {
    const bytes = assets.get(manifest.posterPath).bytes;
    const image=artifactImage(bytes);
    if (!image || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) fail('ARTIFACT_INVALID_POSTER', `${manifest.posterPath}: use a valid PNG or JPEG poster up to 4096 × 4096 pixels.`);
    poster = {path: manifest.posterPath, mime: image.mime, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
  }
  return {identity, contentIdentity, manifest, assets, sourcePath: relative, entrySourcePath: prefix + manifest.entryPath,
    source: new TextDecoder('utf-8', {fatal: true}).decode(assets.get(manifest.entryPath).bytes), fallback, poster, warnings, standalone};
}

export function artifactPublicReview(snapshot, reviewId) {
  return {reviewId, identity: snapshot.identity, digest: snapshot.identity, policyVersion: ARTIFACT_POLICY_VERSION, title: snapshot.manifest.title, path: snapshot.sourcePath,
    entryPath: snapshot.entrySourcePath, standalone: snapshot.standalone, assets: snapshot.contentIdentity.assets, source: snapshot.source,
    warnings: snapshot.warnings, fallback: snapshot.fallback, poster: snapshot.poster ? {...snapshot.poster, data: snapshot.poster.data.slice(0)} : null,
    permissions: {network: false, nativeBridge: false, filesystem: 'listed-assets-only', workers: false, webRTC: false},
    limits: ARTIFACT_LIMITS};
}

export function artifactAssetResponse(snapshot, requestURL, origin, method = 'GET') {
  try {
    if (typeof requestURL !== 'string' || /%2f|%5c|%2e/i.test(requestURL)) return null;
    const url = new URL(requestURL);
    if (method !== 'GET' || `${url.protocol}//${url.host}` !== origin || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) return null;
    const relative = decodeURIComponent(url.pathname.slice(1));
    if (!artifactPath(relative)) return null;
    const asset = snapshot.assets.get(relative);
    return asset ? {bytes: Buffer.from(asset.bytes), mime: asset.mime, entry: relative === snapshot.manifest.entryPath} : null;
  } catch {return null;}
}

export {pinDirectory};
