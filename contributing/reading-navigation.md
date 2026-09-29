# Reading navigation and portable references

[Contributor guides](README.md)

The native host owns session-only, bounded reading history. Entries contain stable local repository identity, display name, ref, relative path, view, source selection and scroll positions. They contain no document text. A checked successful visit appends; failed requests do not. Back/Forward use a one-use ticket, so a newer visit or traversal invalidates a delayed completion. The current window retains a single CM6 view; per-file states retain undo and private drafts. A cross-repository/ref transition uses the normal draft checkpoint and load path.

`packages/desktop-host/src/reading-navigation.mjs` is the pure contract; `apps/native/reading-service.mjs` admits repositories and saved reads. Local identity is not portable identity. History expires at quit and is capped at 100 locations. Current source/session history does not promise undo retention across an unloaded repository or application restart.

## Author-owned collection metadata

Optional root file `asmagicbrain.collection.json` uses JSON, schema version 1, at most 64 KiB and 256 documents. Unknown versions, malformed metadata and duplicate IDs produce readable feedback; ordinary Markdown still opens and edits. Opening never rewrites this file.

```json
{
  "schemaVersion": 1,
  "collectionId": "example.engineering",
  "documents": [
    {
      "id": "rate.report.v1",
      "path": "evidence/report-v1.md",
      "evidence": {
        "observationDate": "2026-09-20",
        "build": "example-1",
        "kind": "synthetic measured result",
        "validation": "fictional test data",
        "scope": "one demonstration workload",
        "supersedes": ""
      }
    }
  ]
}
```

IDs are 1–128 ASCII letters, numbers, periods, underscores, colons or hyphens, beginning with a letter or number. Document paths remain relative and pass host physical-path admission. Evidence fields are bounded plain author strings, not generated verification states. The examples describe no actual measurement.

Each document may declare up to 256 `targets`, each with `id`, `kind` (`heading`, `block` or `equation`), `sourceHash` (lowercase SHA-256), and `from`/`to` positions in the raw decoded UTF-16 source. The whole saved source hash must match before the range is used. Split CRLF or surrogate boundaries are refused. Successful ranges convert to CM6's BOM-hidden, LF-normalized coordinates without modifying bytes. A nearby heading or line number is never a replacement identity.

Portable references contain `schemaVersion: 1`, `collectionId`, `documentId`, and optional `targetId`, `sourceHash`, and `revision`. Copy reference pins the saved source hash. A matching hash establishes byte identity, not truth. A requested immutable revision must be available through the checked Git reader; otherwise resolution reports unavailable. Draft bytes never masquerade as a pinned saved version.

Copied collections can share IDs. Resolution refuses ambiguity until the user chooses an installed repository. Managed file renames retain a private checked redirect; these redirects are not automatically exported. External renames require a corrected declaration or restored path. Relative Markdown links keep their existing behavior and need no metadata.

## Verification

Pure tests: `ui-workshop/tests/reading-navigation.test.mjs` and `reading-reference.test.mjs`. The `Reading navigation — history and evidence` Storybook story uses an explicit in-memory adapter and fictional reports. It exercises the shared view; packaged host, Git, persistent redirects and cross-repository behavior require native acceptance.
