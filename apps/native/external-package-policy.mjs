import fs from 'node:fs';
import path from 'node:path';
import {requireUnencryptedCookieStore} from './package-support.mjs';

export const externalPolicy = Object.freeze({schemaVersion: 1, name: 'macos-external-v1', platform: 'darwin', arch: 'arm64', fuseBefore: '101100011', fuseAfter: '100000011'});
export const externalFramework = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
export const externalGit = 'Contents/Resources/app/apps/native/dist-host/git';
const jit = 'com.apple.security.cs.allow-jit';
const framework = name => `Contents/Frameworks/${name}.framework`;
const file = (executable, role, type = 2) => ({path: executable, executable, kind: 'file', role, hardenedRuntime: type === 2, entitlements: [], type});
const bundle = (name, executable, role, type = 2) => ({path: name, executable, kind: 'bundle', role, hardenedRuntime: type === 2, entitlements: role === 'main' || role === 'electron-helper' ? [jit] : [], type});
const layout = [
  bundle('.', 'Contents/MacOS/asMagicBrain', 'main'),
  ...['', ' (GPU)', ' (Plugin)', ' (Renderer)'].map(suffix => {
    const name = `asMagicBrain Helper${suffix}`, root = `Contents/Frameworks/${name}.app`;
    return bundle(root, `${root}/Contents/MacOS/${name}`, 'electron-helper');
  }),
  ...['Electron Framework', 'Mantle', 'ReactiveObjC', 'Squirrel'].map(name => bundle(framework(name), `${framework(name)}/Versions/A/${name}`, 'framework', 6)),
  ...['libffmpeg.dylib', 'libvk_swiftshader.dylib'].map(name => file(`${framework('Electron Framework')}/Versions/A/Libraries/${name}`, 'library', 6)),
  file(`${framework('Electron Framework')}/Versions/A/Helpers/chrome_crashpad_handler`, 'crash-handler'),
  file(`${framework('Squirrel')}/Versions/A/Resources/ShipIt`, 'updater-helper'),
  file('Contents/Resources/app/apps/native/dist-host/rg', 'search'),
  ...['bin/git', 'bin/scalar', 'libexec/git-core/git', 'libexec/git-core/git-daemon', 'libexec/git-core/git-http-backend', 'libexec/git-core/git-http-fetch', 'libexec/git-core/git-http-push', 'libexec/git-core/git-imap-send', 'libexec/git-core/git-remote-http', 'libexec/git-core/git-sh-i18n--envsubst', 'libexec/git-core/git-shell'].map(name => file(`${externalGit}/${name}`, 'git')),
];
// The policy is intentionally finite. A dependency update that adds native code
// requires a reviewed entry instead of silently receiving blanket entitlements.
export const externalCodeLayout = Object.freeze(layout.map(item => Object.freeze({...item, entitlements: Object.freeze(item.entitlements)})));
const fail = code => {throw Object.assign(new Error(code), {code});};

export function enumerateExternalCode(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail('EXTERNAL_BUNDLE_PHYSICAL');
  const expected = new Map(layout.map(item => [item.executable, item])), found = new Set();
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name), stat = fs.lstatSync(filename), relative = path.relative(root, filename).split(path.sep).join('/');
      if (stat.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(filename)) || !fs.realpathSync(filename).startsWith(root + path.sep)) fail('EXTERNAL_CODE_LINK');
      } else if (stat.isDirectory()) walk(filename);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('EXTERNAL_CODE_HARDLINK');
        const header = Buffer.alloc(32), fd = fs.openSync(filename, 'r');
        try {fs.readSync(fd, header, 0, 32, 0);} finally {fs.closeSync(fd);}
        const magic = header.subarray(0, 4).toString('hex');
        const native = ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
        const target = expected.get(relative);
        if (!native && !target) continue;
        if (!target) fail('EXTERNAL_UNEXPECTED_MACHO');
        if (magic !== 'cffaedfe' || header.readUInt32LE(4) !== 0x0100000c || header.readUInt32LE(12) !== target.type || !(stat.mode & 0o111)) fail('EXTERNAL_CODE_FORMAT');
        found.add(relative);
      } else fail('EXTERNAL_CODE_SPECIAL');
    }
  }
  walk(root);
  if (found.size !== layout.length) fail('EXTERNAL_CODE_MISSING');
  return layout.map(({type, ...item}) => ({...item, entitlements: [...item.entitlements]})).sort((a, b) => {
    const depth = name => name === '.' ? 0 : name.split('/').length;
    return depth(b.path) - depth(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
}

/** Only the owned output copy may be passed here. The caller first compares its
 * complete inventory with the immutable input. Cookie encryption never changes. */
export function applyExternalFuses(root) {
  const filename = path.join(root, externalFramework), bytes = fs.readFileSync(filename);
  const before = requireUnencryptedCookieStore(bytes);
  if (before.wire !== externalPolicy.fuseBefore) fail('EXTERNAL_INPUT_FUSES');
  const start = bytes.indexOf(Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')) + 34;
  // Sentinel is 32 bytes, followed by version and wire length.
  bytes[start + 2] = 0x30; bytes[start + 3] = 0x30;
  const after = requireUnencryptedCookieStore(bytes);
  if (after.wire !== externalPolicy.fuseAfter) fail('EXTERNAL_OUTPUT_FUSES');
  fs.writeFileSync(filename, bytes);
  return {before, after};
}
