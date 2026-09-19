import React, {useId} from 'react';
import type {DocumentOutlineEntry} from './outline-model';
import './document-outline.css';

type Props = {
  entries: readonly DocumentOutlineEntry[];
  onSelect(entry: DocumentOutlineEntry): void;
  onReturnToDocument(): void;
  activeId?: string;
  disabled?: boolean;
  documentName?: string;
  /** Compact presentation; heading depth remains accessible. */
  headingsOnly?: boolean;
  headerAction?: React.ReactNode;
};

/** A navigation panel only: the owning document decides how to reveal a heading. */
export function DocumentOutline({entries, onSelect, onReturnToDocument, activeId, disabled = false, documentName, headingsOnly = false, headerAction}: Props) {
  const headingId = useId();
  const moveFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onReturnToDocument(); return;}
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.do-entry:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next].focus();
  };
  return <aside className="do-panel" aria-labelledby={headingId} onKeyDown={moveFocus} data-available={Boolean(entries.length)}>
    <header className="do-header">
      <h2 id={headingId}>Outline</h2>
      {headerAction}
    </header>
    {documentName && !headingsOnly && <p className="do-document" title={documentName}>{documentName}</p>}
    {entries.length ? <nav className="do-navigation" aria-label="Document headings"><ol className="do-list">
      {entries.map(entry => <li key={entry.id}>
        <button className="do-entry" type="button" disabled={disabled} data-level={entry.level} data-heading-id={entry.id}
          aria-current={activeId === entry.id ? 'location' : undefined}
          title={`${entry.title} · Line ${entry.line}`} onClick={() => onSelect(entry)}>
          {!headingsOnly && <span className="do-level" aria-hidden="true">H{entry.level}</span>}<span className="do-title">{entry.title}</span>
          <span className="do-sr-only">, heading level {entry.level}, line {entry.line}</span>
        </button>
      </li>)}
    </ol></nav> : <p className="do-empty" role="status">{documentName?'No headings in this document.':'Open a Markdown document to see its outline.'}</p>}
  </aside>;
}
