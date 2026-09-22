/** Read-only packaged CSS/font check; does not establish native font decoding. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function declarations(body) {
  const parts = []; let start = 0, depth = 0, quote;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    assert.notEqual(ch, '\\', 'Escaped font-face syntax needs explicit review');
    if (quote) {if (ch === quote) quote = undefined; continue;}
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {depth--; assert(depth >= 0, 'Unbalanced font-face declaration');}
    else if (ch === ';' && depth === 0) {parts.push(body.slice(start, i)); start = i + 1;}
  }
  assert(!quote && depth === 0, 'Incomplete font-face declaration');
  return [...parts, body.slice(start)];
}

/** Supply the renderer dist directory, or its assets directory. */
export async function verifyFontAssets(inputPath) {
  const root = await fs.realpath(path.resolve(inputPath));
  assert((await fs.stat(root)).isDirectory(), 'Renderer path must be a directory');
  const cssPaths = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'Renderer assets must not contain symlinks: ' + target);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.css$/i.test(entry.name)) cssPaths.push(target);
    }
  }
  await walk(root); cssPaths.sort();
  assert(cssPaths.length > 0, 'No built renderer CSS found');
  const css = [], fonts = new Map(); let fontFaces = 0, references = 0;
  for (const cssPath of cssPaths) {
    const bytes = await fs.readFile(cssPath), text = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const faces = [...text.matchAll(/@font-face\s*\{([^{}]*)\}/gi)];
    assert.equal(faces.length, [...text.matchAll(/@font-face\b/gi)].length, 'Unsupported font-face syntax: ' + cssPath);
    css.push({path: path.relative(root, cssPath), bytes: bytes.length, sha256: sha(bytes), fontFaces: faces.length});
    for (const [, body] of faces) {
      fontFaces++;
      const sources = declarations(body).filter(value => /^\s*src\s*:/i.test(value));
      assert(sources.length > 0, 'Font face has no source: ' + cssPath);
      for (const declaration of sources) {
        const source = declaration.replace(/^\s*src\s*:/i, '');
        const urls = [...source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^()\s"']+))\s*\)/gi)];
        const remainder = source.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^()\s"']+))\s*\)/gi, '')
          .replace(/\b(?:format|tech)\([^()]*\)/gi, '').replace(/[,\s]/g, '');
        assert(urls.length > 0 && remainder === '', 'Font sources must use local file URLs only: ' + cssPath);
        for (const match of urls) {
          const url = match[1] ?? match[2] ?? match[3];
          const decoded = decodeURIComponent(url);
          assert(decoded && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded) && !/[\\?#\x00-\x1f\x7f]/.test(decoded), 'Font URL must be a relative local file: ' + url.slice(0, 160));
          assert(/\.(?:woff2?|ttf|otf|eot)$/i.test(decoded), 'Unexpected font extension: ' + url);
          const target = path.resolve(path.dirname(cssPath), decoded);
          assert(inside(root, target), 'Font URL escapes renderer directory: ' + url);
          let physical;
          try {physical = await fs.realpath(target);} catch (error) {throw new Error('Missing local font file: ' + url, {cause: error});}
          assert(physical === target && inside(root, physical), 'Font must be a physical local file: ' + url);
          assert((await fs.stat(physical)).isFile(), 'Font URL is not a file: ' + url);
          const fontBytes = await fs.readFile(physical);
          assert(fontBytes.length > 0, 'Empty local font file: ' + url);
          const relative = path.relative(root, physical);
          fonts.set(relative, {path: relative, bytes: fontBytes.length, sha256: sha(fontBytes)});
          references++;
        }
      }
    }
  }
  assert(fontFaces > 0 && fonts.size > 0, 'No bundled font-face assets found');
  return {status: 'passed', rendererDist: root, fontFaces, references, css, fonts: [...fonts.values()].sort((a, b) => a.path.localeCompare(b.path)), scope: 'Built CSS font references and physical file bytes only; native CSP/loading/decoding require native acceptance.'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--renderer-dist', 'Usage: node font-assets.mjs --renderer-dist /absolute/path/to/dist');
    console.log(JSON.stringify(await verifyFontAssets(process.argv[3]), null, 2));
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
