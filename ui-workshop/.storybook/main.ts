import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StorybookConfig } from '@storybook/react-vite';

const workshop = fileURLToPath(new URL('../', import.meta.url));
const app = path.dirname(workshop.replace(/\/$/, ''));
const rootModules = path.join(app, 'node_modules');

const config: StorybookConfig = {
  stories: ['../src/RepositoryWorkspace.stories.tsx'],
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: { builder: { viteConfigPath: path.join(workshop, '.storybook/vite.config.mjs') } },
  },
  core: {
    disableTelemetry: true,
    enableCrashReports: false,
    disableWhatsNewNotifications: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
  },
  // TS7 is used for checking below, not the legacy compiler-API docgen plugin.
  typescript: { reactDocgen: false },
  async viteFinal(base) {
    const aliases = Array.isArray(base.resolve?.alias) ? base.resolve.alias
      : Object.entries(base.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement }));
    return {
      ...base,
      envDir: path.join(workshop, '.storybook/empty-env'),
      envPrefix: 'WORKSHOP_PUBLIC_',
      cacheDir: path.join(workshop, '.cache/vite'),
      resolve: {
        ...base.resolve,
        alias: [
          { find: /^react(?=\/|$)/, replacement: path.join(rootModules, 'react') },
          { find: /^react-dom(?=\/|$)/, replacement: path.join(rootModules, 'react-dom') },
          { find: /^@codemirror\//, replacement: path.join(rootModules, '@codemirror/') },
          { find: /^@lezer\//, replacement: path.join(rootModules, '@lezer/') },
          { find: /^markdown-it(?=\/|$)/, replacement: path.join(rootModules, 'markdown-it') },
          ...aliases,
        ],
        dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view'],
      },
      server: {
        ...base.server,
        host: '127.0.0.1',
        allowedHosts: ['127.0.0.1', 'localhost'],
        cors: { origin: /^http:\/\/(?:127\.0\.0\.1|localhost):6006$/ },
        fs: { strict: true, allow: [workshop, rootModules,
          path.join(app, 'apps/desktop/ui'), path.join(app, 'packages/source-foundation/src/content')] },
      },
    };
  },
};

export default config;
