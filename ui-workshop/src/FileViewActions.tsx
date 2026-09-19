import React, {useCallback, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './file-view-actions.css';

type IconName = 'more' | 'download' | 'copy' | 'link' | 'agent' | 'trash' | 'check' | 'pencil' | 'code' | 'desktop' | 'space' | 'close' | 'down';
const iconPaths: Record<IconName, string> = {
  more: 'M3 8h.01M8 8h.01M13 8h.01',
  download: 'M8 1v9M4 6l4 4 4-4M2 11v4h12v-4',
  copy: 'M6 6h8v9H6ZM10 3V1H1v10h2',
  link: 'm6 10 4-4M5 6 3 8a3 3 0 0 0 5 5l2-2M6 5l2-2a3 3 0 0 1 5 5l-2 2',
  agent: 'M3 5h10v9H3ZM8 2v3M6 9h.1M10 9h.1M1 7v5M15 7v5',
  trash: 'M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 7v4M9 7v4',
  check: 'm3 8 3 3 7-7',
  pencil: 'm3 10 7-7 3 3-7 7-4 1ZM9 4l3 3',
  code: 'm5 4-4 4 4 4M11 4l4 4-4 4M9 2 7 14',
  desktop: 'M1 2h14v10H1ZM5 15h6M8 12v3',
  space: 'M1 3h5l2 2h7v5M1 3v11h7M10 10h5M12.5 7.5v5',
  close: 'm4 4 8 8M12 4l-8 8',
  down: 'm4 6 4 4 4-4Z',
};

function ActionIcon({name}: {name: IconName}) {
  return <svg viewBox="0 0 16 16" fill={name === 'down' ? 'currentColor' : 'none'} stroke={name === 'down' ? 'none' : 'currentColor'} strokeWidth={name === 'more' ? 3 : 1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}

type Position = {left: number; top: number; width: number; maxHeight: number};

function useFilePopover(preferredWidth: number) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<Position>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<'first' | 'last'>('first');
  const typeahead = useRef({text: '', time: 0});
  const id = useId();

  const dismiss = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const show = (focus: 'first' | 'last' = 'first') => {
    if (!trigger.current) return;
    firstFocus.current = focus;
    typeahead.current = {text: '', time: 0};
    setHost(trigger.current.closest<HTMLElement>('.fw-window') ?? trigger.current.parentElement);
    setPosition(undefined);
    setOpen(true);
  };

  const enabledItems = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    .filter(item => item.getClientRects().length > 0);

  useLayoutEffect(() => {
    if (!open || !host || !trigger.current || !panel.current) return;
    const place = () => {
      const anchor = trigger.current;
      const popup = panel.current;
      if (!anchor || !popup) return;
      if (!anchor.getClientRects().length) {dismiss(false); return;}
      const rect = anchor.getBoundingClientRect();
      const frame = host.matches('.fw-window') ? host.getBoundingClientRect() : {left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight};
      const left = Math.max(8, frame.left + 8), right = Math.min(window.innerWidth - 8, frame.right - 8);
      const top = Math.max(8, frame.top + 8), bottom = Math.min(window.innerHeight - 8, frame.bottom - 8);
      if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {dismiss(false); return;}
      const width = Math.max(0, Math.min(preferredWidth, right - left));
      const below = Math.max(0, bottom - rect.bottom - 4), above = Math.max(0, rect.top - top - 4);
      const height = popup.scrollHeight + 2;
      const useAbove = height > below && above > below;
      const maxHeight = useAbove ? above : below;
      setPosition({left: Math.max(left, Math.min(rect.right - width, right - width)), top: useAbove ? rect.top - 4 - Math.min(height, maxHeight) : rect.bottom + 4, width, maxHeight});
    };
    const outsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) dismiss(false);
    };
    const outsideFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) dismiss(false);
    };
    place();
    const items = enabledItems();
    (firstFocus.current === 'last' ? items.at(-1) : items[0])?.focus();
    if (!items.length) panel.current.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('focusin', outsideFocus);
    const resize = new ResizeObserver(place);
    resize.observe(host);
    resize.observe(panel.current);
    const visibility = new MutationObserver(place);
    visibility.observe(host, {attributes: true, attributeFilter: ['class']});
    return () => {
      resize.disconnect();
      visibility.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('focusin', outsideFocus);
    };
  }, [open, host, preferredWidth, dismiss]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); dismiss(); return;}
    // Return to the trigger before the browser advances to its next/previous control.
    if (event.key === 'Tab') {dismiss(); return;}
    const items = enabledItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - typeahead.current.time < 600 ? typeahead.current.text : '') + event.key.toLowerCase();
      typeahead.current = {text, time: now};
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      ordered.find(item => item.textContent?.trim().toLowerCase().startsWith(text))?.focus();
    }
  };

  const triggerProps = {
    ref: trigger,
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: () => open ? dismiss() : show(),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault(); show(event.key === 'ArrowUp' ? 'last' : 'first');}
      if (event.key === 'Escape' && open) {event.preventDefault(); event.stopPropagation(); dismiss();}
    },
  };
  const panelProps = {id, ref: panel, tabIndex: -1, onKeyDown, style: position ?? {width: preferredWidth}};
  return {open, host, triggerProps, panelProps, dismiss};
}

