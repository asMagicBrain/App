import React, {useMemo} from 'react';
import './pro-editor.css';

export function ProEditorControls({source, visual, onVisualChange, disabled = false}: {
  source: string; visual: boolean; onVisualChange(value: boolean): void; disabled?: boolean;
}) {
  const statistics = useMemo(() => {
    const counts: [number, string][] = [[source.trim() ? source.trim().split(/\s+/u).length : 0, 'word'], [Array.from(source).length, 'character'], [source.split('\n').length, 'line']];
    return counts.map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`).join(' · ');
  }, [source]);
  return <div className="pro-presentation" role="group" aria-label="Editor presentation">
    <span className="pro-presentation-label">Editor</span>
    <div className="pro-presentation-options">
      <button type="button" aria-pressed={!visual} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => onVisualChange(false)}>Source</button>
      <button type="button" aria-pressed={visual} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => onVisualChange(true)}>Visual</button>
    </div>
    <span className="pro-presentation-hint">{visual ? 'Use Edit source on an equation or diagram.' : 'Edit your Markdown source.'}</span>
    <span className="pro-document-statistics" aria-label="Document statistics">{statistics}</span>
  </div>;
}
