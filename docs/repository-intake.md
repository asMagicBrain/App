# Bring an existing course into asMagicBrain

[User guide](README.md)

## Choose an intake method

Use **Import repository** to choose **Clone from GitHub**, **Adopt local checkout**, or **Import ZIP**. ZIP import has separate archive limits and is not a substitute for importing a large Git checkout with history.

### Clone from GitHub

Enter the repository URL and a unique local name. For private repositories, connect GitHub from the account menu and choose that account in the clone dialog. The app copies history, branches, tags and ordinary file bytes without running project hooks, filters, submodules or Git LFS downloads. LFS pointer files remain pointers.

Progress distinguishes downloading, checking files and registering the repository. You can cancel before publication. A completed durable publication wins a late cancellation, so a successfully registered repository is not removed. Interrupted transfers are retained separately for recovery; the import dialog can reveal those copies. Retry uses a new isolated transfer and never overwrites an existing repository.

Intake is bounded: up to 10,000 files, 16 GiB of working-tree bytes and 16 GiB of Git metadata, with a free-space reserve, portable-path checks and metadata-entry limits. Network transfers stop if they stall for two minutes; a two-hour ceiling also applies. These are admission limits, not a guarantee of download speed. Disk and safety checks continue during the transfer.

### Adopt a local Git checkout

Choose a unique managed repository name, then **Choose and review checkout**. The app checks that the folder is a complete, clean checkout, has a canonical GitHub origin and tracking branch, and matches the current GitHub branch. Private repositories require the connected account.

Review the original folder, GitHub destination, branch, commit, file count and size before confirming. Adoption copies the checkout into the managed workspace. It preserves saved bytes and Git history and leaves the original folder unchanged. The managed copy uses safe Git configuration instead of importing credential helpers, authorization headers or executable Git settings. No files are pushed and no people are invited.

Dirty files, untracked files, included Git configuration, links, case-colliding paths, unsupported entries or a changed review stop adoption. Preserve or reconcile the original work before reviewing again. The app does not reset branches or discard changes to make a checkout eligible.

## Existing managed course repositories

A course can keep its existing Instructor-preparation workflow while using the shared **Instructors / Assistants / Students / Projects** file panel. Opening another root does not migrate authoring mode or publish content. Each root retains its own editor session, drafts, branch and search scope. Unavailable roots stay visible.

In **Course settings → Repositories**, you can select an imported Student checkout instead of the starter Student repository, then review the role bindings. The previous repository and drafts are retained; no files are copied over either checkout.

In **Course settings → Repositories → Course repository intake**, inspect all bound role and Team checkouts together. Select the checkouts to validate, review their GitHub identities and confirm registration. Validation reads large files in bounded chunks only for this explicit intake; simply opening the course does not hash all course assets.

Large folder listings use one bounded history query instead of starting Git separately for each file. Row summaries cover recent history; older or unavailable summaries stay blank. Opening a file still reads its own path history. Listing a folder does not load its binary assets. Small explorer trees fit their contents; large trees use the available panel height with virtual scrolling. Drag the explorer separator to resize it.

Already managed checkouts are registered in place: files, history, calendars, People and role bindings remain unchanged. Partial success is recorded privately. After interruption or restart, inspect again and review the remaining checkouts; completed bindings are not lost or automatically repeated. Missing repositories must first be imported and bound through their reviewed setup controls.

## Connection states

- **Recorded local remote:** the checkout has an origin URL. This alone does not authorize app network operations.
- **Verified repository binding:** the app has reviewed and recorded the repository identity. This persists independently of sign-in.
- **Account authorization:** GitHub currently authorizes network operations. Reconnect from the account menu when this session is unavailable or expired.

Repository import does not create GitHub repositories, change permissions, import People, push content or publish to GitBook. Those remain separate reviewed actions.

## Optional Students authoring adoption

Use **Students authoring → Advanced authoring and recovery** only if you want to change the authoring workflow. The shared explorer does not require this change.

Inspection discovers Markdown paths from repository metadata. Review reads only the selected Student homes and checks repository identities, bindings, Git state and drafts before applying the private workflow record. Unrelated large images and data remain opaque entries. Selected homes are bounded to 1 MiB. Existing publication/export operations retain their own file and total-size limits; accepting a local asset does not imply it can be exported through every delivery path.
