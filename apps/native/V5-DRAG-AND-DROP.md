# File-tree drag and drop

[User guide](../../docs/repositories-and-import.md)

| Action | Result |
| --- | --- |
| Drag current repository entries to folder/root | Move saved entries within that repository. |
| Drop OS files/folders onto folder/root | Copy admitted content; originals remain unchanged. |
| Import files… | Native picker alternative for copies. |
| Move to… | Menu alternative for internal moves. |

The outlined target must match the submitted destination, including fast pointer movement. Support empty folders/root targets and explain collisions, unsupported contexts, self/descendant moves, and no-ops. External conflicts use keep-both names without merging directories. Cross-repository moves, drag-out, and document attachments are unavailable. Official docs are read-only.

## Host admission

Native selections create short-lived host-owned tickets scoped to the renderer/window. Recheck them before use, including physical roots, identity, portable names, destination state, and source content. Import never authorizes execution.

Exclude `.git`, `.asmagicbrain`, `.asmb-*`, `.DS_Store`, and `__MACOSX`; retain ordinary dotfiles and empty directories. Refuse symlinks, hard-linked files, special files, unsafe paths, private-state sources, and metadata-only selections. Do not adopt imported Git/private metadata.

Repository scans allow 10,000 entries and depth 32. Copies stream bytes subject to disk/journal capacity; editor, media, and ZIP limits are separate. Copying bytes/modes does not preserve all Finder resource forks or extended attributes.

## Drafts and recovery

Checkpoint acknowledged drafts before path changes. Resolve filename intent/composition where required. Rebind retained drafts after moves without turning an unsaved proposal into a saved file. Moves/imports do not commit.

Cancel settles before returning; publication may win a late cancellation. Normal close drains admitted work. Resume only recognized owned recovery states. Preserve ambiguous staging, originals, and journals for investigation.

## Verify

Test stale sources/targets, conflicts, unsafe entries, interruption, cancellation, and recovery. Native acceptance should cover mouse/menu paths, rapid target changes, large binary bytes, empty folders, narrow layouts, read-only revisions, drafts, restart, and selected commits. Storybook cannot prove OS file access. See [acceptance](acceptance/README.md).