function MenuItem({children, icon, disabled = false, unavailable = false, checked, onClick}: {children: React.ReactNode; icon?: IconName; disabled?: boolean; unavailable?: boolean; checked?: boolean; onClick?(): void}) {
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled || unavailable} data-unavailable={unavailable || undefined} title={unavailable ? 'Not implemented in this preview' : undefined} tabIndex={-1} className="fva-item" onClick={onClick}>
    {(checked !== undefined || icon) && <span className="fva-item-icon">{checked === undefined ? icon && <ActionIcon name={icon}/> : checked && <ActionIcon name="check"/>}</span>}<span>{children}</span>
  </button>;
}

export type FileMoreActionsProps = {
  sourceOptions?: boolean;
  onCopyPath(): void;
  onDownload?(): void;
  wrap: boolean;
  onWrapChange(wrap: boolean): void;
  folding?: boolean;
  onFoldingChange?(folding: boolean): void;
  center?: boolean;
  onCenterChange?(center: boolean): void;
};

export function FileMoreActions({sourceOptions = true, onCopyPath, onDownload, wrap, onWrapChange, folding = true, onFoldingChange, center = false, onCenterChange}: FileMoreActionsProps) {
  const menu = useFilePopover(256);
  const run = (action: () => void) => {menu.dismiss(); action();};
  return <>
    <button type="button" className="rfe-icon fva-more-trigger" aria-label="More file options" title="More file options" aria-haspopup="menu" {...menu.triggerProps}><ActionIcon name="more"/></button>
    {menu.open && menu.host && createPortal(<div role="menu" aria-label="File options" className="fva-popup fva-menu" {...menu.panelProps}>
      <div className="fva-group" role="group" aria-label="Raw file content" data-unavailable={!onDownload || undefined}><h2>Raw file content</h2><MenuItem unavailable={!onDownload} onClick={() => onDownload && run(onDownload)}>Download</MenuItem></div>
      <div className="fva-group" role="group" aria-label="Copy"><MenuItem onClick={() => run(onCopyPath)}>Copy path</MenuItem><MenuItem unavailable>Copy permalink</MenuItem></div>
      <div className="fva-group" role="group" aria-label="Agent" data-unavailable><h2>Agent</h2><MenuItem unavailable>Ask about this file</MenuItem></div>
      <div className="fva-group" role="group" aria-label="View options"><h2>View options</h2>
        <MenuItem checked={folding} disabled={!sourceOptions||!onFoldingChange} onClick={() => onFoldingChange?.(!folding)}>Show code folding buttons</MenuItem>
        <MenuItem disabled={!sourceOptions} checked={wrap} onClick={() => onWrapChange(!wrap)}>Wrap lines</MenuItem>
        <MenuItem checked={center} disabled={!sourceOptions||!onCenterChange} onClick={() => onCenterChange?.(!center)}>Center content</MenuItem>
        <MenuItem checked unavailable>Open symbols on click</MenuItem>
      </div>
      <div className="fva-group" role="group" aria-label="Delete" data-unavailable><MenuItem unavailable>Delete file</MenuItem></div>
    </div>, menu.host)}
  </>;
}

