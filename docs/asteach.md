# asTeach

asTeach is an optional plugin for preparing courses locally. Download the matching `.asmbplugin` from [GitHub Releases](https://github.com/asMagicBrain/App/releases), then install it in a compatible asMagicBrain version; audience-root authoring requires v0.2.22 or later. It is not preinstalled.

1. Open **Manage plugins → Install plugin…** and select the asTeach `.asmbplugin` file.
2. Enable asTeach, then open its graduation-cap button in the left rail.
3. Use **+** to create a course. Enter its code, name, year and season. The app creates paired Instructor and Student repositories.
4. Open a course to edit its Instructor document. Save locally, then use **Commit changes…** when you want to record selected files in Git.

Teacher details and office information are saved on Home. New courses copy your teacher details; changing those defaults does not rewrite existing courses.

New courses use the paired **Student repository** as the authoritative student content. Edit its Markdown directly using **Student page** and the normal explorer. No Student candidate pages are created inside the Instructor repository. Existing courses retain their legacy preparation workflow until explicitly migrated; the legacy preparation instructions below apply to those courses. The combined course explorer places a non-expandable Course calendar button first, styled and aligned like the repository headers, followed by Instructors, Assistants, Students and the selected term’s Projects. Expand roots together or collapse them individually. Opening a repository expands and reveals its explorer. Each expanded explorer initially fits all currently expanded file rows. Expanding folders grows it automatically until you set a custom height. Drag its visible lower grip to resize it; focus that separator and use Up/Down to adjust it, or Home/double-click to restore the default height. Saved role and team bindings appear immediately without restarting. Save, branches, Commit and GitHub status use the repository of the open file. Visited repositories retain their drafts, undo and reading state while you switch. An unbound Assistant root shows Unavailable; create/bind it explicitly in Course settings.

Use **Choose course page → Course calendar** to set Week 1 Monday, the number of weeks and recurring classes. Home combines the courses for the selected year and season. Double-click a date to add a no-class day.


Existing courses keep their original repository explorer when opened. The document uses the available course area; inactive course panels do not reserve blank space above it.

### Adopt existing Students content

Open **Course settings → Repositories → Students authoring → Advanced authoring and recovery → Review authoring workflow…**. Inspect the saved inventory and select an existing Students home for every term. Review those paths, acknowledge them, then apply the local workflow. Missing or ambiguous content must be reconciled in Students first. No Instructor candidate is copied, and no repository files, Git history or access bindings are changed.

Retained drafts, unsafe/incomplete inventories and changed files hold the operation. Reinspect after a conflict. If an apply was interrupted, the review offers explicit resume or rollback of unchanged state. **Roll back unchanged workflow** restores only the recorded workflow metadata; later author edits cause a conflict and are never overwritten.

### Copy a teaching schedule

Set the course dates, choose **Save** beside the total number of weeks, and add class sessions. The buttons on the right copy a table for a **Teaching Schedule** section:

- **One-Page Course** copies the schedule with editable `ClassContent` placeholders.
- **Multi-Page Course** creates `term/classes/ClassNN.md` directly in Students for direct-authoring courses. The copied links are relative to the selected Students home; paste that table into the Students page. Legacy courses retain their audience-package or existing flat paths, with links relative to the Instructor source. Open each lesson to edit it.

Dates use two digits for the day, such as `Nov 03`. Copy feedback appears at the right of the calendar guidance row. “Class pages saved. Schedule copied.” confirms both steps completed; a copy failure leaves saved pages intact and offers another attempt. Both include every course week, weekday/time/room columns and blank Notes cells. No-class dates keep their class numbers and show `No Class.` followed by the saved description.

Clicking **Multi-Page Course** again reuses existing pages without changing their content. The app manages its class-page records automatically. Existing sets created by older builds retain their original paths and links; after the entire old set is removed, new generation uses `classes/`. If only some generated pages are missing, restore them or remove the entire generated set before generating again. Changed dates, times or rooms also require a new set; move any lesson content you want to retain before removing the old pages. Moving files to Trash retains their names for recovery; restore them and move them elsewhere, or use **Empty Trash…** in the explorer’s Local Trash dialog before regenerating. Empty Trash permanently deletes retained files and drafts. Up to 255 classes can be generated for one term. Files are saved locally, without an automatic Git commit.

The copied table is an editable snapshot. Later calendar changes do not overwrite course documents or class pages. **New class page** creates one chosen class number directly in Students for direct courses; existing files are never replaced. Legacy courses retain the **New class package** action.

To use existing content, first import its repository with the normal repository tools. Then choose **Add existing course** in asTeach and select its Instructor Markdown file. The original document is retained. Documents that depend on GitBook includes are not automatically combined by this preview.

Disabling or uninstalling asTeach keeps course repositories. Their Markdown files remain editable with the normal app. Keep backups of your repositories and application state.

## Instructor templates

You can add, remove, rename or comment out headings in your Instructor document. Calendar settings remain separate.

Open `instructor-template.md` in the Instructor explorer to edit it with the normal editor. Save it before creating another term. New terms of this course copy that template; existing documents stay unchanged. Other courses keep their own templates. Without a saved template, new terms use the standard layout.

## Instructor and Student repositories

Choose **Student page** to open the same term in its Student repository. Choose **Instructor page** to return to private authoring. Both use the normal explorer and editor. Course Calendar stays in Instructor view.

New courses create both repositories immediately. Existing courses reuse a registered Student destination or create a separate local Student repository when first opened. If several destinations exist, choose one. Repository name collisions preserve existing content and require resolution before retrying.

Course settings are managed by asTeach and hidden from the explorer and search. Ordinary JSON documents remain visible. Keep the complete repositories and application state together when backing up.

## Audience roots and complete class packages

Legacy audience-structured terms use two content roots inside the private Instructor repository:

```text
2026-autumn/
  instructors/README.md
  instructors/classes/class06/delivery.md
  instructors/classes/class06/technical.md
  students/README.md
  students/classes/class06/lesson.md
  students/classes/class06/package-manifest.json
  students/classes/class06/media/
  students/classes/class06/code/
```

Choose **Instructors**, **Student candidates**, or **Released Students** in the course page menu. Candidates stay editable in the private repository; Released Students opens the paired repository. All use the normal explorer. The document path identifies the actual saved file. Browse source/code as text or use **Reveal in Finder** for unsupported assets; opening source does not execute it. **Refresh files** reloads external changes to saved documents and refreshes the tree while preserving drafts.

Existing courses with both audience `README.md` files are detected without moving files, changing IDs/calendar/bindings, or replacing legacy aliases. No opening/refresh action generates classes. **Course calendar → New class package** creates a selected class number without replacing existing files or changing the calendar. Media/code folders are created when files are added, not as empty placeholders.

From **Student candidates → Review Student package**, review the complete candidate root before saving to the paired repository. **Prepare Student ZIP…** provides the same reviewed file plan. The output strips `students/`: `2026-autumn/students/classes/class06/lesson.md` becomes `2026-autumn/classes/class06/lesson.md`. Class-relative paths stay intact. GitBook uses the released term’s `README.md`, `SUMMARY.md` and generated `.gitbook.yaml`.

The complete review lists source, destination and hashes. It admits bounded Markdown, code/config, SVG, model/policy and media assets (8 MiB per file, 128 MiB total, 4096 files). Unsupported files, private-root links, symlinks, environments/caches, missing dependencies and stale package hashes block delivery; nothing is silently omitted. Large assets need explicit versioned external release links/checksums and an access review. Class manifests can list relative files or map them to SHA-256 hashes. Editing a hashed file requires updating its declared hash before delivery. Source code and figure scripts are packaged as data; a successful copy does not establish that they run or that figures meet a publication standard.

Independent released-file edits and drafts block replacement through the existing package comparison/recovery workflow. Local preparation never commits, pushes, grants access or runs imported code. Course settings can promote the complete candidate package to Assistants/Students with an explicit file selection; selected private support is a separate Assistant-only review. Team/project workflows remain optional.

## Review Instructor changes

1. Save your Instructor and Student edits.
2. Open **Student page → Review Instructor changes**.
3. Choose **Main page sections** to select Instructor sections, or **Course pages and assets** to keep the Student main page and review other pages.
4. Select additional Markdown pages, then choose **Review output**.
5. Check every listed file and confirm before saving to the paired Student repository.

Empty standard sections are omitted; custom sections can be selected. Linked Markdown pages require explicit selection; linked assets are included automatically. Comments and attachments may contain private information, so review them too.

For legacy courses, no new Student document is written in the Instructor repository. Audience-structured courses instead keep editable candidates in their explicit `students/` root. Existing legacy files are retained. Independent Student edits and drafts are preserved through conflict review. Other terms and unrelated destination files stay unchanged.

Keep selected pages inside the term folder. Linked files in `shared/assets/` are copied into the Student term’s `assets/shared/` folder and output links are adjusted. Other cross-term links are refused. Authoring files remain unchanged.

## Deliver Student content

**Sync to GitHub ▾** offers:

- **Connect to GitHub…** links a local Student repository to an existing GitHub repository and the same branch. Connecting does not upload files.
- **Review GitHub status and Push…** checks remote history, then reviews outgoing commits before Push.
- **Prepare GitBook delivery…** reviews the complete saved Students term and its dependencies, then saves reviewed navigation/configuration and portable heading-link updates in Students. Save drafts first. Other repositories and terms are excluded.
- **Prepare Student ZIP…** uses the same term review for direct-authoring courses. The ZIP includes generated navigation/configuration and portable heading anchors without changing saved files. Optional GitBook markup conversion affects the ZIP only. Legacy courses retain their previous export controls.

Direct delivery uses the chosen Students home, every saved page/asset in that term, `SUMMARY.md` and `.gitbook.yaml`; it does not infer Instructor candidates or copy from private roots. Existing SUMMARY is retained and checked. Generated configuration points to the actual chosen home, including nested or Chinese filenames. Missing local/model dependencies, unsafe/private paths, credentials and stale reviews block preparation. Review comments and external-link warnings before sharing. Existing legacy reviewed output includes `student.md`, selected pages, assets and navigation. In GitBook Git Sync, select that term folder as the project directory. Local review does not commit, push or publish. Use selected-file commits and the reviewed Push workflow separately where available.

### Portable Chinese heading links

GitBook and GitHub generate different anchors for Chinese headings. Delivery review proposes stable ASCII anchor metadata and matching local heading links. Choose **Save delivery files** to apply the reviewed updates to Students before committing and pushing. Instructor files stay unchanged. The editor hides these inert anchor markers in Preview and Present; Markdown source retains them for portability. Repeat preparation reuses the existing anchors. Review current and proposed content before applying.

### Existing GitBook content

In **Prepare Student output**, enable **Convert GitBook HTML** to review a Markdown version of supported links, figures, tables and collapsible details. Conversion affects Student output only; Instructor files remain unchanged. Unsupported or active HTML blocks export until corrected.

Original `SUMMARY.md` groups and page order are reused for selected pages. An identical course README is represented by the Student home rather than copied twice. Review warnings for nonportable links before sharing. Inline `$$…$$` equations are supported by the technical reader; front matter stays in saved source without appearing as prose.

## Course repository roles

Open **Choose course page → Course settings** to review local Instructor, Assistant and Student repository bindings. Existing courses keep their files, calendars and Git histories. Select an existing Assistant repository or create one, review the bindings, then save them. Open a bound role to use the normal explorer.

For a reviewed local copy:

1. Save source and destination edits.
2. Choose the source and destination roles, then **Choose files**.
3. Select the pages, code, dependencies and licenses to include.
4. Review file content and destination changes, then confirm the copy.

This workflow supports Instructor → Assistant, Instructor → Student and Assistant → Student. Copies exclude Git history and do not commit, push or change GitHub permissions. Role labels describe intended visibility. Use the GitHub access check below to inspect the remote before sharing.

Linked local dependencies must be selected explicitly. Common Python, XML, OBJ and configuration files are copied as inert files. Selected `student.md` output includes GitBook navigation. The limit is 128 output files, 4 MiB per file and 32 MiB total; large model files need separate delivery. Review private information and test runnable output independently before sharing.

Other terms, unrelated files, independent destination edits and drafts are preserved. Conflicts require a fresh review. If a copy is interrupted, resolve its package recovery first, then use **Verify completed copy** or **Verify unchanged destination** in Course settings. Local-copy records are provenance, not student submission receipts.

## GitHub setup in Course settings

After saving local repository bindings, choose a role, GitHub owner and repository name. **Bind existing** connects a repository you can write to; **Create empty** creates one after a separate review. Instructor and Assistant repositories must be private. Student repositories may be private or public. Each role needs a different remote repository. Creation does not upload course files or invite anyone.

Creation requires your own GitHub account or an organization where you are an owner, and GitHub App **Administration: write** permission approved for the installation. If that permission is unavailable, bind an existing repository or ask the app owner about enabling creation.

**Observed GitHub access** shows the last check, repository identity, visibility, your permissions, listed collaborators and pending invitations. Organization owners and inherited access may also apply. This is an observation, not a guarantee that a particular staff-only policy has been configured. No invitations or access changes are made here.

If creation is interrupted, use **Recheck created repository**. It checks the existing result without creating another repository. Do not retry by creating another course.

For Student delivery, save and commit approved files, then review Push through **Sync to GitHub**. Course settings can record the GitBook space URL, Student branch and term directory. Configure Git Sync in GitBook and verify its rendered pages there; recording this mapping does not activate or verify GitBook sync.

## Course staff and repository access

In **Course settings → People**, view Instructors, Assistants and Students together with team membership and intended repository assignments. Add/edit a person or review CSV/TSV import and updates. Match by email or GitHub username; blank cells preserve saved fields and ambiguous identities stop the import. Up to 32 staff and 500 students are supported. Contact details stay in private application state, outside course files and exports.

Select people and review a local course-role, repository-permission or team-membership assignment. Existing unselected team members are retained. Connect the repository in Delivery, then **Review GitHub batch** for up to 100 saved usernames. Review numeric identities, repository and permissions before confirming. The batch stops on the first failure and reports completed and unattempted recipients; uncertain results require read-only recovery before retrying. Rejected requests show a safe diagnostic code, HTTP status and GitHub request ID when available. A `seat_limit` rejection means an organization owner must resolve collaborator seat availability; the app never purchases seats or changes repository visibility. After a definitive rejection, complete read-only inspection can clear the local intent only when the recipient’s access is unchanged. Inconclusive inspection preserves it. **Verify no grant and clear intent…** requires a separate review and never resends an invitation or removes access. Expired or consumed batch reviews must be opened again. Students can only receive Read on Students; project members receive reviewed Write on their assigned team. Personal GitHub repositories cannot grant Read-only collaborator invitations. Local assignments never revoke existing rights; observed access is a dated snapshot and inherited access may apply.

Existing higher rights, organization ownership and inherited access are preserved. An existing invitation is reported rather than resent. A new invitation may notify the recipient and remains pending until accepted. These controls do not change organization membership, remove collaborators or enforce student write restrictions.

If the response is interrupted, use **Recheck access change**. It reads GitHub without repeating the grant. If no requested grant is observable, **Verify no grant and clear intent** permits a fresh review; it does not undo a remote action. Recheck before making another grant.

GitHub organization repositories support reviewed Read and Write grants. Personal repositories support collaborator access with Write; the app refuses a new Read-only invitation before sending it. Public personal-repository content is already readable without an invitation. The app never substitutes Write for a Read request. Personal Write reviews explicitly state that the recipient can write changes.

## Private team projects

After registering course roles, open **Course settings → People → Team repositories and submissions**. Review creation of one to eight local sibling repositories for the selected term. Each starts with a brief, six worksheet placeholders, environment, code, results, poster, video and a submission manifest. Creation stays local and grants no GitHub access. Interrupted creation can resume without duplicating repositories. **Use an existing or cloned project repository** binds an unassigned sibling without copying starter files or replacing its content/history. Clone through the normal repository controls first. Rename repositories using **… → Rename repository…**; the team identity stays stable.

Choose **Manage Team01** to save team/staff GitHub usernames and milestone IDs/deadlines. Deadlines are entered in UTC and also shown in Dubai time. Changing a team's deadline supplies an extension for future receipts; earlier receipts preserve the deadline used when verified. Local membership edits do not grant or revoke access.

Review private GitHub creation/binding separately, then review Write access for each saved account. Empty remote setup uploads no files. Commit and Push remain separate. Organization project isolation requires observed base access **None**, complete owner/access inspection and no repository team grants. Unknown/inherited access blocks managed setup or grants rather than claiming isolation. Organization owners always retain access. Recheck access and reconcile accounts outside the local policy in GitHub; no automatic removal or visibility changes occur.

## Repository submissions

Students can use ordinary GitHub/Git tooling. Commit a `submission.json` manifest with schemaVersion 1, the configured milestone ID, tracked `files` and optional GitHub release `artifacts`. Every entry declares its SHA-256 and byte size. File paths are relative to the repository root. Artifacts declare numeric release asset ID, name, hash and size. Publish a GitHub release tagged `asmb-submit/<milestone>/<sequence>`, for example `asmb-submit/final/1`. A push alone is not a submission.

```json
{
  "schemaVersion": 1,
  "milestone": "final",
  "files": [{"path": "README.md", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS", "size": 123}],
  "artifacts": []
}
```

The example's hash and size are placeholders. Compute them from the exact committed bytes. At least one tracked deliverable is required. Up to 128 files of 4 MiB each and eight release assets of 64 MiB each are supported, with 240 MiB combined. Large video/checkpoint data can use those release assets; larger or other storage schemes require a separate delivery arrangement and are refused by this verifier. Repository code and weights are never executed.

In team settings, choose milestone and sequence, then **Verify submission**. Review the exact commit, release author, files, artifact hashes and server verification time. Confirmation rechecks them, archives all declared bytes privately and journals an immutable receipt. **Create snapshot review copy** imports an editable review repository while preserving the private archive unchanged.

Receipt status uses GitHub server-observed verification time against the configured deadline. GitHub publication time is also recorded, but mutable tags/publication dates do not prove when the current content was first submitted. This conservative policy can mark a receipt late when the instructor verifies it after the deadline. It is not automatic student-side timestamping. Missing releases, access failure, malformed manifests and hash mismatch do not produce completed receipts. Reproducibility is a separate review; byte verification does not prove that code runs.

Publish a new sequence to resubmit. Later commits, changed deadlines and moved tags cannot change retained receipts. Reusing a receipted tag for different content is refused. Grades and private marking stay outside project history. GitBook continues to consume only approved Student course material, separately from project submission snapshots.

## Large course workspaces

From v0.2.23, canonical Instructor and Student-candidate homes are detected directly, even when a retained runtime environment makes the repository-wide inventory incomplete. The explorer loads folders as you expand them; unopened environments do not have to be scanned before you can edit a course page. **Refresh files** reloads opened folders and saved documents while preserving drafts.

Structured course/package selections inspect their audience root. Files elsewhere in the repository remain in place. An incomplete inventory, unsafe path or unsupported dependency inside a delivery root stops the review; it does not silently produce a partial package. Existing legacy Student homes and installed asTeach packages are retained during an application update.

Course calendar remains available in the course-page dropdown while viewing Student pages. Selecting it opens the teacher’s course calendar; it does not add calendar settings to published Student content.

### Course settings workflow

Use the existing top-left sidebar button to show or hide Course settings navigation. Drag its edge to resize; Home restores the default width. Open **Repositories**, **People** or **Delivery**. Inputs are retained while switching pages.

1. **Repositories:** inspect local roles and create or bind Assistants. Students authoring and advanced recovery stay here.
2. **People:** manage contacts, batch import/update, select people and review local roles, repository assignments and team membership. Team repositories and submissions are managed here. GitHub changes require their own reviewed batch.
3. **Delivery:** connect GitHub, inspect observed access and record GitBook mapping. Connecting uploads no files. Save and commit in the editor before reviewing Push.

**Copy files between repositories** is optional and collapsed initially. Expand it to select and review a local copy. It is not required for direct Students editing. Interrupted operations remain visible for recovery. The page scrolls within the application, and connection fields stack in narrow windows.
