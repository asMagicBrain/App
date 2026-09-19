import path from 'node:path';
import {testRoot} from '../../tools/development-paths.mjs';

// Host-selected developer data; URLs and renderer messages cannot choose roots.
export {testRoot};
export const workspaceRoot = path.join(testRoot, 'storybook', 'workspaces', 'asMagicBrain');
export const stateRoot = path.join(testRoot, 'storybook', 'state');
