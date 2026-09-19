# GitHub comparison and clean Apply

[User guide](../../docs/accounts-and-privacy.md#github-acquisition-and-updates)

## Check updates

**Check GitHub updates…** is available for managed GitHub acquisitions on their acquired working branch. Eligibility and destination come from validated provenance, not arbitrary `.git/config` URLs.

Opening the dialog reads local metadata and any prior result. **Check for updates** starts network access. It leaves working files, drafts, HEAD, index, FETCH_HEAD, refs, and config unchanged, with the editor still mounted.

Results distinguish up-to-date, GitHub ahead, local ahead, diverged, unrelated, local empty, and missing remote branch. Comparisons use committed tips; saved edits and drafts are excluded. Renames may appear as delete/add. Changed local tips/branches make results stale. Failed or cancelled checks preserve the last complete result and timestamp.

## Isolate acquisition

Each check starts fresh private bare storage. Network acquisition completes before local history is copied into it offline. Never negotiate over the network using a cache containing local-only commits.

Git disables inherited configuration, credential helpers, hooks, filters, prompts, redirects, submodules, and maintenance. The host chooses executable, branch, roots, and canonical HTTPS destination. The renderer supplies no tokens or arbitrary Git arguments.

Bounds: 10,000 changed paths, 16 MiB command output, 2 GiB/100,000 comparison-metadata entries, and ten minutes. Display shows at most 1,000 paths and marks partial results; text preview allows 4 MiB per side. Metadata size is checked after acquisition, not as a streaming network quota.

## Review and apply

A complete **GitHub ahead** result can offer **Review update…**. Review checkpoints content drafts and verifies branch, HEAD, saved source, index, and private drafts without saving or discarding. Resolve filename intent and composition first.

Apply requires an exact unexpired review and a strictly descending clean fast-forward. It uses acquired objects offline. Saved/staged changes, untracked/ignored extras, empty extra folders, and retained drafts block Apply; index flags cannot hide byte changes. It does not fetch, merge, rebase, stash, push, or resolve conflicts.

Review expires after five minutes. Apply allows 1,000 complete changed paths, 10,000 files per tree, and 20,000 physical scan entries. Only admitted regular/executable files are accepted; symlinks, submodules, unsafe/colliding names, and directory/file transitions are unsupported. Pack and staged blobs each have a 2 GiB limit and ten-minute deadline.

## Publish and recover

The host revalidates review, stages blobs/index privately, records durable intent, imports objects offline, takes an owned index lock, and publishes files while retaining predecessors. It verifies target bytes, compare-and-swaps the branch, publishes the index/receipt, and reloads the clean file or surviving folder.

These steps are not one atomic filesystem/ref transaction. Journals bind hashes, modes, identities, objects, and index snapshots. No hooks or checkout filters run. Completed private evidence currently accumulates; automatic pruning is deferred.

After durable intent, uncertain interruption triggers recovery. Restart rolls forward recognized states; unexpected bytes, identities, or locks preserve data and hold that repository. Other repositories remain available. There is no destructive reset. Normal close drains admitted work.

## Verify

Use focused host review/core/coordinator tests and exact-package acceptance. `github-updates.mjs` and `github-apply.mjs` may contact public GitHub; lifecycle companions use labelled deterministic interception. Authorize network campaigns and use disposable repositories. See [native acceptance](acceptance/README.md).
