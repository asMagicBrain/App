import fs from 'node:fs';
import path from 'node:path';
import {buildConfiguration} from './build-channel.mjs';
import {inventory, requireUnencryptedCookieStore} from './package-support.mjs';
import {packageAttribution} from './product-attribution.mjs';

// Fixed installation paths also bind Ubuntu's per-application namespace grant.
// Do not widen these to user-writable paths or disable the Chromium sandbox.
export function linuxPackageIdentity(channel) {
  buildConfiguration(channel);
  const name = channel === 'preview' ? 'asmagicbrain-preview' : 'asmagicbrain';
  return Object.freeze({name, installRoot: `/opt/${name}`, executable: `/opt/${name}/asmagicbrain`,
    desktopId: `${name}.desktop`, profile: name, productName: channel === 'preview' ? 'asMagicBrain Preview' : 'asMagicBrain'});
}

export const linuxDependencies = Object.freeze([
  'apparmor (>= 4.0)', 'libc6 (>= 2.39)', 'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64',
  'libatspi2.0-0t64', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libexpat1', 'libgbm1',
  'libglib2.0-0t64', 'libgtk-3-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1',
  'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
  'ca-certificates', 'xdg-utils', 'zlib1g', 'libcurl4t64', 'libudev1', 'libgcc-s1',
]);

export function linuxControl({channel, version, installedSize, attribution}) {
  const identity = linuxPackageIdentity(channel);
  const credits = packageAttribution(attribution);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(installedSize) || installedSize < 1) throw Error('Invalid Debian package version or size.');
  return `Package: ${identity.name}\nVersion: ${version}\nSection: editors\nPriority: optional\nArchitecture: amd64\nMaintainer: ${credits.author.name} <${credits.author.email}>\nHomepage: ${credits.homepage}\nInstalled-Size: ${installedSize}\nDepends: ${linuxDependencies.join(', ')}\nDescription: Offline Markdown workspace with local Git\n Read, edit, organize and search local repositories with asMagicBrain.\n Local files and Git work without an online account.\n`;
}

export function linuxDesktopEntry(channel) {
  const identity = linuxPackageIdentity(channel);
  // No %U/%F: file associations require an explicit native open-file flow.
  return `[Desktop Entry]\nType=Application\nName=${identity.productName}\nComment=Local Markdown workspaces and Git\nExec=${identity.executable}\nIcon=${identity.name}\nTerminal=false\nCategories=Office;TextEditor;\nStartupWMClass=${identity.name}\n`;
}

export function linuxAppArmorProfile(channel) {
  const identity = linuxPackageIdentity(channel);
  return `# Ubuntu 24.04: grant user namespaces only to this root-owned application.\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile ${identity.profile} ${identity.executable} flags=(unconfined) {\n  userns,\n  include if exists <local/${identity.profile}>\n}\n`;
}

export function linuxMaintainerScripts(channel) {
  const identity = linuxPackageIdentity(channel);
  return {
    postinst: `#!/bin/sh\nset -eu\nif [ "$1" = configure ]; then\n  if [ -x /sbin/apparmor_parser ] && [ -d /sys/module/apparmor ]; then\n    /sbin/apparmor_parser -r /etc/apparmor.d/${identity.profile}\n  fi\n  if command -v update-desktop-database >/dev/null 2>&1; then\n    update-desktop-database /usr/share/applications\n  fi\nfi\n`,
    // Never remove workspaces, profiles, drafts, Git history, or account data.
    postrm: `#!/bin/sh\nset -eu\ncase "$1" in\n  remove|purge)\n    if [ -x /sbin/apparmor_parser ] && [ -d /sys/module/apparmor ]; then\n      printf '%s\\n' 'profile ${identity.profile} {}' | /sbin/apparmor_parser -R || true\n    fi\n    if command -v update-desktop-database >/dev/null 2>&1; then\n      update-desktop-database /usr/share/applications\n    fi\n    ;;\nesac\n`,
  };
}

export function applyLinuxFuses(executable) {
  const bytes = fs.readFileSync(executable), before = requireUnencryptedCookieStore(bytes);
  if (before.wire !== '101100011') throw Error('Unknown Linux Electron input fuse policy.');
  const start = bytes.indexOf(Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')) + 34;
  bytes[start + 2] = 0x30; // Disable NODE_OPTIONS; retain RunAsNode for fixed workers.
  bytes[start + 3] = 0x30; // Disable Node CLI inspection in shipped applications.
  const after = requireUnencryptedCookieStore(bytes);
  if (after.wire !== '100000011') throw Error('Linux Electron fuse update failed.');
  fs.writeFileSync(executable, bytes);
  return {before, after};
}

export function assertLinuxPackageModes(root) {
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) continue;
      if (stat.mode & 0o6022) throw Error(`Unsafe Linux package mode: ${path.relative(root, filename)}`);
      if (stat.isDirectory()) walk(filename);
      else if (!stat.isFile()) throw Error('Special Linux package entry.');
    }
  }
  walk(root);
}

/** Move only an owned package staging tree into a new evidence directory.
 * ASMB_TEST_ROOT may be on another filesystem. Copy/verification failures keep
 * the source and any partial destination for inspection; only a verified copy
 * permits removing the original staging tree.
 */
export function moveLinuxPackageEvidence(source, destination, {rename = fs.renameSync, copy = fs.cpSync} = {}) {
  if (![source, destination].every(value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value) ||
      path.dirname(source) === source || source === destination || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) {
    throw Error('Separate absolute package evidence directories are required.');
  }
  const original = fs.lstatSync(source);
  if (!original.isDirectory() || original.isSymbolicLink() || fs.realpathSync(source) !== source ||
      fs.realpathSync(path.dirname(destination)) !== path.dirname(destination)) throw Error('Physical package evidence directories are required.');
  if (fs.lstatSync(destination, {throwIfNoEntry: false})) throw Error('Package evidence destination already exists; preserve it.');
  try {rename(source, destination); return;} catch (error) {if (error.code !== 'EXDEV') throw error;}
  const entries = inventory(source, {internalLinks: true}), expected = JSON.stringify(entries);
  copy(source, destination, {recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false});
  // fs.cp creates directories using the receiver's umask (Ubuntu commonly uses
  // 0002). Admit the exact copied types/bytes/links before restoring source modes.
  const withoutOrdinaryModes = items => items.map(item => {
    if (item.type === 'symlink') return item;
    const {mode, ...rest} = item; return rest;
  });
  if (JSON.stringify(withoutOrdinaryModes(inventory(destination, {internalLinks: true}))) !== JSON.stringify(withoutOrdinaryModes(entries))) {
    throw Error('Package evidence copy differs; both directories are retained.');
  }
  for (const entry of entries.filter(item => item.type !== 'symlink')) {
    const filename = path.join(destination, entry.path);
    if (fs.realpathSync(filename) !== filename) throw Error('Copied package evidence path is not physical.');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (entry.type === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw Error('Copied package evidence type differs.');
      fs.fchmodSync(fd, entry.mode);
    } finally {fs.closeSync(fd);}
  }
  const current = fs.lstatSync(source);
  if (current.dev !== original.dev || current.ino !== original.ino ||
      JSON.stringify(inventory(destination, {internalLinks: true})) !== expected ||
      JSON.stringify(inventory(source, {internalLinks: true})) !== expected) throw Error('Package evidence copy differs; both directories are retained.');
  fs.rmSync(source, {recursive: true});
}
