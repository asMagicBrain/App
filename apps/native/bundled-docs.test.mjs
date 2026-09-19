import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {installBundledDocs} from './bundled-docs.mjs';
import {createBundledDocsManifest, verifyBundledDocsPayload, loadBundledDocs} from './bundled-docs-manifest.mjs';

function fixture() {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundled-docs-'));
  assert(parent.includes('/asMagicBrain-Test/'));
  const organization = path.join(parent, 'organization'), privateRoot = path.join(parent, 'private'), payloadRoot = path.join(parent, 'payload');
  for (const directory of [organization, privateRoot, payloadRoot]) fs.mkdirSync(directory, {mode: 0o700});
  const options = {organization, privateRoot, payloadRoot, bindingHash: 'a'.repeat(64)};
  const edition = (version, text) => {fs.writeFileSync(path.join(payloadRoot, 'README.md'), text); options.manifest = createBundledDocsManifest(payloadRoot, version);};
  edition('0.2.10', '# Public documentation\n');
  return {...options, options, edition};
}
const id = filename => {const stat = fs.statSync(filename); return `${stat.dev}:${stat.ino}`;};
const preserved = f => fs.readdirSync(f.organization).filter(name => name.startsWith('.asmb-docs-preserved-')).filter(name => fs.existsSync(path.join(f.organization, name, 'README.md')));

test('public payload validation rejects extra files, changed bytes, links and packaged metadata mismatch', () => {
  const f = fixture(), manifest = f.options.manifest;
  assert.deepEqual(verifyBundledDocsPayload(f.payloadRoot, manifest), manifest);
  fs.writeFileSync(path.join(f.payloadRoot, 'extra.md'), 'unexpected');
  assert.throws(() => verifyBundledDocsPayload(f.payloadRoot, manifest), {code: 'DOCS_PAYLOAD_INVALID'});
  fs.unlinkSync(path.join(f.payloadRoot, 'extra.md'));
  fs.symlinkSync('README.md', path.join(f.payloadRoot, 'linked.md'));
  assert.throws(() => createBundledDocsManifest(f.payloadRoot, '0.2.10'), {code: 'DOCS_PAYLOAD_INVALID'});
  fs.unlinkSync(path.join(f.payloadRoot, 'linked.md'));
  const app = path.dirname(f.payloadRoot); fs.renameSync(f.payloadRoot, path.join(app, 'docs'));
  fs.writeFileSync(path.join(app, 'docs-manifest.json'), JSON.stringify(manifest));
  assert.throws(() => loadBundledDocs(app, {packaged: true, metadata: {bundledDocumentation: {digest: '0'.repeat(64)}}}), {code: 'DOCS_PAYLOAD_INVALID'});
  assert.equal(loadBundledDocs(app, {packaged: true, metadata: {bundledDocumentation: {version: manifest.version, digest: manifest.digest, fileCount: manifest.files.length}}}).manifest.digest, manifest.digest);
});

test('fresh install is local Git, restart retains identity, update preserves complete previous edition', async () => {
  const f = fixture(), first = await installBundledDocs(f.options), root = path.join(f.organization, first.entry.name);
  assert.deepEqual(first.entry, {name: 'asMagicBrain-Docs', privateRepo: false, builtin: 'documentation', readOnly: true});
  assert.equal(fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  const again = await installBundledDocs(f.options); assert.equal(again.identity, first.identity); assert.deepEqual(preserved(f), []);
  f.edition('0.2.11', '# Updated public documentation\n');
  const next = await installBundledDocs(f.options); assert.notEqual(next.identity, first.identity);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Updated public documentation\n');
  assert.equal(preserved(f).length, 1);
  assert.equal(fs.readFileSync(path.join(f.organization, preserved(f)[0], 'README.md'), 'utf8'), '# Public documentation\n');
  assert.equal(id(path.join(f.organization, preserved(f)[0])), first.identity);
  assert.equal((await installBundledDocs(f.options)).identity, next.identity);
});

test('foreign name collision is never adopted; changed owned content and missing files are preserved before repair', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.organization, 'asMagicBrain-Docs')); fs.writeFileSync(path.join(f.organization, 'asMagicBrain-Docs', 'owner.txt'), 'private user file');
  const first = await installBundledDocs(f.options); assert.equal(first.entry.name, 'asMagicBrain-Docs-2');
  const root = path.join(f.organization, first.entry.name);
  fs.writeFileSync(path.join(root, 'README.md'), 'external edit'); fs.writeFileSync(path.join(root, 'untracked.txt'), 'keep this');
  const next = await installBundledDocs(f.options); assert.equal(next.entry.name, first.entry.name);
  assert.equal(fs.readFileSync(path.join(f.organization, 'asMagicBrain-Docs', 'owner.txt'), 'utf8'), 'private user file');
  assert.equal(fs.readFileSync(path.join(f.organization, preserved(f)[0], 'README.md'), 'utf8'), 'external edit');
  assert.equal(fs.readFileSync(path.join(f.organization, preserved(f)[0], 'untracked.txt'), 'utf8'), 'keep this');
  fs.unlinkSync(path.join(root, 'README.md')); await installBundledDocs(f.options);
  assert.equal(preserved(f).length, 1); // The second preserved folder intentionally has no README.
  assert.equal(fs.readdirSync(f.organization).filter(name => name.startsWith('.asmb-docs-preserved-')).length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Public documentation\n');
});

