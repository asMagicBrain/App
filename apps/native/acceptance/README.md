# Test the native app

Native acceptance runs actual Electron workflows with disposable data. Use it alongside source tests and package integrity checks. Start with [development setup](../../../contributing/development.md).

## Prepare and bind the app

On the matching macOS arm64 or Ubuntu 24.04 x64 host:

```sh
npm ci
npm run native:runtime
npm run native:git-runtime
npm run native:build
npm run native:test
```

The harness uses repository-installed `playwright-core`. Fixture tools `/usr/bin/git` and `/usr/bin/zip` are separate from packaged app-owned Git.

Set `ASMB_TEST_ROOT` to an absolute physical directory outside the checkout. Each campaign needs fresh run/profile data; use `ASMB_ACCEPTANCE_RUN_ROOT` where supported. Never reuse personal repositories or account sessions.

Bind package acceptance to its exact executable:

```sh
ASMB_PACKAGED_EXECUTABLE=/absolute/path/asMagicBrain.app/Contents/MacOS/asMagicBrain node apps/native/acceptance/integrated-outline.mjs --run-isolated
```

Use a desktop session, run pointer/keyboard campaigns serially, and close through the normal app UI/menu. Verify process exit and released profile locks. Forced termination does not pass normal-close acceptance.

## Choose a campaign

| Driver | Scope |
| --- | --- |
| `npm run native:acceptance` | macOS operations/import modes; Linux operations, docs, and desktop workflows. |
| `sidebar.mjs` | Sidebar, rename, and editor preservation. |
| `drag-drop.mjs` | Pointer moves, copies, targets, cancellation, and bytes. |
| `navigation-strip.mjs` | Current navigation and absence of retired V3. |
| `all-repositories.mjs` | Catalog, filters/sort/density, create/import. |
| `search-explorer-outline.mjs` | Search, picker, work-directory explorer, outline. |
| `repository-management.mjs` | Menus, duplicate, Trash/restore, retained state. |
| `integrated-outline.mjs` | Same-window outline, focus, geometry, drafts, restart. |
| `public-docs.mjs` | Docs ordering, read-only guards, links, duplication, normal restart. |
| `storage-recovery.mjs` | Packaged recovery confirmation, verified managed-data backup, namespace migration, preservation, and restart. |
| `linux-desktop.mjs` | Installed Linux shortcuts/search/outline, choosers, reveal, URL dispatch, restart. |
| `session-accounts.mjs` | Session account lifecycle with identified fixtures. |

Inspect each driver's arguments and assertions before running it. Some older drivers target retired UI and do not define current acceptance.

For bundled docs:

```sh
ASMB_PACKAGED_EXECUTABLE=/absolute/path/asMagicBrain.app/Contents/MacOS/asMagicBrain node apps/native/acceptance/public-docs.mjs --run-isolated
```

This stays offline with synthetic repositories, isolated development data or a preview test home, and retained run output.

### Packaged storage recovery

Run the recovery campaign on macOS arm64 or Ubuntu 24.04 x64 in an actual desktop session. It creates a fresh preview test home under `ASMB_TEST_ROOT`; never point it at personal data. Bind it to the reviewed package and manifest:

```sh
export ASMB_TEST_ROOT=/absolute/path/asMagicBrain-Test
export ASMB_ACCEPTANCE_RUN_ROOT="$ASMB_TEST_ROOT/runs/storage-recovery"
export ASMB_PACKAGED_EXECUTABLE=/absolute/path/to/the/packaged/executable
# Required on Linux; macOS otherwise uses package-manifest.json beside the app.
export ASMB_PACKAGE_MANIFEST=/absolute/path/package-manifest.json
node apps/native/acceptance/storage-recovery.mjs --run-isolated
```

The runner pauses for the real native recovery dialog. Observe it and choose **Back Up and Restore Access**; automation does not approve the dialog. The packaged app then verifies the backup, preserves the original source, Git, private drafts, app state, inodes and modes, exercises Save/Create through the shipped preload bridge, restarts without another prompt, and closes normally. Retain the run receipt, screenshots, package pins, backup receipt, renderer errors and close events.

