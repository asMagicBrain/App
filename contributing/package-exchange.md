# Package updates and portable exports

The native host owns package operations. The renderer supplies a repository name,
ZIP bytes and explicit review choices. It cannot choose a source or private-state
root. The service runs in the same serialized host queue as Save and file management.
It never creates a Git commit, changes remotes, or executes imported code.

## Versioned package format

An ordinary ZIP can be registered with an explicit collection ID and version. A
portable source export adds `asmagicbrain-package.json`:

```json
{
  "format": "asMagicBrain-package",
  "schemaVersion": 1,
  "collectionId": "engineering-notes",
  "version": "2",
  "semantics": "snapshot",
  "files": [{"path": "README.md", "sha256": "<64 lowercase hexadecimal characters>"}]
}
```

`semantics` is `snapshot` or `patch`. An optional `base` object contains a version
and the exact earlier file/hash list. An optional `excluded` array records paths
omitted during export and the reason `suspected-credential-filename`.
The parser checks member hashes, exact supported fields, path spelling, aliases,
collisions, CRCs and archive limits through the existing ZIP admission code.
A manifest is data; it grants no target-repository authority.

## Ownership and review

1. **Record original package** requires a supplied base whose listed files exactly
   match saved local bytes. Drafted files cannot be registered.
2. **Review package** compares base, saved current and incoming bytes. Source hashes,
   text previews and explicit resolutions are returned in a short-lived plan.
3. **Apply reviewed changes** rechecks the root identity, file identities/hashes,
   saved inventory and persisted draft paths after every asynchronous boundary.

Snapshot omissions propose removal only of already owned files. Patch omissions
preserve files. Each actionable row requires a choice: keep current, use incoming,
or keep both where offered. A declined collision with a user-owned path stays
user-owned, including when the bytes happen to match. Keep both uses a separate
incoming filename; it does not seize ownership of the original path. A declined
new addition also remains outside the package's ownership.

A review expires after ten minutes; at most eight plans are held in memory. Plans
are not approval records across a restart. Private drafts are protected and never
substituted for saved source bytes in a package.

## Recovery and rollback

`package-exchange/journal` is an authenticated private store. Content-addressed
`blobs` retain the original base and exact before/after bytes. Each source-file
publication uses the existing filesystem transaction engine and its recovery
journal; folder creation uses the existing file-management adapter.

A package is not published atomically as a whole. Once a durable outer intent
exists, interrupted work holds ordinary native reads and writes for that repository.
The user explicitly chooses Resume or Roll back. Each step rechecks the saved bytes
and drafts. Unknown newer source bytes block recovery rather than being overwritten.
The latest completed update can be rolled back only while its expected saved
post-images still match. Git history and unrelated files are untouched.

The trusted host can pass an optional `operationId` to `apply` to correlate a
durable automation approval with its package receipt. Renderer requests cannot
provide it. It must be a lowercase version-4 UUID; a retained completed/rolled-back
ID cannot be reused. A lost response is reconciled through status, never by
replaying publication. Pending work still requires explicit Resume or Roll back.

Rollback may leave empty parent folders created for an incoming asset, including
an interruption immediately after a directory was created. This does not imply
that its file content was retained. Old package preimages are retained; no cleanup
or silent repair discards them.

The pure `validateExchangeState` decoder is shared by normal startup and read-only
volume recovery. Device-number recovery additionally authenticates every retained
blob and its source-journal binding. Pending package work blocks device rebinding;
it is not automatically resumed or discarded during that process.

## Bounds

- ZIP: 256 MiB compressed, 512 MiB expanded, 64 MiB per member, 9,999 source files.
- Reviewed publication: at most 256 changed paths, 4 MiB per changed file.
- Retained package data: 2 GiB; eight completed-operation records.
- Private journal and native storage-recovery limits still apply.

These are package-operation limits, not restrictions on ordinary file management.
Review surfaces an oversized changed file and requires keeping its current version.
Large unchanged assets can still be exported within the ZIP limits. No background
worker or native performance claim is implied for archives near the maximum size.

## Source and offline exports

Export review lists included files, saved hashes, dependency warnings and excluded
paths. A source ZIP preserves included bytes and relative paths. Git metadata, app
private state, drafts and host account storage are excluded.

An additional filename heuristic excludes `.env*` (except `.env.example`,
`.env.sample`, `.env.template`), `.npmrc`, `.netrc`, `_netrc`, `.git-credentials`,
`credentials.json`, SSH private-key names, `.pem`, `.key`, `.p12`, `.pfx`, and files
under `.ssh`, `.gnupg` or `.aws`. Each omission appears in review and in the export
manifest. This is **not secret scanning**; secrets written inside ordinary Markdown
or other unrelated filenames cannot be identified by this rule. It does not alter
the working files or restrict normal ZIP import.

The offline ZIP contains exact portable files under `source/` and generated static
pages under `reader/`. Relative chapter links, anchors and local raster assets are
preserved. Math uses the shared KaTeX pipeline: static visual HTML with accessible MathML,
plus the exact bundled KaTeX stylesheet and its local fonts under
`reader-assets/katex/`. Rendering does not depend on installed math fonts or
reader JavaScript. The CSP permits local fonts and trusted generated layout
attributes while continuing to deny scripts, connections, objects and frames.
No external font request or inactive Copy TeX button is emitted. Mermaid uses
an explicitly labelled source fallback. HTML, JavaScript, SVG and artifact sources
are shown as escaped source; interactive artifacts do not execute in this reader.
External or missing dependencies are reported. The reader uses a restrictive CSP,
no imported scripts, and carries MarkdownIt/KaTeX notices and source licenses.
Offline reader support is static reading support, not completion of in-app artifact
interaction (which uses the separate Stage 3 isolated viewer).

## Idempotent automation import

`importArchive({name, archivePath, requestId, initializeHistory: false})` binds a
request ID to the ZIP digest, destination name and history option. A durable
`.zip-request.json` plus schema-5 ready/publication records prevent duplicate
repositories after a lost response or restart. `findCompletedImport` is read-only
and returns a receipt only for an already registered matching import.

The automation option initializes unborn local Git but creates no commit, author
identity or remote. Ordinary UI ZIP import retains its existing fresh-history
behavior. An unstarted interrupted automation approval is not itself permission to
start a new import; the broker requires a fresh review when no receipt exists.

## Verification

Source tests cover neutral base/current/incoming hashes, explicit ownership,
snapshot/patch differences, drafts, stale files/root identities, path aliases and
links, process interruption, transaction recovery, rollback conflicts, portable
source bytes, static export fallbacks and filename exclusions. Native-host tests
exercise the single queue and read/write hold across restart. Storage tests exercise
uniform device renumber after Stage 4 operations and compare every original private
file with the verified backup. Packaged macOS/Linux qualification is recorded
separately; passing source tests alone is not packaged acceptance.
