import React, {useCallback, useEffect, useRef} from 'react';
import {EditorView} from '@codemirror/view';
import {DocumentOutline} from './DocumentOutline';
import {useDocumentOutlineTracking} from './useDocumentOutlineTracking';

type Props = React.ComponentProps<typeof DocumentOutline> & {
  mainWindow: React.RefObject<HTMLDivElement | null>;
  onReady?(): void;
};

/** Shared Storybook/native view: observes the existing reader/editor, never another buffer. */
export function TrackedDocumentOutline({mainWindow, onReady, ...outline}: Props) {
  const activeId = useDocumentOutlineTracking(mainWindow, outline.entries, outline.documentName);
  const panel = useRef<HTMLDivElement>(null);
  const current = useRef(outline); current.current = outline;
  const selectionFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(selectionFrame.current), []);

  const revealActive = useCallback(() => {
    const navigation = panel.current?.querySelector<HTMLElement>('.do-navigation');
    const selected = panel.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!navigation || !selected) return;
    const viewport = navigation.getBoundingClientRect(), row = selected.getBoundingClientRect();
    // Scroll only the outline list. scrollIntoView would move ancestor windows
    // and passive synchronization must not steal keyboard focus from the editor.
    if (row.top < viewport.top + 8) navigation.scrollTop += row.top - viewport.top - 8;
    else if (row.bottom > viewport.bottom - 8) navigation.scrollTop += row.bottom - viewport.bottom + 8;
  }, []);
  useEffect(revealActive, [activeId, outline.entries, revealActive]);
  // Keyboard entry waits for the first measurement so focus lands on the
  // currently visible section, rather than on a soon-to-be-hidden first row.
  useEffect(()=>{
    if(!outline.entries.length||outline.entries.some(entry=>entry.id===activeId))onReady?.();
  },[activeId,outline.entries,onReady]);
  useEffect(() => {
    const navigation = panel.current?.querySelector<HTMLElement>('.do-navigation');
    if (!navigation) return;
    const resize = new ResizeObserver(revealActive);
    resize.observe(navigation);
    return () => resize.disconnect();
  }, [Boolean(outline.entries.length), revealActive]);

  const select: Props['onSelect'] = entry => {
    if (outline.disabled || document.querySelector('dialog[open]') || !outline.entries.includes(entry)) return;
    outline.onSelect(entry);
    // Existing CM6 navigation centers its target. Align the source view
    // with Preview's top-of-section navigation so scroll tracking agrees.
    cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = requestAnimationFrame(() => {
      // A file switch, close or modal may occur before the frame is delivered.
      if (!panel.current?.isConnected || current.current.entries !== outline.entries ||
          current.current.documentName !== outline.documentName || current.current.disabled || document.querySelector('dialog[open]')) return;
      const source = mainWindow.current?.querySelector<HTMLElement>('.rfe-source:not([hidden]) .cm-editor');
      const editor = source && !source.closest('[hidden]') ? EditorView.findFromDOM(source) : null;
      if (editor) editor.dispatch({effects: EditorView.scrollIntoView(Math.min(entry.from, editor.state.doc.length), {y: 'start', yMargin: 16})});
    });
  };
  return <div className="do-tracked-content" ref={panel}><DocumentOutline {...outline} activeId={activeId} onSelect={select}/></div>;
}