This campaign simulates only a prior device-number namespace by recording a different number; raw filesystem statistics are unchanged. It does not simulate a reboot, storage driver, physical volume change or failing disk. Qualification on an affected physical Mac is separate evidence and must identify the actual machine, filesystem and volume behavior rather than inheriting the simulated result.

## Installed Ubuntu checks

Install the reviewed [preview package](../PACKAGING.md#ubuntu-2404-x64-packages). Run as the ordinary Ubuntu x64 desktop user with a fresh test home, the installed executable, and preview metadata. Keep sandboxing and its exact-path AppArmor policy enabled. The driver uses renderer CDP, leaving Node inspection fuses unchanged, and checks actual seccomp/no-new-privileges state.

After other app processes in the session have closed:

```sh
export ASMB_TEST_ROOT=/absolute/path/asMagicBrain-Test
export ASMB_ACCEPTANCE_RUN_ROOT="$ASMB_TEST_ROOT/runs/linux-native"
export ASMB_LINUX_NATIVE_INPUT=operator
export ASMB_PACKAGED_EXECUTABLE=/opt/asmagicbrain-preview/asmagicbrain
export ASMB_LINUX_OZONE=x11
node apps/native/acceptance/operations.mjs
node apps/native/acceptance/public-docs.mjs --run-isolated
node apps/native/acceptance/linux-desktop.mjs --run-isolated
```

With the same environment, `npm run native:acceptance` runs those three campaigns in sequence and stops at the first failure.

### Desktop and native input

Provide X11 `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`; an isolated VM may use Xvfb/Openbox. Native chooser/file-manager checks need `xdotool`, `xwininfo`, `xclip`, ImageMagick, and Thunar.

With `ASMB_LINUX_NATIVE_INPUT=operator`, the runner opens real Files/Folders choosers, prints fixture/evidence paths, and waits up to ten minutes. Select the actual file/folder row and click Open, retaining a full-desktop capture. The runner checks bytes, empty directories, and unchanged originals. Cancel uses measured dialog geometry; Thunar's copied `text/uri-list` confirms the revealed file. Report this as operator-assisted acceptance. It does not qualify the GTK location-field shortcut.

### External-link dispatch

Create a guest-only logging URL receiver named `asmb-qa-url-receiver.desktop` and select that exact handler for `x-scheme-handler/https`. Set `ASMB_LINUX_URL_DISPATCH_LOG` to its existing JSON-lines log, with each URL recorded as a JSON string value. Smoke-test the receiver locally; it must not open a remote browser. The campaign checks handler identity before clicking its unique synthetic `example.invalid` link.

### Optional Wayland run

Supply `WAYLAND_DISPLAY` and session environment, unset `DISPLAY`, and run the supplemental driver with `ASMB_LINUX_OZONE=wayland`. Its five renderer/restart workflows run; five native OS workflows are explicitly skipped because the input driver is X11-only. Report those limits. Do not run X11 and Wayland campaigns concurrently against one profile/session. Other macOS drivers need individual porting before Linux use.

## Keep evidence accurate

Retain assertions, package/source/driver pins, screenshots/video, geometry, errors, network observations, process identities, and close outcomes in the run directory. Use synthetic text and authors; distinguish fixture setup from actions exercised through UI/IPC. Preserve failed runs.

Test a candidate, then the unchanged exact final package. Check both appearance and saved bytes/persistence. Candidate, Storybook, mocked runner, or screenshot results alone do not qualify a final native artifact.

GitHub acquisition/update drivers can contact public GitHub; account drivers can start provider flows. Run them only within authorized network/account scope. Label synthetic providers and lifecycle interception; they do not establish live account eligibility.

The macOS Playwright launcher needs inspection capabilities disabled in external releases. Use a compatible driver for the actual signed app; never re-enable production debug fuses or weaken entitlements for a harness. Linux renderer CDP leaves shipped Node inspection fuses intact. See [packaging](../PACKAGING.md).
