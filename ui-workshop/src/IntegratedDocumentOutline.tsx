import React, {useRef} from 'react';
import {FrameIcon} from '../../apps/desktop/ui/shared/editor-frame';
import {PanelResizeHandle} from './PanelResizeHandle';
import {TrackedDocumentOutline} from './TrackedDocumentOutline';
import type {OutlineState} from './workspace-navigation';
import './integrated-document-outline.css';

const emptyEntries: OutlineState['entries'] = [];
type Props = {
  mainWindow: React.RefObject<HTMLDivElement | null>;
  outline: OutlineState | null;
  width: number;
  disabled?: boolean;
  onResize(width: number): void;
  onClose(): void;
  onReturnToDocument(): void;
  onReady(): void;
};

/** A normal pane in the existing renderer, sharing its document and modal scope. */
export function IntegratedDocumentOutline({mainWindow,outline,width,disabled=false,onResize,onClose,onReturnToDocument,onReady}: Props) {
  const latest=useRef({outline,disabled});latest.current={outline,disabled};
  return <div className="ido-panel" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onReturnToDocument();}}} style={{'--panel-resize-width':`${width}px`} as React.CSSProperties}>
    <TrackedDocumentOutline mainWindow={mainWindow} headingsOnly disabled={disabled} onReady={onReady}
      entries={outline?.entries??emptyEntries} documentName={outline?.documentName}
      onSelect={entry=>{
        const current=latest.current;
        if(current.disabled||document.querySelector('dialog[open]')||!current.outline?.entries.includes(entry))return;
        current.outline.onSelect(entry);
      }}
      onReturnToDocument={onReturnToDocument}
      headerAction={<button type="button" className="fw-icon ido-close" aria-label="Close document outline" title="Close document outline" onClick={onClose}><FrameIcon name="close"/></button>}/>
    <PanelResizeHandle width={width} defaultWidth={240} minWidth={180} maxWidth={480} collapseWidth={140}
      label="Resize document outline" side="right" edge="start" onResize={onResize} onCollapse={onClose}/>
  </div>;
}
