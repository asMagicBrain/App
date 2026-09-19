import path from 'node:path';
import {pathToFileURL} from 'node:url';

// The lockfile supplies the default. The optional absolute override remains for
// existing local acceptance tooling; it is never used by the application.
const override = process.env.ASMB_PLAYWRIGHT_PATH ?? process.env.ASMB_PLAYWRIGHT;
if (override && !path.isAbsolute(override)) throw Error('A Playwright override must be an absolute module path.');
const runtime = await import(override ? pathToFileURL(override).href : 'playwright-core');
export const {_electron, chromium, firefox, webkit} = runtime;
