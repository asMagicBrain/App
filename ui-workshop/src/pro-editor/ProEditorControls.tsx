import React from 'react';
import './pro-editor.css';

export function ProEditorControls({visual, onVisualChange, disabled = false}: {
  visual: boolean; onVisualChange(value: boolean): void; disabled?: boolean;
}) {
  return <div className="pro-presentation" role="group" aria-label="Pro presentation">
    <span className="pro-presentation-label">Pro Editor</span>
    <div className="pro-presentation-options">
      <button type="button" aria-pressed={!visual} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => onVisualChange(false)}>Source</button>
      <button type="button" aria-pressed={visual} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => onVisualChange(true)}>Visual</button>
    </div>
    <span className="pro-presentation-hint">{visual ? 'Use Edit source on an equation or diagram.' : 'Edit your Markdown source.'}</span>
  </div>;
}
