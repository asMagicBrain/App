import {appRoot, resolveDevelopmentTestRoot} from '../apps/native/development-paths.mjs';
export {appRoot, resolveDevelopmentTestRoot as resolveTestRoot};
export const testRoot = resolveDevelopmentTestRoot();
