import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {renderSourcePreview, localLink} from '../apps/desktop/ui/markdown-preview.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const docsRoot = path.join(root, 'docs');
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const parser = new MarkdownIt({html: false, linkify: false});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failures = [];
const fail = (file, rule, detail) => failures.push({file, rule, ...(detail ? {detail} : {})});
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const community = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md'];
const files = new Set([...tracked, ...community]);
const payload = [];
const allowedAssets = new Set(['.md', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.webm', '.mp4']);
function walk(folder) {
  for (const name of fs.readdirSync(folder).sort()) {
    const absolute = path.join(folder, name), relative = path.relative(root, absolute).split(path.sep).join('/');
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {fail(relative, 'physical-payload'); continue;}
    if (name.startsWith('.')) fail(relative, 'hidden-payload');
    if (stat.isDirectory()) walk(absolute);
    else {
      if (!allowedAssets.has(path.extname(name).toLowerCase())) fail(relative, 'unsupported-payload');
      if (stat.mode & 0o111) fail(relative, 'executable-payload');
      const bytes = fs.readFileSync(absolute);
      payload.push({path: relative.slice('docs/'.length), bytes: bytes.length, sha256: sha256(bytes)});
      if (name.endsWith('.md')) files.add(relative);
    }
  }
}
walk(docsRoot);
const pages = new Map();
for (const file of [...files].sort()) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {fail(file, 'missing-page'); continue;}
  const source = fs.readFileSync(absolute, 'utf8');
  if (/\/Users\/|\/Volumes\/|\.planning\//i.test(source)) fail(file, 'private-path-or-record');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]+)\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) fail(file, 'secret-shaped-content');
  const rendered = renderSourcePreview(source, file, {externalLinks: true});
  if (rendered.limited) fail(file, 'render-limit');
  if (rendered.html.includes('<script') || rendered.html.includes('javascript:')) fail(file, 'active-rendered-content');
  const anchors = new Set([...rendered.html.matchAll(/data-heading-anchor="([^"]*)"/g)].map(match => match[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')));
  pages.set(file, {source, anchors, rendered, tokens: parser.parse(source, {})});
}
let links = 0, images = 0, headings = 0;
function tokens(items, visit) {for (const token of items) {visit(token); if (token.children) tokens(token.children, visit);}}
for (const [file, page] of pages) {
  headings += page.rendered.headings.length;
  tokens(page.tokens, token => {
    if (!['link_open', 'image'].includes(token.type)) return;
    const target = token.attrGet(token.type === 'image' ? 'src' : 'href') ?? '';
    if (token.type === 'image') images++; else links++;
    if (/^https?:\/\//.test(target)) {if (token.type === 'image' && file.startsWith('docs/')) fail(file, 'remote-image'); return;}
    if (/^mailto:/.test(target)) return;
    const resolved = localLink(target, file);
    if (!resolved) {fail(file, 'invalid-local-link', target); return;}
    const absolute = path.join(root, resolved.path);
    if (!within(root, absolute) || file.startsWith('docs/') && !within(docsRoot, absolute)) {fail(file, 'non-standalone-link', target); return;}
    if (!fs.existsSync(absolute)) {fail(file, 'missing-link', target); return;}
    if (resolved.fragment) {
      const linked = pages.get(resolved.path);
      if (!linked || !linked.anchors.has(resolved.fragment)) fail(file, 'missing-heading', target);
    }
  });
}
const report = {schemaVersion: 1, status: failures.length ? 'failed' : 'passed', scope: 'Public Markdown links, actual renderer anchors, standalone payload and bounded privacy-pattern checks; not a complete secret or legal audit.',
  pages: pages.size, headings, links, images, documentationFiles: payload.length, documentationBytes: payload.reduce((sum, file) => sum + file.bytes, 0), payload, failures};
const args = process.argv.slice(2);
if (args.length > 1 || args[0] && !args[0].startsWith('--output=')) throw Error('Use check-public-docs.mjs [--output=/absolute/new/report.json]');
if (args.length) {
  const output = args[0].slice('--output='.length);
  if (!path.isAbsolute(output) || within(root, path.resolve(output)) || !fs.statSync(path.dirname(output)).isDirectory()) throw Error('Report output must be an existing external directory and a new filename.');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
}
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
