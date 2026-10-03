# asTeach

asTeach is an optional plugin for preparing courses locally. Download the matching `.asmbplugin` from [GitHub Releases](https://github.com/asMagicBrain/App/releases), then install it in asMagicBrain v0.2.19 or later. It is not preinstalled.

1. Open **Manage plugins → Install plugin…** and select the asTeach `.asmbplugin` file.
2. Enable asTeach, then open its graduation-cap button in the left rail.
3. Use **+** to create a course. Enter its code, name, year and season. The app creates paired Instructor and Student repositories.
4. Open a course to edit its Instructor document. Save locally, then use **Commit changes…** when you want to record selected files in Git.

Teacher details and office information are saved on Home. New courses copy your teacher details; changing those defaults does not rewrite existing courses.

Use **Choose course page → Course calendar** to set Week 1 Monday, the number of weeks and recurring classes. Home combines the courses for the selected year and season. Double-click a date to add a no-class day.

### Copy a teaching schedule

Set the course dates, choose **Save** beside the total number of weeks, and add class sessions. The buttons on the right copy a table to paste into the Instructor page’s **Teaching Schedule** section:

- **One-Page Course** copies the schedule with editable `ClassContent` placeholders.
- **Multi-Page Course** creates `Class01.md`, `Class02.md`, and so on in the term’s `classes/` folder, then copies a schedule linking to those pages. Open each link to write its lesson.

Dates use two digits for the day, such as `Nov 03`. Copy feedback appears at the right of the calendar guidance row. Both include every course week, weekday/time/room columns and blank Notes cells. No-class dates keep their class numbers and show `No Class.` followed by the saved description.

Clicking **Multi-Page Course** again reuses existing pages without changing their content. The app manages its class-page records automatically. Existing sets created by older builds retain their original paths and links; after the entire old set is removed, new generation uses `classes/`. If only some generated pages are missing, restore them or remove the entire generated set before generating again. Changed dates, times or rooms also require a new set; move any lesson content you want to retain before removing the old pages. Moving files to Trash retains their names for recovery; restore them and move them elsewhere, or use **Empty Trash…** in the explorer’s Local Trash dialog before regenerating. Empty Trash permanently deletes retained files and drafts. Up to 255 classes can be generated for one term. Files are saved locally, without an automatic Git commit.

The copied table is an editable snapshot. Later calendar changes do not overwrite your Instructor document or class pages.

To use existing content, first import its repository with the normal repository tools. Then choose **Add existing course** in asTeach and select its Instructor Markdown file. The original document is retained. Documents that depend on GitBook includes are not automatically combined by this preview.

Disabling or uninstalling asTeach keeps course repositories. Their Markdown files remain editable with the normal app. Keep backups of your repositories and application state.

## Instructor templates

You can add, remove, rename or comment out headings in your Instructor document. Calendar settings remain separate.

Open `instructor-template.md` in the Instructor explorer to edit it with the normal editor. Save it before creating another term. New terms of this course copy that template; existing documents stay unchanged. Other courses keep their own templates. Without a saved template, new terms use the standard layout.

## Instructor and Student repositories

Choose **Student page** to open the same term in its Student repository. Choose **Instructor page** to return to private authoring. Both use the normal explorer and editor. Course Calendar stays in Instructor view.

New courses create both repositories immediately. Existing courses reuse a registered Student destination or create a separate local Student repository when first opened. If several destinations exist, choose one. Repository name collisions preserve existing content and require resolution before retrying.

Course settings are managed by asTeach and hidden from the explorer and search. Ordinary JSON documents remain visible. Keep the complete repositories and application state together when backing up.

## Review Instructor changes

1. Save your Instructor and Student edits.
2. Open **Student page → Review Instructor changes**.
3. Choose **Main page sections** to select Instructor sections, or **Course pages and assets** to keep the Student main page and review other pages.
4. Select additional Markdown pages, then choose **Review output**.
5. Check every listed file and confirm before saving to the paired Student repository.

Empty standard sections are omitted; custom sections can be selected. Linked Markdown pages require explicit selection; linked assets are included automatically. Comments and attachments may contain private information, so review them too.

No new Student document is written in the Instructor repository. Existing legacy files are retained. Independent Student edits and drafts are preserved through conflict review. Other terms and unrelated destination files stay unchanged.

Keep selected pages inside the term folder. Linked files in `shared/assets/` are copied into the Student term’s `assets/shared/` folder and output links are adjusted. Other cross-term links are refused. Authoring files remain unchanged.

## Deliver Student content

**Sync to GitHub ▾** offers:

- **Connect to GitHub…** links a local Student repository to an existing GitHub repository and the same branch. Connecting does not upload files.
- **Review GitHub status and Push…** checks remote history, then reviews outgoing commits before Push.
- **Prepare Student ZIP…** reviews and exports saved files from the Student repository, including all terms. Unsaved edits are excluded.

Reviewed term output includes `student.md`, selected pages, assets, `SUMMARY.md` and `.gitbook.yaml`. In GitBook Git Sync, select that term folder as the project directory. Local review does not commit, push or publish. Use selected-file commits and the reviewed Push workflow separately where available.

### Existing GitBook content

In **Prepare Student output**, enable **Convert GitBook HTML** to review a Markdown version of supported links, figures, tables and collapsible details. Conversion affects Student output only; Instructor files remain unchanged. Unsupported or active HTML blocks export until corrected.

Original `SUMMARY.md` groups and page order are reused for selected pages. An identical course README is represented by the Student home rather than copied twice. Review warnings for nonportable links before sharing. Inline `$$…$$` equations are supported by the technical reader; front matter stays in saved source without appearing as prose.
