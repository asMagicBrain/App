import React, {useEffect, useLayoutEffect, useRef} from 'react';
import './panel-resize-handle.css';

export type PanelResizeHandleProps = {
  width: number;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  collapseWidth?: number;
  onResize(width: number): void;
  onCollapse(): void;
  label: string;
  side?: 'left' | 'right';
  /** Integrated right panes resize from their left edge. */
  edge?: 'start' | 'end';
};

type Drag = {
  target: HTMLDivElement;
  panel: HTMLElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  frame: number | null;
  restoreBody(): void;
};

const SNAP_DISTANCE = 16;

/** Place inside a positioned panel whose width uses --panel-resize-width.
 * The default handle sits on the panel's right edge. edge=start reverses it.
 * Pointer movement changes only that CSS variable; React receives the final width.
 */
export function PanelResizeHandle(props: PanelResizeHandleProps) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  // Both panels can be capped by available space. Start from the visible edge.
  const renderedWidth = (panel: HTMLElement, width: number) => Math.round(panel.getBoundingClientRect().width) || width;
  const showValue = (target: HTMLDivElement, panel: HTMLElement, width: number) => {
    const visibleWidth = renderedWidth(panel, width);
    target.setAttribute('aria-valuenow', String(visibleWidth));
    target.setAttribute('aria-valuetext', `${visibleWidth} pixels${visibleWidth === callbacks.current.defaultWidth ? ', default' : ''}`);
    target.dataset.snapped = String(visibleWidth === callbacks.current.defaultWidth);
  };
  const showWidth = (target: HTMLDivElement, panel: HTMLElement, width: number) => {
    panel.style.setProperty('--panel-resize-width', `${width}px`);
    showValue(target, panel, width);
  };

  const finishDrag = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    current.restoreBody();
    current.target.removeAttribute('data-dragging');
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    showWidth(current.target, current.panel, commit ? current.width : callbacks.current.width);
    if (commit) callbacks.current.onResize(current.width);
  };

  useLayoutEffect(() => {
    const target = handle.current;
    if (target?.parentElement && !drag.current) showWidth(target, target.parentElement, props.width);
  }, [props.width, props.defaultWidth]);

  useLayoutEffect(() => {
    const target = handle.current, panel = target?.parentElement;
    if (!target || !panel) return;
    const observer = new ResizeObserver(() => showValue(target, panel, callbacks.current.width));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [props.side, props.edge]);

  useEffect(() => () => finishDrag(false), []);

  const moveDrag = (clientX: number) => {
    const current = drag.current;
    if (!current) return;
    const {defaultWidth, minWidth, maxWidth, collapseWidth, onResize, onCollapse} = callbacks.current;
    const rawWidth = current.startWidth + (clientX - current.startX) * (callbacks.current.edge === 'start' ? -1 : 1);
    if (collapseWidth !== undefined && rawWidth < collapseWidth) {
      finishDrag(false);
      onResize(defaultWidth);
      onCollapse();
      return;
    }
    current.width = Math.round(Math.max(minWidth, Math.min(maxWidth,
      Math.abs(rawWidth - defaultWidth) <= SNAP_DISTANCE ? defaultWidth : rawWidth)));
    if (current.frame === null) current.frame = requestAnimationFrame(() => {
      current.frame = null;
      if (drag.current === current) showWidth(current.target, current.panel, current.width);
    });
  };

  const {width, defaultWidth, minWidth, maxWidth, label, side = 'left', edge = 'end'} = props;
  return <div
    ref={handle}
    className={`panel-resize-handle panel-resize-handle-${side} panel-resize-edge-${edge}`}
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    aria-valuetext={`${width} pixels${width === defaultWidth ? ', default' : ''}`}
    title="Drag to resize. Double-click or Home to reset. Arrow keys resize. Enter collapses."
    onDoubleClick={() => {finishDrag(false); callbacks.current.onResize(defaultWidth);}}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        finishDrag(false);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      finishDrag(false);
      const panel = event.currentTarget.parentElement;
      const currentWidth = panel ? renderedWidth(panel, width) : width;
      if (event.key === 'Enter') callbacks.current.onCollapse();
      else callbacks.current.onResize(event.key === 'Home' ? defaultWidth : Math.max(minWidth, Math.min(maxWidth, currentWidth + (event.key === 'ArrowRight' ? 10 : -10) * (edge === 'start' ? -1 : 1))));
    }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || drag.current) return;
      const target = event.currentTarget, panel = target.parentElement;
      if (!panel) return;
      event.preventDefault();
      target.focus({preventScroll: true});
      target.setPointerCapture(event.pointerId);
      const body = target.ownerDocument.body;
      const userSelect = body.style.userSelect, webkitUserSelect = body.style.webkitUserSelect, cursor = body.style.cursor;
      body.style.userSelect = 'none';
      body.style.webkitUserSelect = 'none';
      body.style.cursor = 'col-resize';
      target.dataset.dragging = 'true';
      const startWidth = renderedWidth(panel, width);
      drag.current = {
        target, panel, pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, frame: null,
        restoreBody() {body.style.userSelect = userSelect; body.style.webkitUserSelect = webkitUserSelect; body.style.cursor = cursor;},
      };
    }}
    onPointerMove={event => {if (event.pointerId === drag.current?.pointerId) moveDrag(event.clientX);}}
    onPointerUp={event => {
      if (event.pointerId !== drag.current?.pointerId) return;
      moveDrag(event.clientX);
      finishDrag(true);
    }}
    onPointerCancel={event => {if (event.pointerId === drag.current?.pointerId) finishDrag(false);}}
    onLostPointerCapture={event => {if (event.pointerId === drag.current?.pointerId) finishDrag(false);}}
  />;
}
