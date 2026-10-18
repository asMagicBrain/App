# Inline interactive examples

[Editor](editor.md) · [Presentation](presentation.md)

Keep an example and all its assets in the repository. An explicit fenced block places its controls inside Preview and Present:

````markdown
```asmb-interactive
{"path":"examples/rotation.artifact.json","caption":"Rotate the frame and compare coordinates.","fallback":"Use Figure 3 and the worked example if interaction is unavailable."}
```
````

`path` is relative to the Markdown document. Use a local `.artifact.json` manifest when the example uses fonts, scripts, images or data files. A self-contained `.html` file can also be used, but admits only its own bytes. Raw HTML inside Markdown remains inactive. Up to sixteen explicit blocks can be admitted per document; additional blocks show an explanation and their source.

## Read and operate

Choose **Open interactive example**, review the listed files and choose **Run interactive view**. Opening a document does not execute scripts. Run brings the canvas into view. The live view appears within the document. In Present, its display scale adapts to the available canvas width. Its own sliders, tabs, scrolling, arrow keys and Space do not advance the lesson.

**Expand example** uses more screen space while preserving the running example and its control values. **Return inline** restores the embedded view. Esc inside a running inline example returns focus to the lesson and collapses an expanded view without resetting it. In Present, lesson navigation then works without clicking the text. Esc again exits Present.

**Reset** restarts controls. **Stop**, **Source** and **Static fallback** remain available. Closing the example, leaving its presentation page, changing documents, hiding/minimizing the app or reaching the ten-minute limit disposes the runtime. Hidden scroll surfaces retain their current run while the document remains open; reopening after disposal starts a fresh run. Runtime slider values are not saved across restart, while the Markdown, assets and manifests remain saved files.

**Why did this stop?** records the native stop cause, time, run identity and window visibility state. It distinguishes a Stop request, document/page removal, switching to Source/fallback and hiding/minimizing the window. Refresh a control tool’s accessibility tree after a view changes; a stale element error by itself does not establish an application failure. Run again restarts the example.

Missing files, changed hashes, failed loading and script/resource errors appear beside the example. The caption and author-supplied fallback remain visible before activation. Keep an ordinary Markdown explanation and static figure outside the fence so other readers have useful content too.

## Portable files and isolation

A schema-1 manifest declares one HTML entry, one text fallback and every required local asset, with exact byte sizes and SHA-256 hashes. Manifest asset paths are relative to the manifest folder, cannot escape it and cannot use linked files. Place the manifest high enough to contain the HTML and its relative dependencies. Relative `../` references in the HTML may resolve to another declared file inside that folder.

Supported assets include HTML, JavaScript, CSS, JSON, SVG/images, text and WOFF2/TTF/OTF fonts. Ordinary files are limited to 2 MiB each; fonts to 16 MiB each; non-font content to 8 MiB in total; the entire snapshot to 40 MiB and 64 declared files. Retain font licences when sharing examples. MiSans used by the app does not automatically grant an example access to app files: include its permitted font assets in the manifest.

The runtime is a separate sandboxed renderer with no app bridge, credentials or unrelated repository access. Networking, workers, nested pages, permissions, popups and downloads remain blocked. Only the reviewed immutable files are served. Changed source needs regenerated hashes and another review.

Include the Markdown, HTML, scripts, fonts, fallback and manifest together in source ZIPs and GitHub delivery. Paths contain no machine-specific location. Static offline-reader exports and GitHub/GitBook readers do not run this custom block; retain ordinary static explanations and links for them. GitHub storage does not grant GitBook execution support.

The view repositions after resizing, fullscreen changes and app reactivation. “Preparing display…” means it is waiting for a safe visible area; “Scroll to view” means the running content is outside the visible document area. Ordinary HTML links open source. Use Review interactive view or an explicit interactive block to run local content after review. If opening fails, the view retains its error state and the source/static fallback remains available.
