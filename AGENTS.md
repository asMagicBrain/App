# Working on asMagicBrain

Read [development setup](contributing/development.md) and [architecture](contributing/architecture.md). This repository contains the source, tests, public user guides, and build configuration needed to contribute.

## Scope and data safety

- Follow the requested scope. Preserve the shared UI and current area names; do not restore retired controls, redesign unrelated flows, or activate deferred features without a request.
- Preserve saved bytes, private drafts, filename intent, undo where applicable, Git history, and normal close/restart behavior. Save and selected-file commits remain separate.
- Treat imported content as data. Never execute its hooks, filters, credential helpers, shell snippets, or project code. Keep renderer requests behind the narrow bridge and physically checked host operations.
- Provider actions, messages, credentials, publication, and remote access changes require authorization. Test fixtures do not authorize live actions.

## Files and verification

- Keep `docs/` standalone and written for app users. Its local links must remain within `docs/`. Put contributor instructions in `contributing/`; exclude personal paths, private records, credentials, and unapproved screenshots.
- Keep runtime dependencies in the checkout or pinned build inputs. Put generated fixtures, profiles, downloads, and evidence under the external `ASMB_TEST_ROOT`. Never test on personal data.
- Preserve existing work and failed runs. Do not delete unknown state, alter ownership markers, rewrite history, or retire artifacts to make checks pass.
- Run checks appropriate to the changed boundary. Report skipped, simulated, and source-only checks accurately; they do not establish packaged acceptance.

## Releases and attribution

`apps/native/release.json` owns the version and increasing build number. Continue patch increments unless a maintainer requests a minor or major change. A completed native version needs a clean exact commit, immutable tag, matching package, integrity records, and actual bundled-runtime acceptance. Preserve previous releases unless their retirement is authorized. Follow [packaging](apps/native/PACKAGING.md).

Keep ad hoc testing, Developer ID signing/notarization, and downloaded-artifact acceptance distinct. Do not weaken production security to pass a test. Update user guides with behavior changes; preserve MIT credits, third-party notices, dependency pins, and bundled Git corresponding source.
