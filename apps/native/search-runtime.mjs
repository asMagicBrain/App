import {createHash} from 'node:crypto';
import {nativeTarget} from './native-runtime.mjs';
import {verifyLinuxElf} from './elf-runtime.mjs';

const pins = Object.freeze({
  'darwin-arm64': '6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1',
  'linux-x64': '193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21',
});
export function searchRuntimeSpec(options = {}) {
  const {platform, arch, target} = nativeTarget(options);
  return {schemaVersion: 1, package: '@vscode/ripgrep', version: '1.18.0', ripgrepVersion: '15.0.0', platform, arch, sha256: pins[target]};
}
export function verifySearchRuntimeBinary(bytes, options = {}) {
  const spec = searchRuntimeSpec(options);
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw Error('Unverified ripgrep platform or bytes.');
  if (spec.platform === 'linux') verifyLinuxElf(bytes, {interpreter: null, needed: []});
  return {...spec, bytes: bytes.length};
}
