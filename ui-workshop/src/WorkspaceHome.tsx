import {documentationLast} from './repository-capabilities.mjs';
import React, {useLayoutEffect, useRef, useState} from 'react';
import type {ApplicationAccountState} from './native-types';
import type {RepositoryCatalogEntry} from './repository-catalog';
import './workspace-home.css';

export type WorkspaceHomeProps = {
  view: 'home' | 'organization';
  repositories: RepositoryCatalogEntry[];
  catalogLoading?: boolean;
  catalogError?: string;
  onRetry?(): void;
  currentRepository: string;
  onOpenRepository(name: string): void;
  onReturnToRepository(): void;
  onNewRepository?(): void;
  onImport?(): void;
  applicationStatus?: ApplicationAccountState | null;
  applicationLoading?: boolean;
  applicationBusy?: boolean;
  applicationError?: string;
  onSignIn?(): void;
  onProfile?(): void;
  onRefresh?(): void;
};

function HomeIcon({kind}: {kind: 'account' | 'repository'}) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'account'
      ? <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>
      : <><path d="M5 3h14v18l-4-2-3 2v-5H5Z M5 16V3 M8 7h8"/></>}
  </svg>;
}

export function WorkspaceHome({view, repositories, catalogLoading = false, catalogError = '', onRetry,
  currentRepository, onOpenRepository, onReturnToRepository, onNewRepository, onImport,
  applicationStatus, applicationLoading = false, applicationBusy = false, applicationError = '',
  onSignIn, onProfile, onRefresh}: WorkspaceHomeProps) {
  const [query, setQuery] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    setQuery('');
    heading.current?.focus();
  }, [view]);
  const search = query.trim().toLocaleLowerCase();
  const matching = documentationLast(repositories).filter(repository => repository.name.toLocaleLowerCase().includes(search));
  const account = applicationStatus?.account;
  const accountBusy = applicationLoading || applicationBusy;
  const accountError = applicationError || applicationStatus?.error;
  const accountState = applicationBusy ? 'Updating account…' : applicationLoading ? 'Loading account…'
    : applicationStatus?.state === 'offline' ? 'Account offline'
    : applicationStatus?.state === 'expired' ? 'Session expired'
    : !applicationStatus?.configured || applicationStatus.state === 'unavailable' ? 'App sign-in is unavailable'
    : account ? 'Signed in' : 'Not signed in';
  const canSignIn = Boolean(onSignIn && applicationStatus?.configured
    && (applicationStatus.providers.github || applicationStatus.providers.email));
  const needsSignIn = !account || applicationStatus?.state === 'expired';
  const needsRefresh = Boolean(accountError || applicationStatus?.state === 'offline' || applicationStatus?.state === 'unavailable');
  return <section className="wh-view" data-view={view} aria-labelledby="wh-heading">
    <div className="wh-content">
      <header className="wh-heading-row">
        <div>
          <h1 id="wh-heading" ref={heading} tabIndex={-1}>{view === 'home' ? 'Home' : 'asMagicBrain'}</h1>
          <p>{view === 'home' ? 'Open a local repository to continue.' : 'Local organization'} <span className="wh-device">On this device</span></p>
        </div>
        <button type="button" className="wh-button wh-return" onClick={onReturnToRepository}>Return to {currentRepository}</button>
      </header>

      {view === 'home' && <section className="wh-account" aria-labelledby="wh-account-heading" aria-busy={accountBusy}>
        <span className="wh-account-icon"><HomeIcon kind="account"/></span>
        <div className="wh-account-copy">
          <h2 id="wh-account-heading">asMagicBrain account</h2>
          {account && <><strong className="wh-account-name">{account.displayName || account.email || 'asMagicBrain account'}</strong>{account.email && <p>{account.email}</p>}</>}
          <p className="wh-account-status" role="status">{accountState}</p>
          {account && applicationStatus?.persistence === 'session' && (applicationStatus.state === 'signed-in' || applicationStatus.state === 'offline') && <p className="wh-account-local">You stay signed in until you quit asMagicBrain.</p>}
          {applicationStatus?.notice && <p className="wh-notice">{applicationStatus.notice}</p>}
          {accountError && <p className="wh-error" role="alert">{accountError}</p>}
          {!account && <p className="wh-account-local">Local repositories are available without signing in.</p>}
        </div>
        <div className="wh-account-actions">
          {account && onProfile && <button type="button" className="wh-button" disabled={accountBusy} onClick={onProfile}>Profile</button>}
          {needsSignIn && canSignIn && <button type="button" className="wh-button" disabled={accountBusy} onClick={onSignIn}>{applicationStatus?.state === 'expired' ? 'Sign in again' : 'Sign in to asMagicBrain'}</button>}
          {needsRefresh && onRefresh && <button type="button" className="wh-button" disabled={accountBusy} onClick={onRefresh}>Retry account connection</button>}
        </div>
      </section>}

      <section className="wh-repositories" aria-labelledby="wh-repositories-heading" aria-busy={catalogLoading}>
        <div className="wh-repositories-heading">
          <h2 id="wh-repositories-heading">{view === 'home' ? 'Local repositories' : 'Repositories'} <span className="wh-count">{repositories.length}</span></h2>
          <div className="wh-repository-actions">
            {onNewRepository && <button type="button" className="wh-button" onClick={onNewRepository}>New repository</button>}
            {onImport && <button type="button" className="wh-button" onClick={onImport}>Import repository</button>}
          </div>
        </div>
        <label className="wh-search"><span>Search local repositories</span><input type="search" aria-label="Search local repositories" placeholder="Find a repository…" value={query} onChange={event => setQuery(event.target.value)}/></label>
        {catalogLoading && <p className="wh-feedback" role="status">Loading repositories…</p>}
        {catalogError && <div className="wh-feedback wh-error" role="alert"><p>{catalogError}</p>{onRetry && <button type="button" className="wh-button" disabled={catalogLoading} onClick={onRetry}>Retry repositories</button>}</div>}
        {matching.length > 0 && <ul className="wh-repository-list">{matching.map(repository => <li key={repository.name}>
          <button type="button" className="wh-repository" aria-label={`Open repository ${repository.name}`} data-current={repository.name === currentRepository || undefined} onClick={() => onOpenRepository(repository.name)}>
            <HomeIcon kind="repository"/><span className="wh-repository-name">{repository.name}</span>{repository.name === currentRepository && <span className="wh-current">Current repository</span>}<span className="wh-open" aria-hidden="true">→</span>
          </button>
        </li>)}</ul>}
        {!matching.length && !catalogLoading && !catalogError && <p className="wh-empty" role="status">{search ? 'No repositories match your search.' : 'No local repositories yet.'}</p>}
      </section>
    </div>
  </section>;
}
