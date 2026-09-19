# Native application

Electron hosts the shared React interface with a sandboxed renderer and a narrow preload bridge. Main-process services own files, Git, accounts, and window lifecycle. The app loads from disk without a Storybook server.

## Build and run

Follow [development setup](../../contributing/development.md) for macOS arm64 or Ubuntu 24.04 x64:

```sh
npm ci
npm run native:runtime
npm run native:git-runtime
npm run native:build
npm run native:test
```

Preparation downloads pinned inputs. Builds use verified local inputs and stop if they are missing or changed. Set `ASMB_TEST_ROOT` to an absolute physical directory outside the checkout for generated data and isolated profiles.

On macOS, `npm run native` starts the source preview. On Ubuntu, build a `.deb` candidate with `npm run native:package -- --candidate --channel=preview`; install it through APT with its exact-path AppArmor policy. Source launches need their own reviewed policy. Keep sandboxing enabled and quit normally so admitted work drains.

## Implementation guides

- [Architecture and source map](../../contributing/architecture.md)
- [Account configuration](../../contributing/development.md#configure-optional-accounts) and [GitHub connection](GITHUB-SIGNIN.md)
- [GitHub comparison and Apply](GITHUB-UPDATES.md)
- [Sidebar and rename](SIDEBAR-AND-RENAME.md), [layout](V3-LAYOUT.md), and [drag and drop](V5-DRAG-AND-DROP.md)
- [Native acceptance](acceptance/README.md) and [packaging](PACKAGING.md)

Save, private drafts, and commits remain separate. Imported content cannot run hooks or project code. Packaged Git has no system fallback; account tokens remain in memory until quit. The [user guide](../../docs/README.md) describes current behavior and platform limits.
