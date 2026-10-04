# Present a Markdown document

Open a Markdown file and click **Present**, or press **Command+Shift+P** on Mac (**Ctrl+Shift+P** on Linux). Presentation is built into the editor; no plugin is required. The current document session remains open.

Presentation fills the screen without the application bars. Use the trackpad or mouse wheel to scroll. Text, tables and local media use the available width. Interactive artifacts are not automatically activated.

| Key | Action |
| --- | --- |
| Command/Ctrl + `+` or `=` | Increase presentation text size. |
| Command/Ctrl + `-` | Decrease presentation text size. |
| Command/Ctrl + `0` | Reset text size. |
| `M` | Switch continuous Document and heading-based Sections modes. |
| Left/Right | Previous/next section in Sections mode. |
| `?` | Show temporary controls and Back after following a document link. |
| Esc | Close temporary controls, then return to the editor. |

`#` and `##` headings begin sections; deeper headings remain within their section. Long sections scroll. Text sizing does not modify Markdown or the editor's font settings. Shortcuts yield to focused links and controls.

The view starts near the current source/reading block. On exit, the editor reveals the corresponding source position without changing the caret or document content. Local Markdown links stay within the repository. Back restores the previous document's presentation position. Layout changes are tracked using source-block locations rather than a whole-document scroll percentage.

See [getting started](getting-started.md) for supported platforms.
