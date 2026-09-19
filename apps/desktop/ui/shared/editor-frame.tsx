import type React from 'react';
import './editor-frame.css';

export type EditorTab = { id: string; name: string; dirty?: boolean };
export type FrameIconName = 'left' | 'right' | 'folder' | 'search' | 'plus' | 'file' | 'close' | 'more' | 'person' | 'down';
export function FrameIcon({ name }: { name: FrameIconName }) {
  const paths: Record<FrameIconName, React.ReactNode> = {
    left: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
    right: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z"/>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    file: <><path d="M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    person: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
    down: <path d="m6 9 6 6 6-6"/>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function FrameButton({ name, label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { name: FrameIconName; label: string }) {
  return <button type="button" className="ws-icon-button" title={label} aria-label={label} {...props}><FrameIcon name={name}/></button>;
}

/** Native uses real macOS traffic lights; Storybook supplies simulated controls.
 * No persistence, account or window authority belongs to this presentation. */
export function EditorTitlebar({ tabs, active, drawer, outline, onSelect, onCloseTab, onNew,
  onToggleFiles, onToggleOutline, windowControls, disabled = false, filesDisabled = false, outlineDisabled = false }: {
  tabs: EditorTab[]; active: string; drawer: boolean; outline: boolean;
  onSelect(id: string): void; onCloseTab(id: string): void; onNew(): void;
  onToggleFiles(): void; onToggleOutline(): void; windowControls?: React.ReactNode; disabled?: boolean; filesDisabled?: boolean; outlineDisabled?: boolean;
}) {
  return <header className="ws-titlebar">
    {windowControls ?? <div className="ws-native-traffic-space" aria-hidden="true"/>}
    <FrameButton name="left" label="Toggle file sidebar" disabled={filesDisabled} aria-expanded={drawer} onClick={onToggleFiles}/>
    <nav className="ws-tabs" aria-label="Open documents">
      {tabs.map(item => <div key={item.id} className={`ws-tab ${item.id === active ? 'ws-selected-tab' : ''}`}>
        <button className="ws-tab-name" title={item.name} disabled={disabled} aria-current={item.id === active ? 'page' : undefined} onClick={() => onSelect(item.id)}><span>{item.name}</span>{item.dirty && <span className="ws-dirty" aria-label="Unsaved changes">●</span>}</button>
        <FrameButton name="close" disabled={disabled} label={`Close ${item.name} tab; keep draft`} onClick={() => onCloseTab(item.id)}/>
      </div>)}
    </nav>
    <FrameButton name="plus" label="New document" disabled={disabled} onClick={onNew}/>
    <span className="ws-brand">asMagicBrain</span>
    <FrameButton name="right" label="Toggle document outline" disabled={outlineDisabled} aria-expanded={outline} onClick={onToggleOutline}/>
  </header>;
}
export function WorkspaceRail({ drawer, searching, profileOpen, onFiles, onSearch, onProfile, profileRef, bottomSlot, searchDisabled = false, filesDisabled = false, profileDisabled = false }: {
  drawer: boolean; searching: boolean; profileOpen: boolean; onFiles(): void; onSearch(): void; onProfile(): void;
  bottomSlot?: React.ReactNode; profileRef?: React.Ref<HTMLButtonElement>; searchDisabled?: boolean; filesDisabled?: boolean; profileDisabled?: boolean;
}) {
  return <nav className="ws-rail" aria-label="Workspace tools">
    <FrameButton name="folder" label="Files" disabled={filesDisabled} aria-pressed={drawer && !searching} onClick={onFiles}/>
    <FrameButton name="search" label="Search documents" disabled={searchDisabled} aria-pressed={drawer && searching} onClick={onSearch}/>
    <div className="ws-rail-spacer"/>{bottomSlot}
    <button ref={profileRef} className="ws-profile-button" disabled={profileDisabled} aria-label="Profile and account" aria-expanded={profileOpen} title="Profile & account" onClick={onProfile}><FrameIcon name="person"/></button>
  </nav>;
}
