import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const docsHash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => {throw Object.assign(Error('Bundled documentation is missing or has changed.'), {code: 'DOCS_PAYLOAD_INVALID'});};
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[\x00-\x1f\x7f]/.test(part));

/** The public payload contains ordinary files only. Git/private state is never
 * copied from the developer's managed documentation repository. */
export function createBundledDocsManifest(directory, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail();
  const root = path.resolve(directory), files = [];
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail();
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const relative = prefix + name, filename = path.join(folder, name), stat = fs.lstatSync(filename);
      if (!safePath(relative) || stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) walk(filename, relative + '/');
      else if (stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024) files.push({path: relative, bytes: stat.size, sha256: docsHash(fs.readFileSync(filename))});
      else fail();
    }
  }
  walk(root);
  if (!files.length || files.length > 1000 || !files.some(file => file.path === 'README.md')) fail();
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {schemaVersion: 1, version, files, digest: docsHash(JSON.stringify(files))};
}

export function verifyBundledDocsPayload(directory, manifest) {
  try {
    const actual = createBundledDocsManifest(directory, manifest?.version);
    if (JSON.stringify(actual) !== JSON.stringify(manifest)) fail();
    return actual;
  } catch {fail();}
}

export function loadBundledDocs(appRoot, {packaged = false, metadata} = {}) {
  const root = path.join(appRoot, 'docs');
  const manifest = packaged ? JSON.parse(fs.readFileSync(path.join(appRoot, 'docs-manifest.json'), 'utf8'))
    : createBundledDocsManifest(root, JSON.parse(fs.readFileSync(path.join(appRoot, 'apps/native/release.json'), 'utf8')).version);
  if (packaged && (metadata?.bundledDocumentation?.digest !== manifest.digest || metadata.bundledDocumentation.version !== manifest.version || metadata.bundledDocumentation.fileCount !== manifest.files?.length)) fail();
  verifyBundledDocsPayload(root, manifest);
  return {root, manifest};
}
