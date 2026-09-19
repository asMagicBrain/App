# Organize and import

[Documentation](README.md)

## Create a repository

Choose **Create new → New repository**, enter a unique name, and create it. A repository is a local folder with Git history. New repositories start empty on `main`, without a remote connection. Add a file, save it, and make a local commit when ready.

Use the repository menu to rename, duplicate, reveal, or move it to Trash. Renaming keeps local content and history. Duplication copies saved files and Git history, but not private drafts, Trash, or account access. To duplicate unsaved work, save it first.

## Import a ZIP

Choose **Create new → Import repository → ZIP**. Import creates a separate repository with fresh Git history; it does not keep the ZIP's old Git history or remote connection. The original ZIP stays unchanged.

Ordinary files, dotfiles, and empty folders are kept. Imported Git and private app metadata are skipped. Encrypted archives, unsafe paths, links, and unsupported ZIP formats are refused. Large archives may exceed the app's [working limits](platform-and-limits.md#working-limits).

## Copy or move files

| To do this | Use this action |
| --- | --- |
| Copy files or folders from your computer | **Import files…**, or drop them onto a folder in the file tree. |
| Move entries within the open repository | **Move to…**, or drag them onto a folder in the file tree. |
| Rename, duplicate, or delete an entry | Its menu in the file tree. Deleted entries go to the app's Trash. |
| Find a saved entry on your computer | **Reveal**. |

External copies leave originals unchanged. Name conflicts get separate copy names, and folders are not silently merged. Import skips Git and private app metadata and rejects links or special files. File contents are copied; Finder tags and other extended attributes are not preserved.

On Ubuntu, **Import files…** first asks whether to choose files or folders. Dragging between repositories, dragging out to the desktop, and dropping attachments into a document are unavailable.

Wait for an operation to finish before closing. If you cancel late, an operation that already finished may remain completed. For interrupted operations, follow [recovery guidance](data-and-recovery.md#when-something-goes-wrong).

## Bring in a GitHub repository

Choose **Clone from GitHub** in the import dialog. A clone keeps the repository's Git history, branches, and tags. Public repositories can be cloned without signing in; private repositories need access. See [GitHub acquisition and updates](accounts-and-privacy.md#github-acquisition-and-updates).
