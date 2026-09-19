import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Stable semantic classes use the surrounding app's light/dark variables.
// The default CM6 highlight palette assumes light paper, not our warm dark UI.
export const sourceHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'source-token-heading' },
  { tag: tags.strong, class: 'source-token-strong' },
  { tag: tags.emphasis, class: 'source-token-emphasis' },
  { tag: tags.strikethrough, class: 'source-token-strike' },
  { tag: [tags.link, tags.url], class: 'source-token-link' },
  { tag: [tags.monospace, tags.string, tags.character], class: 'source-token-code' },
  { tag: [tags.keyword, tags.bool, tags.number, tags.escape], class: 'source-token-value' },
  { tag: [tags.quote, tags.list, tags.contentSeparator, tags.processingInstruction, tags.meta, tags.comment], class: 'source-token-markup' },
  { tag: tags.invalid, class: 'source-token-invalid' },
]);