test('replaced or missing owned root never transfers ownership to foreign bytes', async () => {
  const f = fixture(), first = await installBundledDocs(f.options), root = path.join(f.organization, first.entry.name);
  fs.renameSync(root, path.join(f.organization, 'moved-by-user'));
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'foreign.txt'), 'keep');
  const next = await installBundledDocs(f.options); assert.equal(next.entry.name, 'asMagicBrain-Docs-2');
  assert.equal(fs.readFileSync(path.join(root, 'foreign.txt'), 'utf8'), 'keep');
  fs.renameSync(path.join(f.organization, next.entry.name), path.join(f.organization, 'second-user-move'));
  assert.equal((await installBundledDocs(f.options)).entry.name, next.entry.name);
  assert(fs.existsSync(path.join(f.organization, 'second-user-move', 'README.md')));
});

test('stage parent must sync before a ready intent can publish; injected sync failure keeps the current edition intact', async t => {
  const f = fixture(), first = await installBundledDocs(f.options);
  f.edition('0.2.11', '# New edition after parent sync\n');
  const parentIdentity = id(f.organization), originalSync = fs.fsyncSync, points = [];
  let rejected = false;
  fs.fsyncSync = descriptor => {
    const stat = fs.fstatSync(descriptor);
    if (stat.isDirectory() && `${stat.dev}:${stat.ino}` === parentIdentity) {
      rejected = true;
      throw Object.assign(Error('Injected parent durability failure'), {code: 'EIO'});
    }
    return originalSync(descriptor);
  };
  t.after(() => {fs.fsyncSync = originalSync;});
  try {
    await assert.rejects(installBundledDocs({...f.options, hooks: {at: point => points.push(point)}}), {code: 'EIO'});
  } finally {fs.fsyncSync = originalSync;}
  assert.equal(rejected, true);
  assert.equal(points.includes('docs-ready'), false);
  assert.equal(id(path.join(f.organization, first.entry.name)), first.identity);
  assert.equal(fs.readFileSync(path.join(f.organization, first.entry.name, 'README.md'), 'utf8'), '# Public documentation\n');
  assert.deepEqual(preserved(f), []);
  const retried = await installBundledDocs(f.options);
  assert.equal(fs.readFileSync(path.join(f.organization, retried.entry.name, 'README.md'), 'utf8'), '# New edition after parent sync\n');
  assert.equal(preserved(f).length, 1);
});

test('durable install/update checkpoints recover after a stopped process without losing previous bytes', async t => {
  for (const point of ['docs-ready', 'docs-backup-reserved', 'docs-previous-preserved', 'docs-target-reserved', 'docs-published', 'docs-completed']) await t.test(point, async () => {
    const f = fixture(), first = await installBundledDocs(f.options);
    f.edition('0.2.11', '# New edition\n');
    const script = `import {installBundledDocs} from ${JSON.stringify(new URL('./bundled-docs.mjs', import.meta.url).href)}; await installBundledDocs({...${JSON.stringify(f.options)},hooks:{at:point=>{if(point===${JSON.stringify(point)})process.exit(86);}}});process.exit(87);`;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env}, stdio: 'pipe'}), error => error.status === 86);
    const next = await installBundledDocs(f.options); assert.notEqual(next.identity, first.identity);
    assert.equal(fs.readFileSync(path.join(f.organization, next.entry.name, 'README.md'), 'utf8'), '# New edition\n');
    assert.equal(preserved(f).length, 1);
    assert.equal(fs.readFileSync(path.join(f.organization, preserved(f)[0], 'README.md'), 'utf8'), '# Public documentation\n');
  });
});