export function FileEditOptions({onEdit}: {onEdit(): void}) {
  const menu = useFilePopover(192);
  return <>
    <button type="button" className="rfe-icon fva-edit-trigger" aria-label="More editing options" title="More editing options" aria-haspopup="menu" {...menu.triggerProps}><ActionIcon name="down"/></button>
    {menu.open && menu.host && createPortal(<div role="menu" aria-label="Edit file options" className="fva-popup fva-menu" {...menu.panelProps}>
      <div className="fva-group" role="group" aria-label="Edit file"><h2>Edit file…</h2><MenuItem onClick={() => {menu.dismiss(); onEdit();}}>In place</MenuItem></div>
      <div className="fva-group" role="group" aria-label="Open with" data-unavailable><h2>Open with…</h2><MenuItem unavailable>github.dev</MenuItem><MenuItem unavailable>GitHub Desktop</MenuItem></div>
    </div>, menu.host)}
  </>;
}

/** Directory actions share the existing themed, keyboard-accessible popover. */
export function DirectoryMoreActions({onCopyPath, center = false, onCenterChange}: {onCopyPath(): void; center?: boolean; onCenterChange?(value: boolean): void}) {
  const menu = useFilePopover(256);
  return <>
    <button type="button" className="rfe-icon fva-more-trigger" aria-label="More directory options" title="More directory options" aria-haspopup="menu" {...menu.triggerProps}><ActionIcon name="more"/></button>
    {menu.open && menu.host && createPortal(<div role="menu" aria-label="Directory options" className="fva-popup fva-menu" {...menu.panelProps}>
      <div className="fva-group" role="group" aria-label="Copy"><MenuItem onClick={() => {menu.dismiss(); onCopyPath();}}>Copy path</MenuItem><MenuItem unavailable>Copy permalink</MenuItem></div>
      <div className="fva-group" role="group" aria-label="Delete" data-unavailable><MenuItem unavailable>Delete directory</MenuItem></div>
      <div className="fva-group" role="group" aria-label="View options" data-unavailable={!onCenterChange || undefined}><h2>View options</h2><MenuItem checked={center} unavailable={!onCenterChange} onClick={() => onCenterChange?.(!center)}>Center content</MenuItem></div>
    </div>, menu.host)}
  </>;
}

export function DirectoryAddActions({onNewFile}: {onNewFile?(): void}) {
  const menu = useFilePopover(192);
  return <>
    <button type="button" className="rfe-directory-add" aria-label="Add file to directory" aria-haspopup="menu" disabled={!onNewFile} {...menu.triggerProps}>Add file <ActionIcon name="down"/></button>
    {menu.open && menu.host && createPortal(<div role="menu" aria-label="Add file" className="fva-popup fva-menu" {...menu.panelProps}>
      <MenuItem disabled={!onNewFile} onClick={() => {menu.dismiss(); onNewFile?.();}}>Create new file</MenuItem><MenuItem unavailable>Upload files</MenuItem>
    </div>, menu.host)}
  </>;
}

export function FileSpaceActions() {
  const chooser = useFilePopover(480);
  const titleId = useId(), noticeId = useId();
  return <>
    <button type="button" className="rfe-icon fva-space-trigger" data-unavailable aria-label="Add to space" title="Add to space" aria-haspopup="dialog" {...chooser.triggerProps}><ActionIcon name="space"/></button>
    {chooser.open && chooser.host && createPortal(<div role="dialog" aria-labelledby={titleId} aria-describedby={noticeId} className="fva-popup fva-space" data-unavailable {...chooser.panelProps}>
      <header><h2 id={titleId}>Select a space</h2><button type="button" className="fva-space-close" aria-label="Close space chooser" onClick={() => chooser.dismiss()}><ActionIcon name="close"/></button></header>
      <div className="fva-space-filter"><input disabled aria-label="Filter items" placeholder="Filter items"/></div>
      <div className="fva-space-empty"><strong>No spaces found</strong><p id={noticeId}>Spaces are not implemented in this preview.</p></div>
      <footer><button type="button" disabled>Create a new space</button></footer>
    </div>, chooser.host)}
  </>;
}
