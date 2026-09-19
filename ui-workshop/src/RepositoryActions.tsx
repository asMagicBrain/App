import React, {useRef, useState} from 'react';
import {FrameIcon} from '../../apps/desktop/ui/shared/editor-frame';
import './repository-actions.css';

type Props = {
  onNew?(): void;
  onImport(): void;
  onNewRepository?(): void;
  onSearch?(): void;
  showAgentPlaceholder?: boolean;
  /** Retained for callers of the former study toolbar. */
  designStudy?: boolean;
  onAllRepositories?(): void;
  allRepositoriesActive?: boolean;
};

export function RepositoryActions({onNew, onImport, onNewRepository, onSearch, showAgentPlaceholder=true}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const dismiss = () => {setMenuOpen(false); createTrigger.current?.focus();};
  return <div className="ra-actions" onKeyDown={event => {if (event.key === 'Escape' && menuOpen) {event.stopPropagation(); dismiss();}}}>
    <button disabled={!onSearch} className="ra-search" aria-label="Search all repositories" title="Search all repositories (/)" onClick={onSearch}><FrameIcon name="search"/><span>Type <kbd>/</kbd> to search</span></button>
    {showAgentPlaceholder&&<div className="ra-split ra-split-agent">
      <button type="button" disabled data-always-visible className="ra-icon" title="Ask agent" aria-label="Ask agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M8 12v2m8-2v2M8 19v2m8-2v2"/></svg></button>
      <button type="button" disabled data-always-visible className="ra-arrow" aria-label="Ask agent options" aria-expanded={false}><FrameIcon name="down"/></button>
    </div>}
    <span className="ra-divider"/>
    <div className="ra-split ra-split-create"><button className="ra-icon" aria-label="Create new Markdown document" title="New Markdown document" disabled={!onNew} onClick={onNew}><FrameIcon name="plus"/></button><button ref={createTrigger} className="ra-arrow" aria-label="Create new options" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><FrameIcon name="down"/></button></div>
    {menuOpen && <><button className="ra-backdrop ra-backdrop-create" aria-label="Dismiss action menu" tabIndex={-1} onClick={dismiss}/><section className="ra-menu ra-menu-create" aria-label="Create new" tabIndex={-1} ref={element => {element?.focus();}}>
      {['New Markdown file', 'New issue', 'New repository', 'Import repository', null, 'New codespace', 'New gist', null, 'New organization', 'New Project'].map((label, index) => {
        const action = label === 'New Markdown file' ? onNew : label === 'Import repository' ? onImport : label === 'New repository' ? onNewRepository : undefined;
        const unavailable = label !== 'New Markdown file' && label !== 'Import repository' && label !== 'New repository';
        return label ? <button disabled={!action} data-unavailable={unavailable || undefined} style={action ? {opacity: 1} : undefined} key={label} onClick={action ? () => {dismiss(); action();} : undefined}>{label}</button> : <hr key={index} data-unavailable/>;
      })}
    </section></>}
  </div>;
}
