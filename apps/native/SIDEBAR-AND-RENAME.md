# Sidebar and repository rename

See [current interface areas](../../docs/interface.md). V3/E2 is retired. V4 holds repository identity, rename, search, revision selection, New Markdown file, the root menu, and Go to file. New folder belongs in the root menu. V2 holds account/theme controls.

## Preserve editor state

The window-bar toggle and narrow-window dismissal share sidebar visibility. Toggle/resize must preserve the route, editor, drafts, and filename intent. Keep errors, pending operations, and saved/unsaved feedback visible.

## Rename

After **Rename repository** accepts an available portable name, the host moves the managed directory and acknowledges updates to the header/catalog. Files, Git history, and private identity remain. A renamed default Workspace remains the default after restart. Rename does not commit or rename a remote.

Checkpoint content drafts first. Pending filename edits, composition, loading, another operation, or unresolved recovery can block rename. New unsaved files remain under Unsaved files. Failures preserve the dialog and data. Official docs cannot be renamed through app actions.

The host serializes the move, checks source/destination identity, and records durable intent before changing catalog/profile bindings. Reusing an old visible name creates separate state; unknown destination content is never overwritten. Ambiguous interrupted work is held for recovery. Do not move private state or ownership markers manually.

## Verify

Check both themes and presentations, regular/narrow widths, repeated toggle, dirty buffers/filename intent, collisions, physical content/history, same-profile restart, default ordering, author preferences, and selected commits. See [native acceptance](acceptance/README.md).
