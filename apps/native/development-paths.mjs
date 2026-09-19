import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const appRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function resolveDevelopmentTestRoot(value = process.env.ASMB_TEST_ROOT, sourceRoot = appRoot) {
  if (value !== undefined && (!value || !path.isAbsolute(value))) throw Error('ASMB_TEST_ROOT must be an absolute path outside the source checkout.');
  // Preserve the existing multi-repository developer layout. Ordinary clones
  // use a writable sibling, including ~/asMagicBrain -> ~/asMagicBrain-Test.
  const historicalLayout = path.basename(sourceRoot) === 'asMagicBrain-App' && path.basename(path.dirname(sourceRoot)) === 'asMagicBrain-Latest';
  const root = path.resolve(value ?? path.join(sourceRoot, historicalLayout ? '../../asMagicBrain-Test' : '../asMagicBrain-Test'));
  const inside = (parent, child) => {const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));};
  if (inside(sourceRoot, root) || inside(root, sourceRoot)) throw Error('Test data and source checkout must have separate roots.');
  let ancestor = root;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, root)) !== root) throw Error('ASMB_TEST_ROOT requires a physical path without linked ancestors.');
  return root;
}
