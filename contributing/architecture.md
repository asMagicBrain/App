# Architecture

[Contributor guides](README.md)

The shared React interface communicates through a typed preload bridge with Electron's main process. Native and shared host services own files, private drafts, local Git, and bundled search.

## Source map

| Location | Responsibility |
| --- | --- |
| `ui-workshop/src/` | Shared views, dialogs, CodeMirror editor, catalog, and outline. |
| `apps/native/renderer/` | Native UI adapter and startup. |
| `apps/native/main.mjs`, `preload.cjs` | Window lifecycle and narrow IPC admission. |
| `apps/native/host-service.mjs` | Service composition and managed repository authority. |
| `apps/native/storage-*.mjs` | Stable volume admission, legacy recovery inspection, and verified backups. |
| `packages/desktop-host/src/` | Physical roots, private state, Git, drafts, import, and management. |
| `apps/desktop/ui/markdown-preview.mjs` | Markdown, admitted links/media, and heading anchors. |
| `apps/native/bundled-docs*.mjs` | Validated user-doc payload and safe local installation. |
| `apps/native/*runtime*.mjs` | Pinned runtime preparation and selection. |
| `apps/native/external-*.mjs` | Signing, verification, and notarization tools. |

## Trust boundaries

The sandboxed renderer has no arbitrary filesystem or process access. The host validates named, bounded requests and rechecks authority. Read-only official documentation is protected in both host and UI.

Markdown HTML and remote images are disabled. Local links and media use admitted repository paths. Clicked external links are validated before opening outside the app.

Physical roots, stable identities, portable paths, journals, and source hashes constrain mutations. Ambiguous recovery preserves data. Save and selected-file commits remain separate operations. Git suppresses inherited configuration, hooks, filters, and credential helpers; imported projects cannot run automation.

These controls do not guarantee recovery from every storage failure or hostile changes by another process using the same OS account.

Native storage anchors its physical root to the filesystem volume UUID. Persisted identities retain their original device namespace through a scoped adapter; raw OS device/inode checks remain unchanged. Workers receive this context only from the host. Existing records and checksums are never rewritten to accommodate a renumbered device. Legacy profiles without a UUID anchor require read-only validation, a verified managed-data backup and native confirmation before interpreting a changed device number. An unchanged-device upgrade retains normal transaction recovery. See [recovery](../docs/data-and-recovery.md).

Packaged Git and ripgrep are pinned app-owned binaries with no PATH or system-Git fallback. Workers use the same checked binary/library set. Tests may explicitly use host Git for fixtures.

## Accounts and releases

The host owns account transport and build-time registration. Tokens stay in memory until quit. GitHub operations use validated acquisition provenance, so editing `.git/config` cannot redirect them. Comparison and clean Apply are explicit reviewed operations.

Packages record commit/tag, version/channel, runtime inventories, account configuration, and user-doc identity. Signing creates a separate output with updated inventories and preserves its input. Simulated provider/signing tests must be labelled. See [releases](releasing.md).

## Working limits

These are current admission bounds, not performance promises. Different operations have different limits.

| Operation | Bound |
| --- | --- |
| Repository discovery | 10,000 total file/directory entries; depth 32. Leave headroom for Git metadata and new content. |
| Markdown rendering | 524,288 UTF-16 code units (roughly characters); source-byte admission is checked separately. |
| Editable text | Admitted Markdown/text files up to 1 MiB; unsupported/binary encodings are not force-converted. |
| Local commit | Up to 256 selected saved paths; large/binary diffs may be summarized. |
| ZIP | 256 MiB compressed, 512 MiB expanded, 64 MiB/member; 20,000 archive entries and 9,999 extracted entries. |
| Saved-content search | Up to 10,000 files, 200 matches, 8 MiB/file, 128 MiB total input, 2 MiB output, 15 seconds. |
| Reviewed GitHub Apply | At most 1,000 changed paths; only complete, eligible clean fast-forward reviews. |

Media reading has format-specific size/admission rules. Large file copies stream data and remain bounded by disk capacity, entry/depth limits, and private journal capacity; they are independent of the text editor limit. A repository near discovery capacity should not be treated as fully browsable after adding more entries.
