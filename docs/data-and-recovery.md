# Back up and recover

[Documentation](README.md)

## Find your data

| Data | Preview location |
| --- | --- |
| Repositories, including Workspace | `~/asMagicBrain/workspaces/asMagicBrain/` |
| Private drafts and app state | `~/asMagicBrain/state/` |
| Mac app profile and preferences | `~/Library/Application Support/asMagicBrain Preview/` |
| Ubuntu app profile and preferences | `$XDG_CONFIG_HOME/asMagicBrain Preview/`, or `~/.config/asMagicBrain Preview/` by default. |

`~` means your home folder. Your data is separate from the installed app.

## Make a backup

1. Quit asMagicBrain normally and wait for it to exit.
2. Copy the complete `~/asMagicBrain/` folder and the app profile listed above to your backup location.
3. Include hidden files and preserve folder permissions.
4. Verify the copy before relying on it. Keep the original while checking any restore.

Git commits do not back up unsaved drafts, untracked files, or app state. Duplicating a repository is not a complete app backup. Keep a separate backup outside this computer for important work.

Close the app before upgrading or removing it. Ubuntu package removal leaves user data in place. Do not open an existing profile with an older app version.

## Keep notes on the guide

The official **asMagicBrain-Docs** repository is read-only in the app. Use **Duplicate repository** for an editable copy.

Guide updates come with the app. Previous editions and unexpected outside edits are preserved before replacement. A same-name user folder is kept, and the official copy may receive a numeric suffix. Preserved copies are not automatically deleted.

## Restore access after a drive change

If macOS changes the drive's internal device number, asMagicBrain may offer **Back Up and Restore Access**. This checks the existing storage records and makes a verified copy of your workspace, drafts and local Git history before restoring access.

The backup is kept in `~/asMagicBrain-recovery-backups/`. Keep it until you have checked your files and drafts. Recovery preserves the original records; it does not reset your workspace. If a check fails, your original data stays in place—contact support rather than deleting the `state` folder.

This recovery copy covers the managed data in `~/asMagicBrain/`; it is not a complete app-profile backup. For a complete manual backup, also copy the Mac or Ubuntu app profile listed above.

The updated app remembers the drive's stable volume identity. A replaced folder, changed drive identity or damaged record still requires investigation.

## When something goes wrong

Keep your data folder unchanged. Note the error message, app version, and the action that led to it, then [report the problem](https://github.com/asMagicBrain/App/issues) with a small example that contains no private data.

Normal quit lets pending writes finish. Force-quitting, power loss, failing storage, or concurrent edits from another app can need recovery. Work from a verified backup copy when investigating; automatic repair is not guaranteed.

## Locate courses after an application update

Open **Account → About asMagicBrain** to see the actual version, build, channel and absolute active workspace location. Development and Preview can use different folders. Installing asTeach enables the plugin in the active workspace; it does not move earlier courses. An empty asTeach Home offers **Locate previous courses**.

Choose **Locate previous courses** and select the complete managed-data folder containing both `workspaces` and `state`. Review the selected folder, file counts, repositories and names present in both locations. Select **Back up and switch** only after reviewing them. The app preserves pending drafts, closes its host, verifies backups of both managed folders and validates the selected private stores. Reopen to use the selected folder **in place**. The current folder is retained. No files are merged, no credentials are copied and nothing is published to GitHub.

This retains saved files, untracked files, Git history/remotes, drafts, Trash, installed plugins, course calendars, teacher defaults, paired repository identities and other private journals with their original physical folder identities. Accounts require sign-in again. Local automation is disabled until authorized again. The existing Electron profile remains separate; its cache and account data are not migrated.

Names shared by both folders are separate copies, not merged conflicts. Edit only the active copy. To return, open About and select **Review return to previous workspace**. Returning also requires review and verified backups of both folders; it does not undo edits made while using either folder.

An interrupted switch retains originals and partial or verified backups. If selection was not published, the previous folder remains active. Reopen and choose **Resume workspace review** for a fresh review and backups. If selection was already published, startup validates that folder and completes the journal. A missing drive, changed folder identity or damaged record is rejected rather than silently opening a different workspace.

Backups are kept in `asMagicBrain-recovery-backups` beside each managed folder, with a hash-verified receipt. They retain recovery evidence, including lexical workspace symlinks without reading their targets. They are **not** directly usable rebound profiles: copying a backup changes physical identities. Keep both original folders and ask for recovery help if restoration is needed.

### Upgrade compatibility

| Existing data | Supported behavior |
| --- | --- |
| Earlier Preview using the same managed folder | Open in place; validate ownership, volume identity and existing private journals. |
| Earlier Development using a different complete managed folder | Explicit reviewed adoption in place; retain the original channel record and physical identities. |
| Both folders have courses, including identical names | Choose one complete workspace. No merging or automatic overwrite. |
| Folder on a local external drive | Adopt after ownership and volume checks; reconnect the same drive for later launches. |
| Development candidate | Adoption is restricted to its designated Test folder. It cannot adopt normal-use data. |
| Repository ZIP or saved repository folder without private state | Import saved content; this is not a workspace migration and cannot restore private drafts or bindings. |
| Copied/replaced managed root or unsupported newer private schema | Fail closed; keep originals and investigate. No blind identity rebinding. |

Review and backups allow up to 200,000 entries and 128 directory levels. They do not force large repositories through ZIP import. Hard links, special files, unsafe ownership, linked managed roots and links in private state are refused. Backup time and required free space depend on the complete folder size. The application remains closed to editing while it verifies backups; wait for the native result dialog.
