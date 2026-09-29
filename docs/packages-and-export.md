# Update and export packages

Use the top-bar **+ → Update or export package…** for the open repository.

## Update from a ZIP

1. Choose the original package ZIP and **Record original package**. Its files must still match the saved files. This identifies the files that future packages may update.
2. Choose the incoming ZIP, version and package type. A **Patch** keeps files missing from the ZIP. A **Full snapshot** can propose removing previously recorded files.
3. Review each change. Choose **Keep current**, **Use incoming** or **Keep both**, then **Apply reviewed changes**.

Personal files and private drafts are protected. Updates change saved files; they do not create a Git commit. A changed file or draft invalidates an old review.

**Roll back update** restores the previous saved files while they still match the update. If an update is interrupted, reopen this dialog to **Resume update** or **Roll back**. Keep the workspace and its state together when backing up.

## Export a copy

Choose **Review export**, then:

- **Save source ZIP…** keeps saved documents and assets with their relative paths.
- **Save offline reader…** adds an `index.html` entry point for reading an extracted copy in a browser. Math and its fonts are included locally; diagrams have a readable source fallback. Interactive HTML stays inactive in this static reader.

Choose a new ZIP filename outside the managed workspace. Existing files are never overwritten. Drafts, Git history, application state and recovery backups are excluded. The review also lists missing dependencies and common credential filenames that are omitted. This filename check cannot find every secret; inspect the reviewed files before sharing.

Package updates currently support 256 changed paths and 4 MiB per changed file. Unchanged assets may be larger. These limits do not restrict ordinary file and folder management.

[Back to guide](README.md)
