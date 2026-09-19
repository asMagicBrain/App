# Build and test from source

[Contributor guides](README.md)

## Set up

Use Node.js 24 or newer, npm, and Git. Native builds must run on their target: macOS arm64 with Apple command-line tools, or Ubuntu 24.04 x64 with the tools below.

From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run storybook
```

`npm ci` also installs locked UI-workshop dependencies. The build checks the SDK, renderer, and static Storybook. Storybook uses synthetic repositories; the packaged app does not need its server.

## Keep test data separate

Set `ASMB_TEST_ROOT` to an absolute physical directory outside the checkout, with neither directory inside the other. A standalone clone defaults to sibling `../asMagicBrain-Test`.

```sh
export ASMB_TEST_ROOT="$HOME/asMagicBrain-Test"
mkdir -p "$ASMB_TEST_ROOT"
```

Never use personal repositories or a symlink as the test root. Give each campaign a new run directory and preserve failures. Put any manually selected `TMPDIR` inside that run directory. Native tests manage their temporary directories there.

## Build the native app

On macOS arm64:

```sh
npm run native:runtime
npm run native:git-runtime
npm run native:build
npm run native:test
npm run native
```

Preparation downloads checksum-pinned Electron and Git inputs, including Git sources, build recipes, and licenses. Builds verify prepared inputs and stop if they are missing or changed. Runtime preparation preserves an existing extracted runtime instead of replacing it.

The source launcher uses an isolated development profile. Quit through the app so pending work drains. [Native acceptance](../apps/native/acceptance/README.md) uses repository-installed `playwright-core`, disposable data, and an actual desktop session.

On Ubuntu 24.04 x64 (`amd64`), install the build tools and bundled Git's system libraries, then prepare a candidate:

```sh
sudo apt install git tar unzip binutils dpkg libcurl4t64 zlib1g ca-certificates
npm run native:runtime
npm run native:git-runtime
npm run native:build
npm run native:test
npm run native:package -- --candidate --channel=preview
```

The candidate goes under the external test root. Follow [Ubuntu installation](../docs/getting-started.md#install-on-ubuntu) to install it; APT resolves its desktop dependencies. The installed app uses bundled Git and needs no Node.js or build tools.

Ubuntu's namespace restrictions require the package's exact-path AppArmor policy. Source launches from `.tooling` need a separately reviewed policy for that executable. Keep Chromium sandboxing and global namespace restrictions enabled. Bind acceptance results to the exact installed package and desktop environment; a successful build or CI run does not establish native behavior.

## Configure optional accounts

Accounts default to `ASMB_ACCOUNT_CONFIG=offline`. The [example configuration](../apps/native/account-config.example.json) contains only public registration fields:

```json
{
  "applicationAccount": {
    "origin": null,
    "publishableKey": null,
    "providers": {"github": false, "email": false}
  },
  "githubApp": {"clientId": null, "slug": null}
}
```

Select `official` or an absolute physical JSON file to build a registered variant:

```sh
ASMB_ACCOUNT_CONFIG=offline npm run native:build
ASMB_ACCOUNT_CONFIG=/absolute/path/public-account-config.json npm run native:build
```

Never include service-role keys, access tokens, client secrets, or private keys. The build validates and records this configuration; the renderer cannot override it at runtime. Registration does not grant account access. Enrollment, consent, and live provider tests need their own authorization. Local work remains available offline.

## Choose checks for the change

| Change | Checks |
| --- | --- |
| Markdown | Links, actual-renderer anchors, privacy patterns, and rendered reading. |
| Shared UI | Typecheck, focused tests, relevant Storybook states. |
| Filesystem or Git | Host tests for changed behavior, stale state, bounds, and recovery. |
| Native bridge or lifecycle | Native tests and actual Electron close/restart acceptance. |
| Packaging | Input/source pins, inventories, licenses, and exact-package acceptance. |

```sh
node tools/check-public-docs.mjs
```

This checks public Markdown and standalone user-doc links with the actual renderer. It complements source secret scanning; it is not a complete secret audit. Use synthetic content and author identities. Report skipped checks and simulated providers. See [architecture](architecture.md) before changing a boundary and [releases](releasing.md) before packaging.
