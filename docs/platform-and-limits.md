# Platforms and limits

[Documentation](README.md)

## Supported systems

| System | Preview status |
| --- | --- |
| Apple-silicon Mac | Requires macOS 13 or newer. Tested on macOS 26.5.2; other versions and independent clean Macs remain untested. |
| Ubuntu 24.04 LTS x64 / amd64 | Tested in an emulated Ubuntu 24.04.5 X11/Openbox desktop. Physical computers, full GNOME, and Wayland remain untested. |
| Intel Mac, Windows, other Linux systems or processors | No tested app package. |

Read the notes for your exact package on [GitHub Releases](https://github.com/asMagicBrain/App/releases). A source build alone does not establish compatibility.

## Mac preview

macOS may block this preview because it is not signed for distribution or notarized. Keep macOS security settings enabled. If it cannot open, report the problem with the version and error message.

## Ubuntu installation

Install the `.deb` with APT as described in [Getting started](getting-started.md#install-on-ubuntu). Close the app before an update or removal. To remove the package:

```sh
sudo apt remove asmagicbrain-preview
```

Removal leaves your repositories and profile in your home folder. [Back them up](data-and-recovery.md#make-a-backup) before testing a newer preview.

## Working limits

- **Editing:** supported text files can be up to 1 MiB. Binary files and unsupported text encodings are read-only.
- **Large files and repositories:** preview, import, and browsing have size limits. Split oversized imports and keep enough free disk space for copies and history.
- **Search:** results may be limited. Narrow your search if the app reports a limit.
- **Commits:** large or binary changes may show a summary instead of a full text comparison. Commit a smaller selection if the app asks you to.

## Features still unavailable

AI actions, cloud document sync, Push, merge/rebase, automatic remote updates, and multi-user collaboration are unavailable.
