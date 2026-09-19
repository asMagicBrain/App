# Prepare a release

[Contributor guides](README.md)

## Version and source identity

`apps/native/release.json` owns the native version and increasing build number. Continue patch increments in the 0.2 line until a maintainer changes that policy. Final packages require a clean exact commit and immutable `native-v<version>` tag. Preserve previous packages, checksums, manifests, notices, and acceptance records.

An authorized same-version metadata correction advances the build and sets `metadataRevision`, producing `native-v<version>-metadata.<revision>`. Preserve the original tag and artifacts. Package into new output; existing output guards still apply. A same-version Debian correction needs explicit reinstallation.

Root `package.json` owns author, affiliation, homepage, and copyright. Both packages retain these credits. Package attribution is separate from a user's Git author and a verified signing identity.

## Channels

| Channel | Behavior |
| --- | --- |
| Development | Shared UI with grey deferred controls, Hide unavailable, and inert Ask agent; isolated test data/profile. |
| Preview | Implemented-only UI; normal managed user-home data and a separate preview profile. |

Working controls may be disabled by context. Both channels use the same React components. Check [current platform limits](../docs/platform-and-limits.md) before describing support.

## Package and verify

Prepare pinned inputs on the matching host, run relevant checks, and test a candidate:

```sh
npm run native:runtime
npm run native:git-runtime
npm run native:package -- --candidate --channel=preview
```

After source is clean and tagged, produce the final development or preview package:

```sh
npm run native:package
npm run native:package -- --channel=preview
```

[Native packaging](../apps/native/PACKAGING.md) documents outputs, Linux installation, inventories, and account variants. Packaging does not install or upload the result. Run [native acceptance](../apps/native/acceptance/README.md) on the exact final artifact; a candidate result does not automatically cover it.

A release needs:

1. Source/host/UI checks, pinned runtime and license inventories, and exact source/tag identity.
2. Actual packaged launch, local workflows, data preservation, and normal close/restart with isolated data.
3. Platform-specific installation and distribution checks for the claims made in its release notes.

On Ubuntu, verify package installation, sandboxed launch, native dialogs, upgrade/removal preservation, and installed runtime hashes. Record OS, desktop, X11/Wayland, and emulated or physical hardware. Checksums do not provide a signing identity.

On macOS, local ad hoc acceptance is distinct from Developer ID signing, notarization, and independent downloaded/quarantined Gatekeeper acceptance. Follow [macOS signing](macos-signing.md) for that separate workflow; never weaken production security to pass a harness.

## Source export

From a clean matching release/tag, create an export in a new directory:

```sh
node tools/export-source.mjs --output=/absolute/new/directory
```

It contains tracked source, docs, licenses, and checksums, without Git history, dependencies, profiles, or application bundles. Inspect and scan the exact export before publication.

When preparing a new repository without prior history, supply the independently reviewed manifest hash:

```sh
node tools/prepare-public-repository.mjs \
  --export=/absolute/reviewed-export \
  --manifest-sha256=REVIEWED_64_HEX_SHA256 \
  --output=/absolute/new/publication
```

Only the resulting `repository/` is the publication candidate. It has one root commit, the release tag, no remote, and the reviewed source tree. Keep the outer `publication-manifest.json` and checksums with controlled evidence: they bind original and new commit identities. Do not publish that manifest without reviewing its contents.

## Publish and describe accurately

Release source and downloads live at [asMagicBrain/App](https://github.com/asMagicBrain/App). Remote uploads and visibility changes require authorization.

Build downloadable applications from the commit identified in their release. Identical file trees do not make an older package a build of a new commit. Publishing source, uploading a binary, signing/notarizing it, and qualifying its download are separate actions.

Keep release notes brief: what changed, available files, installation links, and relevant limitations. Put detailed build receipts and internal history in controlled evidence outside the public source and user-doc payload. Verify uploaded bytes against checksums and source identity before announcing availability.
