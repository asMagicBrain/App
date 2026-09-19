# Getting started

[Documentation](README.md)

## Download the app

Open [GitHub Releases](https://github.com/asMagicBrain/App/releases) and choose the package for your computer. Check the release's version, platform notes, and checksum before opening it.

The preview targets Apple-silicon Macs and Ubuntu 24.04 x64. Check [Platforms and limits](platform-and-limits.md) before installing.

### Open on Mac

Download the Apple-silicon ZIP and unzip it. Read the [Mac preview note](platform-and-limits.md#mac-preview), then open **asMagicBrain Preview**.

### Install on Ubuntu

Download the `.deb` and its `SHA256SUMS` file from the same release. Compare the package's checksum with its entry in `SHA256SUMS`, then install it:

```sh
sha256sum asmagicbrain-preview_VERSION_amd64.deb
sudo apt install ./asmagicbrain-preview_VERSION_amd64.deb
```

Replace `VERSION` with the downloaded version. Open **asMagicBrain Preview** from the applications menu as your normal user. The package supplies Git and the sandbox configuration; you do not need Node.js or a separate Git installation. Do not run the app with `sudo` or `--no-sandbox`.

## Write your first note

1. Open **Workspace**, your default local repository—a folder with Git history.
2. Choose **Create new → New Markdown file**.
3. Name your file, write your note, and choose **Save**.
4. Use **Preview** to read the formatted document, or **Code** to read its source. Choose **Edit** to write again.

Save updates the file on disk. To record a point in its history, make a [local commit](files-and-git.md#make-a-local-commit). Neither action uploads your work.

## Bring in your work

Use **Create new → Import repository** to import a ZIP or clone a GitHub repository. Use **Import files…** to copy files or folders into an open repository. [Organize and import](repositories-and-import.md) explains each option.

Select **asMagicBrain** in the window bar to return to the repository list. Open **asMagicBrain-Docs** there to read this guide offline.

## Close or update the app

Quit normally and wait for the app to exit. This lets pending work finish. Your files and retained drafts remain on your computer; connected accounts need a fresh sign-in after quit.

Before installing a newer preview, [back up your data](data-and-recovery.md#make-a-backup). Application updates and Ubuntu package removal leave your data outside the app installation.
