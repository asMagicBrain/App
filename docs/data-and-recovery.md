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

## When something goes wrong

Keep your data folder unchanged. Note the error message, app version, and the action that led to it, then [report the problem](https://github.com/asMagicBrain/App/issues) with a small example that contains no private data.

Normal quit lets pending writes finish. Force-quitting, power loss, failing storage, or concurrent edits from another app can need recovery. Work from a verified backup copy when investigating; automatic repair is not guaranteed.
