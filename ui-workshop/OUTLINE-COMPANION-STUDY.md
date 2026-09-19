# Integrated document outline

DO1 is the right-hand Outline in the main application window, initially collapsed. The earlier companion window is retired; the filename remains for discoverability.

## Interaction

- Toggle the panel without changing native window bounds or replacing the editor.
- Headings support pointer/keyboard navigation and return focus to the document. The plain panel title needs no focus target.
- Preview, Code, and Edit share semantic heading positions; fenced code does not create headings.
- Current-heading tracking follows scrolling without editing source.
- Catalog, Home, plain text, and heading-free documents have empty states.
- Left navigation and right outline resize/collapse independently at narrow widths.
- Theme and availability changes preserve route, drafts, and mounted CodeMirror state where no reload is required.

## Verify

`src/FocusedWriting.tsx` and `src/RepositoryFileEditor.tsx` use the shared Markdown parser. Check focus, heading jumps/tracking, toggles, resizing, narrow/empty states, both themes, modal guards, and draft/undo retention. Native acceptance must also establish normal close/restart behavior.

See [search and outline](../docs/search-and-outline.md) and [interface areas](../docs/interface.md).
