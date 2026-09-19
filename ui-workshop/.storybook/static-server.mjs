import {seedWorkspace} from './seed-workspace.mjs';
import { createServer } from 'node:http';
import { localRepositoryResponse } from './local-repositories.mjs';
import { createWorkspaceHandler } from './local-workspace.mjs';
import { createRepositoryImportHandler } from './repository-import.mjs';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = fileURLToPath(new URL('../storybook-static/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// Exported only to exercise path handling on generated test roots. The executable
// below has no root/port arguments and serves only this workshop's static build.
export async function staticHandler(root, port = 6006) {
  const canonical = await realpath(root), anchor = await lstat(root);
  if (!anchor.isDirectory() || anchor.isSymbolicLink() || canonical !== path.resolve(root)) throw Error('Invalid static build directory.');
  return async (req, res) => {
    const fail = status => { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); };
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return fail(403);
    let pieces;
    try {
      const raw = req.url.split('?')[0];
      if (!raw.startsWith('/') || raw.startsWith('//')) return fail(400);
      const decoded = decodeURIComponent(raw);
      if (/[\\\0]/.test(decoded)) return fail(400);
      pieces = decoded.slice(1).split('/');
      if (pieces.some(item => item === '.' || item === '..')) return fail(403);
      if (pieces.length === 1 && pieces[0] === '') pieces = ['index.html'];
      if (pieces.some(item => item === '')) return fail(404);
    } catch { return fail(400); }
    let handle;
    try {
      if (!same(anchor, await lstat(root))) return fail(503);
      let candidate = root;
      for (let i = 0; i < pieces.length; i++) {
        candidate = path.join(candidate, pieces[i]);
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink() || (i < pieces.length - 1 && !entry.isDirectory())) return fail(404);
      }
      if (await realpath(candidate) !== candidate) return fail(404);
      const named = await lstat(candidate);
      if (!named.isFile() || named.size > 16 * 1024 * 1024) return fail(404);
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || !unchanged(named, before)) return fail(503);
      const bytes = await handle.readFile();
      if (bytes.length !== before.size || !unchanged(before, await handle.stat()) ||
          !unchanged(before, await lstat(candidate)) || await realpath(candidate) !== candidate ||
          !same(anchor, await lstat(root))) return fail(503);
      res.writeHead(200, { 'Content-Type': mime[path.extname(candidate)] ?? 'application/octet-stream',
        'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent) fail(404); else res.destroy(); }
    finally { await handle?.close(); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw Error('Static server takes no arguments.');
  const handler = await staticHandler(path.resolve(output));
  seedWorkspace();
  const workspace = createWorkspaceHandler();
  const importer = createRepositoryImportHandler();
  const server = createServer((req,res) => req.url?.split('?')[0] === '/__repository-import' ? importer(req,res) : req.url?.split('?')[0] === '/__local-workspace' ? workspace(req,res) : req.url?.split('?')[0] === '/__local-repositories' ? localRepositoryResponse(req,res) : handler(req,res));
  server.on('close',()=>workspace.close());
  server.on('error', error => { console.error(`Static Storybook server: ${error.code ?? 'failed'}`); process.exitCode = 1; });
  server.listen(6006, '127.0.0.1', () => console.log('Storybook: http://127.0.0.1:6006 (static; after changes stop with Ctrl-C, rerun npm run storybook, then reload)'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
