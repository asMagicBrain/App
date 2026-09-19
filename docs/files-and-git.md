# Write, save, and commit

[Documentation](README.md)

## Know where your work is

| State | What it contains |
| --- | --- |
| Draft | Unsaved text and a proposed filename, kept in private app state. |
| Saved file | The file on disk, updated when you choose **Save**. |
| Git commit | A point in local history containing the saved changes you selected. |

**Save does not create a commit. A commit does not include private drafts or unchecked files.** Neither action uploads your work. Push is not available.

## Edit a file

Open a Markdown or text file and choose **Edit**. Write your changes, then choose **Save**. **Preview** shows formatted Markdown; **Code** shows read-only source.

The app retains drafts when you navigate or close normally. To remove a draft, choose **Cancel changes**, then **Discard changes**. This removes unsaved text and the proposed filename; it does not undo an existing commit. Save important work before depending on another app to read it.

If another app changes a file while you edit, asMagicBrain stops the save instead of silently overwriting it. Keep your draft and resolve the reported conflict before trying again. Unsupported text encodings and binary files remain read-only.

## Make a local commit

1. Save the files you want to include.
2. In Edit, choose **Commit changes…** and select the saved files.
3. Review the changes. Large or binary files may show a summary.
4. Enter a message and choose or enter the author's name and email.
5. Choose **Commit changes**.

If the files or Git state change during review, refresh the review before committing. Signing into an account does not set your commit author.

## Read older versions

Choose a branch, tag, or historical revision to read it. Return to the writable working files to edit. Local history helps you track changes, but it is not a [complete backup](data-and-recovery.md#make-a-backup).
