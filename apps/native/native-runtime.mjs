import fs from 'node:fs';

/** Only reviewed targets may select runtime inputs. No environment override or
 * fallback can substitute another architecture's binaries. */
export function nativeTarget({platform = process.platform, arch = process.arch} = {}) {
  const target = `${platform}-${arch}`;
  if (!['darwin-arm64', 'linux-x64'].includes(target)) throw Error(`Unsupported native runtime target: ${target}.`);
  return {platform, arch, target};
}

export function runtimeSpec(options = {}) {
  const {target} = nativeTarget(options);
  return Object.freeze(JSON.parse(fs.readFileSync(new URL(target === 'darwin-arm64' ? './runtime.json' : './runtime-linux-x64.json', import.meta.url), 'utf8')));
}

export function gitRuntimePaths(options = {}) {
  const {target} = nativeTarget(options);
  return {
    spec: new URL(target === 'darwin-arm64' ? './git-runtime.json' : './git-runtime-linux-x64.json', import.meta.url),
    selection: new URL(target === 'darwin-arm64' ? './git-runtime-selection.json' : './git-runtime-selection-linux-x64.json', import.meta.url),
  };
}

export function selectGitRuntimeSpec(options = {}) {
  return Object.freeze(JSON.parse(fs.readFileSync(gitRuntimePaths(options).spec, 'utf8')));
}
