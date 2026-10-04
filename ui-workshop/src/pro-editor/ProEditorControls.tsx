import {documentStatistics} from '../../../apps/desktop/ui/content-language.mjs';
import React, {useMemo} from 'react';
import './pro-editor.css';

export function ProEditorControls({source, visual, onVisualChange, disabled = false}: {
  source: string; visual: boolean; onVisualChange(value: boolean): void; disabled?: boolean;
}) {
  const statistics = useMemo(() => {
    const {words,characters,lines}=documentStatistics(source);
    const counts: [number, string][] = [[words, 'word'], [characters, 'character'], [lines, 'line']];
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
