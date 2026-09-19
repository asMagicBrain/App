import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeProfilePaths, admitNativeProfile} from './profile-paths.mjs';
import {createNativeService} from './host-service.mjs';

test('an admitted fresh preview opens a real Workspace and reopens without reseeding it', async t => {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-startup-host-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),appData=path.join(home,'Library/Application Support');
  const paths=nativeProfilePaths({args:[],channel:'preview',packaged:true,home,appData});
  const admission={args:[],channel:'preview',paths};
  admitNativeProfile(admission);
  const marker=fs.readFileSync(path.join(paths.dataRoot,'.asmagicbrain-channel.json'));
  let service=await createNativeService({dataRoot:paths.dataRoot});
  const workspace=path.join(paths.dataRoot,'workspaces/asMagicBrain/Workspace');
  try {
    assert.ok(fs.statSync(path.join(workspace,'.git')).isDirectory());
    assert.match(fs.readFileSync(path.join(workspace,'README.md'),'utf8'),/Your local workspace/);
    await service.setAppearance({themeId:'dark-default',hideUnavailable:false});
  } finally {await service.close();}
  const preserved=Buffer.from('# User-owned bytes\r\n\r\nKeep this exact file.\r\n');
  fs.writeFileSync(path.join(workspace,'README.md'),preserved);
  admitNativeProfile(admission);
  service=await createNativeService({dataRoot:paths.dataRoot});
  try {
    assert.deepEqual(fs.readFileSync(path.join(workspace,'README.md')),preserved);
    assert.equal((await service.getAppearance()).themeId,'dark-default');
    assert.deepEqual(fs.readFileSync(path.join(paths.dataRoot,'.asmagicbrain-channel.json')),marker);
  } finally {await service.close();}
  assert.equal(fs.existsSync(path.join(paths.dataRoot,'.asmb-native.lock')),false);
});

test('a forged or malformed ownership marker never makes an arbitrary directory a fresh Workspace',async t=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-startup-unowned-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.chmodSync(root,0o700);
  const marker=path.join(root,'.asmagicbrain-channel.json');fs.writeFileSync(marker,'{"schemaVersion":2,"channel":"preview"}',{mode:0o600});
  await assert.rejects(createNativeService({dataRoot:root}));
  assert.deepEqual(fs.readdirSync(root),['.asmagicbrain-channel.json']);
});
