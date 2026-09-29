import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testRoot} from '../../tools/development-paths.mjs';
import {createNativeService} from './host-service.mjs';
const root = path.join(testRoot, 'runs', 'stage3-artifact-host-unit'); fs.mkdirSync(root, {recursive: true});
async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(root, 'managed-')), dataRoot = path.join(parent, 'profile');
  const service = await createNativeService({dataRoot}); t.after(() => service.close());
  const source = path.join(dataRoot, 'workspaces/asMagicBrain/Workspace');
  fs.writeFileSync(path.join(source, 'slider.html'), '<!doctype html><label>Angle<input type="range" value="45"></label>');
  return {parent, dataRoot, source, service};
}
test('artifact host admission uses saved working tree while retaining drafts and Git status', async t => {
  const f = await fixture(t), request = (operation, args = {}) => f.service.request({repo: 'Workspace', operation, args});
  const opened = await request('open', {path: 'README.md'});
  await request('checkpoint', {path: 'README.md', baseHash: opened.sourceHash, text: 'Private retained draft'});
  const before = await request('gitStatus'), bytes = fs.readFileSync(path.join(f.source, 'slider.html'));
  const snapshot = await f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'slider.html', ref: ''});
  assert.deepEqual(snapshot.assets.get('slider.html').bytes, bytes); assert.equal(snapshot.standalone, true);
  assert.deepEqual(await request('gitStatus'), before); assert.equal((await request('open', {path: 'README.md'})).draft.text, 'Private retained draft');
});
test('host refuses arbitrary roots, refs, unknown repositories and reserved state paths', async t => {
  const f = await fixture(t);
  const invalid = [null, [], {}, {repo: 'Workspace', path: 'slider.html'}, {repo: 'Workspace', path: 'slider.html', ref: 'refs/heads/main'},
    {repo: 'Workspace', path: 'slider.html', ref: '', root: f.parent}, ...['../slider.html', '/etc/passwd', '.git/config', '.asmagicbrain/private', 'slider.html\0'].map(path => ({repo: 'Workspace', path, ref: ''}))];
  for (const value of invalid) await assert.rejects(f.service.prepareArtifactSnapshot(value), {code: 'ARTIFACT_INVALID_REQUEST'});
  fs.mkdirSync(path.join(path.dirname(f.source), 'Unregistered')); fs.writeFileSync(path.join(path.dirname(f.source), 'Unregistered/page.html'), 'do not admit');
  await assert.rejects(f.service.prepareArtifactSnapshot({repo: 'Unregistered', path: 'page.html', ref: ''}));
  await assert.rejects(f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'README.md', ref: ''}), {code: 'ARTIFACT_INVALID_PATH'});
});
test('host rejects symlink files and managed root replacement; request mutation cannot redirect admission', async t => {
  const f = await fixture(t);
  fs.symlinkSync('slider.html', path.join(f.source, 'linked.html'));
  await assert.rejects(f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'linked.html', ref: ''}));
  const input = {repo: 'Workspace', path: 'slider.html', ref: ''}; const work = f.service.prepareArtifactSnapshot(input); input.path = '../outside.html';
  assert.equal((await work).entrySourcePath, 'slider.html');
  const retained = path.join(f.parent, 'preserved-workspace'); fs.renameSync(f.source, retained); fs.mkdirSync(f.source); fs.writeFileSync(path.join(f.source, 'slider.html'), 'replacement');
  await assert.rejects(f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'slider.html', ref: ''}));
  fs.renameSync(f.source, path.join(f.parent, 'unadmitted-replacement')); fs.renameSync(retained, f.source);
});
test('artifact admission participates in normal close and rejects calls after closed', async t => {
  const f = await fixture(t), work = f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'slider.html', ref: ''});
  await f.service.close(); assert.equal((await work).standalone, true);
  await assert.rejects(f.service.prepareArtifactSnapshot({repo: 'Workspace', path: 'slider.html', ref: ''}), {code: 'ARTIFACT_UNAVAILABLE'});
});
