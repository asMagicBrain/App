# Layout contract

The V3/E2 repository section strip is retired. Keep the file sidebar against the window bar and the document column directly above the current file or overview. This filename is retained for discoverability; see [current interface areas](../../docs/interface.md).

- Sidebar toggles and resize/collapse must preserve the document route, acknowledged drafts, and mounted editor where no reload is needed.
- Preview, Code, and Edit share that route.
- DO1 is the integrated right-hand Outline, initially collapsed.
- Deferred controls follow channel presentation; working controls disabled by context stay visible.

The shared layout lives in `FocusedWriting.tsx`, `RepositoryCodePage.tsx`, and `RepositoryFileEditor.tsx` under `ui-workshop/src/`. Check regular/narrow layouts, both themes, keyboard focus, panel toggles, and draft continuity. Historical screenshots are not the current specification.
