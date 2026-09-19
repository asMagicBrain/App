# Sign and notarize a macOS release

[Contributor guides](README.md) · [Native packaging](../apps/native/PACKAGING.md)

## Prepare the signed copy

The following signing and notarization tools are macOS-only. `external-package.mjs` transforms an exact qualified preview into a **new** owned output. It does not change the original `.app`, source, or manifest. Source/tag/input pins, physical roots, code membership, runtime inventories, and attributes are checked before signing. Replace example placeholders with reviewed package values. Work/output directories must be physical, inside the selected external test root, mutually disjoint, and outside the immutable inputs/source. Create the scratch directory first; the output directory must not already exist.

### Read-only plan

The plan does not query signing credentials or create a signed output:

```sh
npm run native:package:external -- --plan \
  --bundle /absolute/releases/VERSION-preview/asMagicBrain.app \
  --input-manifest /absolute/releases/VERSION-preview/package-manifest.json \
  --input-manifest-sha256 REVIEWED_64_HEX_SHA256 \
  --source-root /absolute/source-checkout \
  --source-commit REVIEWED_40_HEX_COMMIT \
  --source-tag native-vVERSION --version VERSION --build-number BUILD \
  --work-directory /absolute/test-root/runs/external/scratch
```

Use the manifest's exact version/build/commit and independently verified SHA-256. Do not replace a failed pin with whichever file happens to exist.

### Authorized signing

After actual Apple Developer membership/certificate provisioning and review, use the same admitted input arguments with `--sign`, adding:

```text
--output-directory /absolute/test-root/runs/external/new-signed-output
--identity-sha1 REVIEWED_40_HEX_CERTIFICATE_SHA1
--team-id REVIEWED_10_CHARACTER_TEAM_ID
```

The identity is the selected certificate's SHA-1, not a code-directory CDHash. It must uniquely match a valid Developer ID Application identity for the expected team. Missing/mismatched identities fail before output creation/signing; there is no ad hoc fallback or credential enrollment.

The finite policy covers every physical Mach-O and nested bundle. Signing proceeds inside-out with secure timestamps and hardened runtime. Only the main app and Electron helpers receive JIT entitlement; no blanket unsigned-memory or disabled-library-validation exception is added. The external fuse wire is `100000011`: RunAsNode remains for fixed workers; NODE_OPTIONS and CLI inspection are disabled, and cookie encryption remains off for session-only account policy.

Git helpers are signed before deriving the new Git inventory; ripgrep metadata is likewise rehashed. Prepared runtime inventory/notices are preserved and signed provenance is added. Metadata is finalized before the outer app seal. Independent verification extracts the signing certificate, checks authority/team, exact entitlements/timestamps/runtime, inventory transformations, original-input preservation, and derived runtime pins.

Outputs include `external-package-manifest.json` and a receipt. Real unmodified command execution is labelled `actual-signing`; injected command/verifier tests are `injected-command-test` and cannot qualify production delivery. Failures preserve evidence and do not emit a success receipt.

## Notarization and final ZIP

`external-delivery.mjs` accepts strict JSON configuration. Replace all placeholders below with reviewed pins. The `manifest` is the signed transform's manifest; `inputManifest` is the untouched original local package manifest. Output parent and temporary directories must already exist under the external test root; output name selects a new directory.

```json
{
  "bundle": "/absolute/test-root/runs/external/signed/asMagicBrain.app",
  "manifest": "/absolute/test-root/runs/external/signed/external-package-manifest.json",
  "inputManifest": "/absolute/releases/VERSION-preview/package-manifest.json",
  "expected": {
    "sourceCommit": "REVIEWED_40_HEX_COMMIT",
    "sourceTag": "native-vVERSION",
    "version": "VERSION",
    "buildNumber": 31,
    "teamId": "REVIEWED_10_CHARACTER_TEAM_ID",
    "identitySha1": "REVIEWED_40_HEX_CERTIFICATE_SHA1",
    "inputManifestSha256": "REVIEWED_64_HEX_SHA256"
  },
  "outputParent": "/absolute/test-root/runs/external",
  "outputName": "new-delivery",
  "temporaryDirectory": "/absolute/test-root/runs/external/delivery-scratch",
  "keychainProfile": "OWNER_PROVISIONED_PROFILE_NAME",
  "authorizeNotarySubmission": false,
  "pollAttempts": 30,
  "pollIntervalMs": 10000,
  "commandTimeoutMs": 300000
}
```

Build number `31` is illustrative; use the reviewed package value. `keychainProfile` names an existing owner-provisioned notarytool profile, not a password. Extra config fields, passwords, API keys, arbitrary environment values, and fallback identities are rejected.

```sh
npm run native:deliver:external -- --preflight /absolute/reviewed-delivery.json
```

Preflight verifies exact original/signed manifests, selected identity, code, runtime metadata, attributes, and new output path. It does not submit to Apple or read secret values. Submission is a separate authorized action: set `authorizeNotarySubmission` to `true` in the reviewed configuration, then:

```sh
npm run native:deliver:external -- --submit-reviewed-package /absolute/reviewed-delivery.json
```

The tool preserves an immutable submission ZIP and request ID, polls within configured bounds, retains Apple's log, and requires Accepted. It staples a separate owned copy, validates the ticket, re-verifies code, and verifies a newly produced final ZIP after extraction. Uncertain/failed submissions remain evidence; do not blindly resubmit. Transferable xattrs/resource forks and extra archive entries are refused; only the narrow OS-managed provenance attribute is tolerated before copying.

See Apple's [distribution-signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/) and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow). Actual account provisioning and submission are outside routine source tests.

## Verify delivery

Run native acceptance with a driver compatible with the shipped fuses. Recheck signatures, runtime inventories, and normal close after relocation to a path containing spaces. Keep local ad hoc checks, actual signing/notarization, and independent downloaded/quarantined Gatekeeper acceptance separate. Synthetic command tests do not establish Apple service or signing behavior.

Preserve the original package and every submitted artifact. Include dependency notices and bundled Git corresponding source when distributing binaries. Remote publication is a separate authorized action.
