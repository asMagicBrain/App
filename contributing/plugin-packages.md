# Local plugin packages

[Plugin contracts](plugins.md) · [Architecture](architecture.md) · [User guide](../docs/plugins.md)

Stage 4.5 introduces the offline `.asmbplugin` package and its host-owned storage lifecycle. This is an installation boundary for inert declarative resources. It is not a JavaScript loader, renderer extension point, marketplace, network updater or sandbox.

## Package layout

An `.asmbplugin` file is a bounded ZIP with this exact root layout:

```text
manifest.json
integrity.json
content/
  … declared resources …
```

The ZIP admission shared with repository import rejects absolute paths, traversal, links, special files, ambiguous portable spellings, overlapping records, unsupported compression and corrupt CRCs. Plugin admission additionally rejects omitted reserved members, root wrappers, undeclared files and executable extensions.

Version 1 accepts at most 16 MiB compressed, 64 MiB expanded, 16 MiB per member, 512 archive entries, 258 files and 256 declared resources. `manifest.json` is limited to 64 KiB and `integrity.json` to 512 KiB.

## Manifest schema 1

```json
{
  "format": "asMagicBrain-plugin",
  "schemaVersion": 1,
  "id": "org.example.course-templates",
  "name": "Course templates",
  "version": "1.0.0",
  "publisher": {
    "id": "org.example",
    "name": "Example Publisher",
    "website": "https://example.org"
  },
  "hostApi": {"min": 1, "max": 1},
  "execution": {"kind": "declarative"},
  "permissions": [],
  "resources": [
    {
      "id": "org.example.course-templates.starter",
      "type": "markdown-template",
      "path": "content/starter.md",
      "title": "Starter"
    }
  ],
  "signature": null
}
```

IDs use a reverse-domain-style lowercase form. Versions use three-part semantic versions without prerelease/build suffixes. Host API ranges are inclusive. Version 1 supports `markdown-template`, `text`, `data` and raster `image` resources. Every resource path must have one of the admitted text/data/raster extensions. Scripts, HTML, WebAssembly, native modules and executable files are refused.

`permissions` must be empty and `signature` must be `null` in schema 1. These fields make later evolution explicit; they do not imply permission grants or signature verification today. Package identity currently comes from its exact SHA-256 archive digest and the separately verified file inventory.

## Integrity schema 1

`integrity.json` lists every file except itself:

```json
{
  "schemaVersion": 1,
  "algorithm": "sha256",
  "files": [
    {"path": "manifest.json", "bytes": 600, "sha256": "<64 lowercase hexadecimal characters>"},
    {"path": "content/starter.md", "bytes": 10, "sha256": "<64 lowercase hexadecimal characters>"}
  ]
}
```

The host requires an exact one-to-one match between archive files, manifest resources and integrity entries. Inspection copies the input bytes before parsing and does not install, render or execute members.

## Private lifecycle

Installed archives live under the current application's private state:

```text
<data-root>/state/native/.asmb-plugin-packages/
```

They never enter a repository or Git history. Each installed version retains the exact `.asmbplugin` archive. A private append-only state chain records the current version, one rollback version, enabled state, request receipts and any pending operation.

Installation writes and flushes a private staging directory, records a durable intent, atomically renames the immutable archive into the installed namespace and records the terminal state. Restart completes a recognized interrupted install. Unknown identities or bytes produce `PLUGIN_PACKAGE_RECOVERY_REQUIRED` without adoption or replacement.

Enable/disable changes persisted package state. Ordinary packages remain inert and cannot activate code or modify documents. Upgrade retains the prior current archive for rollback. Rollback swaps verified current and prior identities. Uninstall atomically retires the plugin namespace before terminal state publication, then removes only the retired app-owned package bytes. Request IDs make install, rollback and uninstall retry-safe and prevent reuse with different intent.

## Host service boundary

The native host owns focused methods for inspection, listing, installation, enablement, rollback and uninstall. Stage 4.5C exposes only reviewed operations through the isolated preload bridge. The native picker reads and inspects the selected file, then returns a short-lived opaque review ticket with bounded metadata. No absolute storage path crosses into the renderer. Installation consumes that ticket once; close, reload, cancellation and expiry discard it.

Stage 4.5D binds the exact committed Pro Editor package id, version, archive digest and publisher to the separately reviewed first-party module already compiled into the application. Removing or disabling the package removes its contributions; changing any package byte breaks the binding. This is an application-owned allowlist, not a general loader. Arbitrary package code is never imported into the renderer through this declarative contract. asTeach remains independent Storybook work and will use the completed distribution foundation later.

The deterministic Pro package proof and builder are in [`packages/pro-editor-plugin`](../packages/pro-editor-plugin/). A changed source must produce a changed digest and a reviewed binding update.

## Verification

Run the focused lifecycle suite:

```sh
node --test apps/native/plugin-packages.test.mjs
```

It covers read-only inspection, installation, enablement, restart persistence, upgrade, rollback, uninstall, incompatible/corrupt/undeclared/executable packages and restart completion of interrupted install/uninstall operations. `npm run native:test` includes this suite.
