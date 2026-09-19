# Accounts and privacy

[Documentation](README.md)

## Work without an account

Reading, editing, Save, drafts, file management, search, and local commits work offline. Connect an account from the menu in the left rail only when you need an online feature.

The application account and GitHub connection are separate. Connecting either one does not set your Git commit author or upload your local repositories. Some builds or accounts may not offer a connection.

## Sign in again after quit

Account sessions stay in memory while the app runs. Full quit forgets them; the next launch needs a fresh connection. Disconnect also forgets the selected account after related work finishes.

Your files, drafts, theme, repository list, and commit-author preferences still persist. These saved preferences are not account credentials.

## GitHub acquisition and updates

**Clone from GitHub** downloads a repository and its history. Public repositories can be cloned without an account. Private repositories need a configured connection and the required repository access.

For a GitHub clone, open **Check GitHub updates…** from the repository menu, then choose **Check for updates**. This downloads remote history and compares it with your local commits. Saved edits and private drafts are not part of the comparison.

When an update is available, choose **Review update…**, inspect the changes, then choose **Apply update**. If local changes, drafts, or conflicting history prevent the update, resolve them before trying again.

Push, merge, rebase, automatic background updates, SSH, and other Git servers are unavailable. Checking and applying updates do not upload local commits.

## Keep private information private

Sign-in, clone, and update actions contact their services when you request them. Clicking a web link opens it in your browser. Local Markdown preview does not automatically fetch remote images or run embedded HTML or scripts. Imported repositories do not run their hooks or project code.

Do not put credentials in files you might commit or share. Before sending a bug report or screenshot, remove private text, account details, repository names, and personal paths. [Back up complete local state](data-and-recovery.md#make-a-backup) separately from Git history.
