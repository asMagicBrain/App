import fs from 'node:fs';
import {resolveDevelopmentTestRoot} from './development-paths.mjs';
import path from 'node:path';
import {resolveBuildConfiguration} from './build-channel.mjs';
import {packagedTestRoot, nativeProfilePaths} from './profile-paths.mjs';

const fail = (code, message) => {throw Object.assign(Error(message), {code});};

function existingTestRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.dirname(path.resolve(value)) === path.resolve(value)) {
    fail('INVALID_TEST_ROOT', 'Use an absolute, dedicated directory for isolated validation.');
  }
  const resolved = path.resolve(value);
  try {
    if (!fs.lstatSync(resolved).isDirectory() || fs.realpathSync(resolved) !== resolved) throw Error();
  } catch {fail('DEVELOPMENT_DATA_UNAVAILABLE', 'The designated development or test directory is unavailable.');}
  return resolved;
}

/** Resolve only. Runtime integrity and ownership admission happen before writes. */
export function resolveNativeStartup({args, packaged, metadata, sourceTestRoot, home, appData, platform = process.platform}) {
  const configuration = resolveBuildConfiguration({args, packaged, metadata});
  const roots = args.filter(arg => arg === '--test-root' || arg.startsWith('--test-root='));
  const tests = args.filter(arg => arg === '--test-user-home' || arg === '--test-data-root' || arg.startsWith('--test-user-home=') || arg.startsWith('--test-data-root='));
  if (roots.length > 1 || tests.length > 1 || roots.includes('--test-root') || tests.some(arg => !arg.includes('='))) {
    fail('INVALID_STARTUP_OPTIONS', 'Use one explicit test root and one isolated test home.');
  }
  let testRoot;
  if (packaged && configuration.channel === 'preview') {
    if (Object.hasOwn(metadata, 'testRoot')) fail('INVALID_PACKAGE', 'This preview contains development-only configuration.');
    if (Boolean(roots.length) !== Boolean(tests.length)) fail('INVALID_STARTUP_OPTIONS', 'Isolated preview validation requires both --test-root and --test-user-home.');
    testRoot = roots.length ? existingTestRoot(roots[0].slice('--test-root='.length)) : undefined;
  } else {
    if (roots.length) fail('INVALID_STARTUP_OPTIONS', 'Development uses its recorded test directory.');
    testRoot = packaged ? existingTestRoot(packagedTestRoot(metadata)) : resolveDevelopmentTestRoot(sourceTestRoot);
  }
  return {configuration, testRoot, paths: nativeProfilePaths({args, testRoot, packaged, home, appData, platform, channel: configuration.channel})};
}

/** Short user-facing recovery information; never expose a stack or credentials. */
export function startupFailureMessage(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'STARTUP_FAILED';
  const advice = {
    EACCES: 'Check that you can read and write your asMagicBrain workspace and application-data folders.',
    EPERM: 'Check your system permissions for the asMagicBrain workspace and application-data folders.',
    EROFS: 'The storage location is read-only. Use a writable local drive.',
    ENOSPC: 'Free some space on the drive, then open asMagicBrain again.',
    EDQUOT: 'The storage quota is full. Free some space, then open asMagicBrain again.',
    ASMB_RUNTIME_TEMP: 'Linux could not create a short private temporary directory. Check that XDG_RUNTIME_DIR is a short physical directory owned by your user with mode 0700, or leave it unset to use the protected system /tmp directory.',
    DEVELOPMENT_DATA_UNAVAILABLE: 'Reconnect the development drive, then open the development application again.',
    RECOVERY_REQUIRED: 'Local storage needs recovery. Keep the workspace and its state folder together and retain a backup before making changes.',
    NATIVE_INSTANCE_ACTIVE: 'Close the other asMagicBrain instance before opening this workspace.',
    PROFILE_IN_USE: 'Close the other asMagicBrain instance before opening this workspace.',
    GIT_RUNTIME_MISSING: 'The application is missing its bundled Git files. Replace the application with a complete copy of the same or a newer version.',
    GIT_RUNTIME_CORRUPT: 'The bundled Git files are incomplete or changed. Replace the application with a complete copy of the same or a newer version.',
    GIT_RUNTIME_CHANGED: 'The bundled Git files changed while the application was open. Close it and replace the application with a complete copy.',
    GIT_RUNTIME_UNSUPPORTED_PLATFORM: 'This application contains a Git runtime for a different operating system or processor. Use the matching application build.',
  };
  const detail = advice[code] ?? (typeof error?.message === 'string' && error.message.length <= 400 && !/[\r\n]/.test(error.message)
    ? error.message : 'The application could not open its local workspace. Keep your files in place and contact support with this error code.');
  return `${detail}\n\nExisting files and recovery records are retained.\nError: ${code}`;
}
