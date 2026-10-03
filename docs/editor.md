# Editor

The editor is included in asMagicBrain. No plugin installation is required.

- **Source** shows your Markdown. **Visual** displays supported equations and Mermaid diagrams in place; select **Edit source** to change one.
- **Insert → Math** and **Insert → Diagram** add a starting example at your selection.
- **Split** shows the editor and a live preview with synchronized scrolling.
- Unsupported Markdown stays available as source. Save and Git commits remain separate.

Math and Mermaid reading is included.

### Formatting and completion

An editable Markdown document has a formatting toolbar in Source, Visual and Split. Formatting changes the same draft and can be undone. Read-only documents do not offer these controls.

On macOS use Command; on Linux use Ctrl:

| Action | Shortcut |
| --- | --- |
| Bold / italic / inline code | Command or Ctrl + B / I / E |
| Link | Command or Ctrl + K |
| Numbered / bullet list | Command or Ctrl + Shift + 7 / 8 |
| Quote | Command or Ctrl + Shift + . |
| Heading 1–6 / paragraph | Command or Ctrl + 1–6 / 0 |

Use **Insert** for tables, tasks, links, images, code, equations or diagrams. Type `/table`, `/task` or another snippet name on an otherwise empty line to see suggestions. **Tab** accepts a suggestion and moves through snippet fields; **Escape** dismisses suggestions. Enter keeps its ordinary editing behavior. **Suggestions** or **Ctrl+Space** opens the list manually; use the button if the operating system reserves that shortcut.

After three backticks, choose a code-fence language. Inside `[text](` or `![description](`, choose a repository file; the inserted path is relative to the current document, with special characters encoded. Image suggestions are filtered to supported image filename types. Suggestions use the repository's current file listing and work offline. They do not provide programming-language intelligence inside code blocks or generate content with AI.

### Tables

Use `<br>` inside a table cell for a line break, for example `Oct 20: Class 01<br>ClassContent`. Only plain breaks are supported; other HTML remains text. Table columns size automatically, preserve whole words, and scroll horizontally when necessary. Spaces and separator dashes do not set column widths.

### Local interactive views

Open a local `.html` file or `.artifact.json` package and choose **Review interactive view**. Review the listed files, then choose **Run interactive view**. Nothing runs just because you open a repository.

The view runs inside the app with network, account access, popups and downloads blocked. **Stop**, **Source** and **Static fallback** keep a reading option available. **Reset** restarts the example and its controls without changing your files. Closing the view disposes it.

Standalone HTML can use its own embedded code. Additional local scripts and images need a manifest listing their hashes. Changed content needs another review. One interactive view can run at a time, for up to ten minutes. WebGL depends on the computer's graphics support; source and static fallback remain available when it cannot run.

Viewing state is not saved between runs. Workers, WebRTC, remote resources and physics/WASM engines are unsupported. [Offline reading exports](packages-and-export.md) keep interactive HTML as inactive source.


## Markdown comments

Select text and press **⌘ /** on Mac or **Ctrl /** on Linux to toggle a comment:

```markdown
<!-- This note stays in the Markdown source. -->
```

Comments are hidden in Preview, Split preview and offline reading pages. Source and Visual editing keep them available to edit. Commented headings do not appear in the outline. Syntax inside code examples stays visible.

Close each comment with `-->`; an unfinished comment beginning a line hides the remaining block from Preview. Comments remain in saved Markdown and exported source files, so they are not private when you share those files.
