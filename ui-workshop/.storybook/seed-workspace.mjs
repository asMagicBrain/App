import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceRoot} from './workspace-paths.mjs';
import {BUILTIN_REPOSITORIES} from '../../packages/desktop-host/src/repository-import/index.mjs';

// These familiar story identifiers contain only public synthetic content. Never
// copy a developer workspace or replenish an existing repository's files.
export function seedWorkspace(base = workspaceRoot) {
  fs.mkdirSync(base, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(base) !== path.resolve(base)) throw Error('Synthetic workspace requires a physical directory.');
  const created = [];
  for (const {name} of BUILTIN_REPOSITORIES) {
    const directory = path.join(base, name);
    try {fs.mkdirSync(directory, {mode: 0o700});}
    catch (error) {if (error.code === 'EEXIST') continue; throw error;}
    fs.mkdirSync(path.join(directory, 'docs'), {mode: 0o700});
    fs.writeFileSync(path.join(directory, 'README.md'), `# ${name}\n\nThis is synthetic asMagicBrain Storybook sample content.\n\nUse Preview, Code, and Edit to try local writing. Your changes stay in this test workspace.\n\n## Notes\n\nSee [Sample note](docs/sample-note.md).\n`, {flag: 'wx', mode: 0o600});
    fs.writeFileSync(path.join(directory, 'docs/sample-note.md'), '# Sample note\n\nA small example for folders, Markdown headings, and local edits.\n\n## Next steps\n\n- Write a note.\n- Save it locally.\n', {flag: 'wx', mode: 0o600});
    created.push(name);
  }
  return created;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify({workspaceRoot, created: seedWorkspace()}, null, 2));
}
