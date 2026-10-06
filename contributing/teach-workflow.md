# asTeach workspace model

Stages 2–3 add the durable host model and combined native explorer with reviewed migration UI. The existing repository graph remains the authority for course UUID and role stable IDs; project policy and submission stores are independent and unchanged.

## Workflow record

`teach-workflow.mjs` stores schema version 1 privately, outside repositories. Missing records mean `legacy-preparation`. A `direct-students` record specifies an existing Markdown home in the Students repository for every term. Unknown schemas or damaged journals hold for recovery. A private creation intent binds the course UUID to the validated creation request before import, so an interrupted new creation can resume without treating an old course retry as migration consent.

New courses create both local repositories, initialize their graph and workflow, and expose success only after identity registration. Student homes are created only in Students. Additional direct terms reuse the same repositories. Assistants and team repositories are created or bound explicitly. No remote creation, invitations, commits, access changes or code execution occur.

## Host requests

All requests use the existing serialized `nativeTeachRequest` bridge; the renderer cannot provide an absolute root.

| Operation | Additional fields | Result |
| --- | --- | --- |
| `workspaceDescriptor` | `repo`, optional `term` | Course UUID, terms, workflow, role/team identities, current names and availability, repository-relative roots/homes, pending recovery |
| `workflowInventory` | `repo` | Saved file hashes, draft paths, existing Students homes, legacy candidates and safety holds; no document contents |
| `reviewDirectStudents` | `repo`, `homes` keyed by term | Expiring fingerprint-bound plan, or `alreadyApplied` |
| `applyDirectStudents` | `planId` | Verified direct workflow activation |
| `cancelDirectStudents` | `planId` | Discard a review without mutation |
| `recoverDirectStudents` | `repo`, `direction`: `resume` or `rollback` | Recover the durable activation or roll back its unchanged before-state |

Descriptor reads do not hash entire repositories. Review/apply/recovery snapshot all available role repositories, metadata, Git head/branch, identities, drafts and project policy. Inventory uses existing physical-root, portable-path, symlink, hardlink, depth and entry checks; it has an 8 MiB per-file and 128 MiB total hashing admission budget. Oversize or unsafe trees require reconciliation; they are not partially adopted. No access privilege is inferred from a local role label or intended visibility.

## Migration and rollback

Migration selects **existing Students content**, including nested class/code/assets. It does not copy an Instructor candidate over authored Students content, transform links, relocate Git, delete legacy files or create commits. If no appropriate Students home exists, reconcile it explicitly before review. This makes a repository-content preimage unnecessary: the durable preimage is the workflow record, and every repository byte stays in place. The journal records prepared, activated and completed phases with the inventory fingerprint. A changed saved file, binding, Git state, draft or blocked tree invalidates the plan. Restart never silently retries a reviewed activation.

Rollback changes only the workflow record. Later content edits cause a conflict, even though rollback would not change those files. This conservative check prevents reverting an assumption after authoring has continued. Reapplying the same active homes is idempotent. Existing promotion receipts and independent files remain intact.

Legacy Instructor-section review and promotion remain available to unmigrated courses. Direct courses refuse those promotion paths with `TEACH_DIRECT_STUDENTS`. Direct generation resolves the selected Students binding/home through the descriptor and writes flat term/classes pages there, with private generation records under `.asteach`. It never creates Instructor-side Students content. NativeCourseWorkspace portals each RepositoryFileEditor explorer into a shared column and retains visited stable-root/ref instances. Existing per-file sessions, physical host checks and mutations remain authoritative. Unbound roles remain unavailable; term homes never come from guessed audience paths. Migration review uses inventory/review/apply/cancel/recover operations and opaque plans; UI does not synthesize a workflow record.

## Qualification

`teach-workflow.test.mjs` checks the state machine, fingerprints, schemas and every interruption phase. `host-teach-workflow.test.mjs` checks actual private journals, paired creation, terms/rename, nested Chinese BOM/CRLF bytes, policies, drafts, symlinks and rollback. `acceptance/teach-workflow.mjs` qualifies the exact Electron package through its real preload bridge and normal close/restart using synthetic profiles. The Stage 3 `acceptance/teach-workspace.mjs` exercises native retained sessions, actual explorer mutations/search, reviewed custom-home adoption/rollback and normal restart. Remote GitHub/GitBook and other-platform qualification remain subsequent stages.

## Direct delivery

Direct-authoring review uses the workflow descriptor Students root and selected term/home, never legacy Instructor candidates or promotion receipts. `reviewDirectDelivery` materializes the complete bounded term through the shared publication validator. Source hashes, binding and workflow fingerprint are rechecked at finish; drafts and recovery hold. `prepareDirectDelivery` writes only reviewed navigation/configuration through guarded `writeBatch`; normal selected-file Commit and reviewed Push remain separate. ZIP-only conversion never writes authored Markdown. MTL texture dependencies join XML/URDF/OBJ checks. Native tests distinguish source, exact package and provider evidence.
