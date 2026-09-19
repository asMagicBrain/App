import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {seedWorkspace} from './seed-workspace.mjs';
import {createWorkspaceService} from './local-workspace.mjs';
import {readLocalRepository} from './local-repositories.mjs';

test('fresh source checkout seeds readable synthetic stories without touching existing content', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-synthetic-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const base = path.join(root, 'repositories');
  assert.equal(seedWorkspace(base).length, 5);
  const service = createWorkspaceService({base, privateBase: path.join(root, 'state')});
  t.after(() => service.close());
  const opened = await service.execute('Workspace', 'open', {path: 'README.md'});
  assert.match(opened.text, /synthetic asMagicBrain/);
  assert.equal((await readLocalRepository('asTeach-App', 'docs/sample-note.md', base)).type, 'file');
  const saved = '\ufeff# My edited sample\r\n';
  fs.writeFileSync(path.join(base, 'Workspace/README.md'), saved);
  fs.unlinkSync(path.join(base, 'Workspace/docs/sample-note.md'));
  assert.deepEqual(seedWorkspace(base), []);
  assert.equal(fs.readFileSync(path.join(base, 'Workspace/README.md'), 'utf8'), saved);
  assert.equal(fs.existsSync(path.join(base, 'Workspace/docs/sample-note.md')), false);
});
