# Architecture

[Contributor guides](README.md)

The shared React interface communicates through a typed preload bridge with Electron's main process. Native and shared host services own files, private drafts, local Git, and bundled search.

## Source map

| Location | Responsibility |
| --- | --- |
| `ui-workshop/src/` | Shared views, dialogs, CodeMirror editor, catalog, and outline. |
| `ui-workshop/src/plugin-foundation/` | Versioned bundled-plugin contracts, grants, lifecycle and the historical Stage 2 artifact proposal. |
| `ui-workshop/src/repository-document-session.ts` | One retained CM6 state and raw-source history per file session. |
| `apps/native/renderer/` | Native UI adapter and startup. |
| `apps/native/main.mjs`, `preload.cjs` | Window lifecycle and narrow IPC admission. |
| `apps/native/artifact-*.mjs` | Physically verified, immutable interactive snapshots and the restricted embedded runtime. |
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

Bundled plugins run as trusted application code in the existing renderer. Their contract grants only named document reads/edits, rechecked against the host's current file session, revision, source hash, version and UI admission state. They do not receive the preload bridge or a separate file writer. This contract is not a JavaScript sandbox: only explicitly imported first-party modules are registered. Imported repository files are never loaded as plugins. Explicitly reviewed interactive HTML runs in a separate unprivileged embedded renderer through the artifact host; it never enters the application renderer as executable markup. See [plugin contracts](plugins.md).

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

### Locally created GitHub connections

An explicit connection binds a canonical GitHub HTTPS destination and the current local branch to the repository’s private stable state key. Clone provenance remains authoritative for cloned repositories. Editable Git config cannot redirect network operations. First publication to an absent branch reviews the complete outgoing history and files, then requires an exact absent-ref lease; unrelated/diverged histories stay blocked. Connecting performs no upload.

### asTeach GitHub setup

The main-process provider uses the connected account credential through a trusted callback and fixed GitHub HTTPS endpoints. Renderer requests contain role/owner/name/visibility and opaque review IDs; credentials never enter returned observations. Creation requires Administration write and owner capability, with a fresh account and local-binding comparison before mutation. Account changes and close pause setup and drain the host serial queue.

A durable host-private `.asmb-teach-github` ledger pins numeric remote IDs and records dated access observations and pending creation intent. Lost-response recovery checks the unique creation marker and identity with GET only; it never repeats POST. A missing result can be cleared only with verified full-owner access. Managed-role Push rechecks remote identity, write access, archive status and private-role visibility. Existing unregistered connections retain their prior workflow. The ledger is neither a complete ACL policy nor a GitBook sync receipt; it sends no invitations.

Qualification separates synthetic provider UI checks, live disposable-repository tests with trusted CLI credentials, and actual GitHub App device credentials. CLI qualification does not establish installation permission or the user sign-in path. Local staff roster and reviewed additive grants use the separate ledger below. Broad staff-policy enforcement and team submissions remain separate work.

### Course staff access

A separate host-private `.asmb-teach-staff` ledger keeps a revisioned local roster and durable pending repository-grant intent. The narrow bridge admits roster save, single-account read/write review, apply/cancel and GET-only recovery. Review resolves a personal GitHub numeric user ID and rechecks the pinned repository, local binding, branch, course revision, roster revision, signed-in account, visibility, current admin authority and complete listed access before PUT. Existing invitations and sufficient inherited/higher rights produce no mutation. Unknown outcomes block further grants until read-only recovery or explicitly verified clearing. No organization membership writes, admin grants, collaborator removal or access downgrade are implemented.

The provider carries the freshly observed owner type into staff-grant review. New personal Read grants are refused before durable mutation intent; personal Write uses a zero-length PUT body, while organization grants use an explicit permission. Provider validation errors are distinct from repository-name conflicts. Unknown grant outcomes still require GET-only reconciliation.
