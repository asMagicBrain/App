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

Pages respects every heading depth and horizontal-rule breaks. Consecutive headings stay with their body; long paragraphs, lists and tables continue across pages, with table headers repeated and ordered-list numbering retained. Long code continues at complete line boundaries, preserving indentation. Equations, diagrams and interactive blocks retain their content. Oversized content remains scrollable when it cannot fit readably. Extremely long documents retain their remainder in a scrollable page after the pagination limit. Continuous Document remains available. In Sections mode, `#` and `##` begin sections and deeper headings stay within them. Long sections scroll. Text sizing does not modify Markdown or the editor's font settings. Text-size and reset shortcuts also work from presentation navigation buttons. Editable fields and interactive examples keep their own keyboard behavior.

The view starts near the current source/reading block. On exit, the editor reveals the corresponding source position without changing the caret or document content. Local Markdown links stay within the repository. Back restores the previous document's presentation position; Forward returns to the document you left with Back. Both are available in the temporary controls after following document links. Layout changes are tracked using source-block locations rather than a whole-document scroll percentage.

See [getting started](getting-started.md) for supported platforms.

Prose uses a bounded reading width while landscape figures can use the available screen width. Arrow navigation remains available when presentation controls have focus. Figures with a following blockquote or labelled Figure/Fig./图 paragraph caption stay together. Captions are upright and stay immediately below the figure. Heading and caption space is reserved before sizing the image. Short equations or demonstration commands stay with a following explanation when the unit fits. Longer code continues without shrinking the type; inherently oversized content stays scrollable.

Native presentation keeps rendering active while you temporarily focus another window. Leaving presentation restores the normal background rendering policy. Fullscreen entry and return wait for the native transition to finish before measuring or restoring the document.

Code blocks align with the prose column. Long single code lines remain intact and scroll horizontally within their block. Numeric table columns default to right alignment unless the Markdown already specifies alignment; labels stay left aligned. Units remain exactly as authored.

## Responsive teaching canvas

Present reserves 5.5% on each horizontal edge and 4.5% on each vertical edge, plus separate navigation space. Its default body size scales with viewport width and height: at 1280×800 it is approximately 28px, at 1920×1080 approximately 42px, and at 5120×1440 approximately 60px. These are design defaults, not projection standards. Cmd/Ctrl+0 returns to responsive sizing. Other text-size shortcuts set an explicit size for the current presentation.

Prose is centred as a column with left-aligned text, ragged right and 1.5 line spacing. MiSans typography uses a bounded measure; figures can use the wider canvas. Captions are 95% of body size. Code retains a monospace font for indentation; math retains its KaTeX glyph fonts. Neither is substituted with proportional MiSans.

Images retain their original pixels, aspect ratio and embedded lettering. Responsive layout cannot guarantee that small lettering in an existing multi-panel raster figure becomes large enough for every classroom. Dense figures may require closer inspection or a separately authored detail view. Classroom readability needs an instructor check using the actual projector, room and viewing distance.

## Inspect scientific figures

Click a figure or focus it and press Enter to inspect its original image. F opens the first figure on the current page. The detail view starts at 2× fitted size. Use +/− (or Cmd/Ctrl +/−) to zoom from 1× to 8×; 0 or Fit figure resets to 1×. Scroll or use arrow keys to pan. Esc or Back to presentation closes the detail view, restores figure focus and keeps the same page. Esc again leaves Present. Text-size commands in this view affect the image, not lecture text.

Magnification preserves the original image and lettering; it cannot recover detail missing from a low-resolution image. Dense plots may require zooming and panning during teaching. Classroom readability still needs checking on the actual projector.

## Interactive teaching

Use [inline interactive examples](interactive-examples.md) to run reviewed local controls on a presentation page. Expansion retains the same running view. Esc in its native controls returns focus to lesson navigation without resetting its values. Page/document transitions dispose the runtime; notes and source remain intact.

Long inline code commands wrap within the teaching canvas. Fenced code blocks retain their original indentation and horizontal scrolling.

## Tables and wide equations

Table headers wrap at word boundaries. Inline identifiers can wrap at separators such as underscores while retaining their complete text and monospace font. Column proportions come from the complete table and remain consistent on continued pages. A table that fits a fresh page moves there intact; longer tables continue with repeated headers and complete rows in source order.

Wide display equations fit locally to the teaching canvas where possible. Prose keeps your chosen presentation size, and Copy TeX retains the original expression. Extremely wide expressions and genuinely oversized rows remain scrollable when readable fitting is not possible.
