# Present a Markdown document

Open a Markdown file and click **Present**, or press **Command+Shift+P** on Mac (**Ctrl+Shift+P** on Linux). Presentation is built into the editor; no plugin is required. The current document session remains open.

Presentation fills the screen without the application bars. Pages is the default view. Use Left/Right, Page Up/Down or Space to move between pages. Text, tables and local media use the available width. Interactive artifacts are not automatically activated.

| Key | Action |
| --- | --- |
| Command/Ctrl + `+` or `=` | Increase presentation text size. |
| Command/Ctrl + `-` | Decrease presentation text size. |
| Command/Ctrl + `0` | Reset text size. |
| `M` | Cycle Pages, continuous Document and heading-based Sections. |
| Left/Right | Previous/next page, or section in Sections mode. |
| Page Up/Down; Space / Shift+Space | Previous/next page; Space advances and Shift+Space goes back. |
| Home/End | First/last page in Pages mode. |
| `?` | Show temporary controls and Back after following a document link. |
| Esc | Close temporary controls, then return to the editor. |

Pages respects every heading depth and horizontal-rule breaks. Consecutive headings stay with their body; long paragraphs, lists and tables continue across pages, with table headers repeated and ordered-list numbering retained. Code, equations, diagrams and interactive blocks stay intact; oversized blocks remain scrollable instead of being clipped or shrunk. Extremely long documents retain their remainder in a scrollable page after the pagination limit. Continuous Document remains available. In Sections mode, `#` and `##` begin sections and deeper headings stay within them. Long sections scroll. Text sizing does not modify Markdown or the editor's font settings. Shortcuts yield to focused links and controls.

The view starts near the current source/reading block. On exit, the editor reveals the corresponding source position without changing the caret or document content. Local Markdown links stay within the repository. Back restores the previous document's presentation position. Layout changes are tracked using source-block locations rather than a whole-document scroll percentage.

See [getting started](getting-started.md) for supported platforms.

Prose uses a bounded reading width while landscape figures can use the available screen width. Arrow navigation remains available when presentation controls have focus. Figures with a following Markdown blockquote caption stay together where possible. Equations and code blocks remain intact; oversized content scrolls instead of being truncated.

Native presentation keeps rendering active while you temporarily focus another window. Leaving presentation restores the normal background rendering policy. Fullscreen entry and return wait for the native transition to finish before measuring or restoring the document.

Code blocks align with the prose column. Long code lines remain intact and scroll horizontally within their block.
