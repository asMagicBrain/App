import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testRoot} from '../../tools/development-paths.mjs';
import {prepareArtifactSnapshot, pinDirectory, artifactPublicReview, artifactAssetResponse, validateArtifactManifest} from './artifact-snapshot.mjs';
const root = path.join(testRoot, 'runs', 'stage3-artifact-unit'); fs.mkdirSync(root, {recursive: true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'snapshot-'));
  const files = {'index.html': '<!doctype html><h1>Interactive</h1><script type="module" src="main.mjs"></script>', 'main.mjs': 'document.title="loaded";', 'fallback.md': '# Readable fallback'};
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const manifest = {schemaVersion: 1, id: 'test.module', title: 'Module', entryPath: 'index.html', fallbackPath: 'fallback.md', network: 'none',
    assets: Object.entries(files).map(([name, bytes]) => ({path: name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes), role: name.endsWith('.html') ? 'entry' : name.endsWith('.mjs') ? 'script' : 'fallback'}))};
  fs.writeFileSync(path.join(dir, 'module.artifact.json'), JSON.stringify(manifest));
  return {dir, files, manifest, load: () => prepareArtifactSnapshot({root: pinDirectory(dir), path: 'module.artifact.json'})};
}
test('admission copies listed bytes; later writes cannot mutate accepted snapshot', () => {
  const f = fixture(), snapshot = f.load();
  assert.equal(snapshot.assets.get('main.mjs').bytes.toString(), f.files['main.mjs']);
  const publicReview = artifactPublicReview(snapshot, 'review');
  assert.equal(publicReview.source, f.files['index.html']);
  assert.equal(publicReview.fallback, f.files['fallback.md']);
  assert.equal(publicReview.permissions.network, false);
  assert.equal(JSON.stringify(publicReview).includes(f.dir), false);
  fs.writeFileSync(path.join(f.dir, 'main.mjs'), 'changed();');
  assert.equal(snapshot.assets.get('main.mjs').bytes.toString(), f.files['main.mjs']);
  assert.throws(f.load, {code: 'ARTIFACT_HASH_MISMATCH'});
});
test('replacing an inode with identical bytes changes approval identity', () => {
  const f = fixture(), before = f.load();
  fs.renameSync(path.join(f.dir, 'main.mjs'), path.join(f.dir, 'previous.mjs'));
  fs.writeFileSync(path.join(f.dir, 'main.mjs'), f.files['main.mjs']);
  const after = f.load(); assert.notEqual(before.identity, after.identity);
  assert.deepEqual(before.contentIdentity, after.contentIdentity);
});
test('moving an unchanged dependency inode into a substituted parent revokes approval', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.dir, 'lib')); fs.renameSync(path.join(f.dir, 'main.mjs'), path.join(f.dir, 'lib/main.mjs'));
  f.manifest.assets[1].path = 'lib/main.mjs'; fs.writeFileSync(path.join(f.dir, 'module.artifact.json'), JSON.stringify(f.manifest));
  const before = f.load(); fs.renameSync(path.join(f.dir, 'lib'), path.join(f.dir, 'retained-lib')); fs.mkdirSync(path.join(f.dir, 'lib'));
  fs.renameSync(path.join(f.dir, 'retained-lib/main.mjs'), path.join(f.dir, 'lib/main.mjs'));
  const after = f.load(); assert.deepEqual(before.contentIdentity, after.contentIdentity); assert.notEqual(before.identity, after.identity);
});
test('optional poster comes only from declared bounded PNG snapshot bytes', () => {
  const f = fixture(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(f.dir, 'poster.png'), png); f.manifest.posterPath = 'poster.png';
  f.manifest.assets.push({path: 'poster.png', bytes: png.length, sha256: digest(png), role: 'data'});
  fs.writeFileSync(path.join(f.dir, 'module.artifact.json'), JSON.stringify(f.manifest));
  const loaded = f.load(), review = artifactPublicReview(loaded, 'id'); assert.equal(review.poster.mime, 'image/png');
  assert.deepEqual(Buffer.from(review.poster.data), png); new Uint8Array(review.poster.data).fill(0); assert.deepEqual(Buffer.from(loaded.poster.data), png);
  png.writeUInt32BE(65535, 16); fs.writeFileSync(path.join(f.dir, 'poster.png'), png); f.manifest.assets.at(-1).sha256 = digest(png);
  fs.writeFileSync(path.join(f.dir, 'module.artifact.json'), JSON.stringify(f.manifest)); assert.throws(f.load, {code: 'ARTIFACT_INVALID_POSTER'});
});
test('symlinks, hardlinks, traversal and missing files cannot gain snapshot authority', () => {
  const f = fixture(); fs.renameSync(path.join(f.dir, 'main.mjs'), path.join(f.dir, 'original.mjs'));
  fs.symlinkSync('original.mjs', path.join(f.dir, 'main.mjs')); assert.throws(f.load);
  fs.unlinkSync(path.join(f.dir, 'main.mjs')); fs.linkSync(path.join(f.dir, 'original.mjs'), path.join(f.dir, 'main.mjs'));
  assert.throws(f.load, {code: 'ARTIFACT_INVALID_FILE'});
  assert.throws(() => prepareArtifactSnapshot({root: pinDirectory(f.dir), path: '../test.html'}), {code: 'ARTIFACT_INVALID_PATH'});
});
test('strict schema rejects extra authority, duplicate aliases, unbounded and nested HTML assets', () => {
  const f = fixture();
  for (const mutation of [value => value.network = '*', value => value.preload = './bridge.js', value => value.assets.push({...value.assets[1], path: 'MAIN.MJS'}),
    value => value.assets[1].bytes = 3 * 1024 * 1024, value => value.assets[1].path = 'other.html', value => value.assets[1].path = '%2e%2e/main.mjs']) {
    const value = structuredClone(f.manifest); mutation(value); assert.throws(() => validateArtifactManifest(value), {code: 'ARTIFACT_INVALID_MANIFEST'});
  }
});
test('standalone HTML admits no sibling, source stays exact and no source files are generated', () => {
  const f = fixture(), before = fs.readdirSync(f.dir);
  const snapshot = prepareArtifactSnapshot({root: pinDirectory(f.dir), path: 'index.html'});
  assert.equal(snapshot.standalone, true); assert.equal(snapshot.assets.size, 1); assert.equal(snapshot.source, f.files['index.html']);
  assert.deepEqual(fs.readdirSync(f.dir), before);
});
test('resolver admits only exact origin, method and listed path with copied response bytes', () => {
  const f = fixture(), snapshot = f.load(), origin = 'asmb-artifact://one';
  const admitted = artifactAssetResponse(snapshot, origin + '/main.mjs', origin); assert.equal(admitted.mime, 'text/javascript; charset=utf-8');
  admitted.bytes.fill(0); assert.notEqual(snapshot.assets.get('main.mjs').bytes[0], 0);
  for (const url of ['asmb-artifact://other/main.mjs', 'https://one/main.mjs', 'file:///main.mjs', origin + '/unknown.js', origin + '/main.mjs?q=1', origin + '/%2e/main.mjs']) assert.equal(artifactAssetResponse(snapshot, url, origin), null);
  assert.equal(artifactAssetResponse(snapshot, origin + '/main.mjs', origin, 'POST'), null);
});
