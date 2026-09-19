import React, {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {authorFieldError, type CommitAuthorMode, type CommitPreferences, type CommitPreferencesInput} from './commit-preferences';
import type {ApplicationAccountState} from './native-types';
import './account-controls.css';

/** Display data only. Preview accounts never supply commit-author preferences. */
export type AccountDisplay = {username: string; displayName?: string; email?: string | null; preview?: boolean};
type ApplicationControls = {
  status: ApplicationAccountState | null;
  loading: boolean;
  busy: boolean;
  error: string;
  onSignIn?(): void;
  onSignOut?(): void;
  onProfile?(): void;
  onRefresh(): void;
};
export type AccountControlsProps = {
  preferences: CommitPreferences | null;
  loading: boolean;
  error: string;
  onReload(): void;
  onSave(next: CommitPreferencesInput): Promise<void>;
  settingsRequest: number;
  onAppearance(): void;
  application?: ApplicationControls;
  account?: AccountDisplay;
  connectedIdentity?: {name: string; email: string | null};
  connectionStatus?: string;
  accountBusy?: boolean;
  signInLabel?: string;
  signOutLabel?: string;
  allowDisconnect?: boolean;
  onSignIn?(): void;
  onSignOut?(): void;
  onSettingsClose?(): void;
  initialSettingsOpen?: boolean;
  initialMenuOpen?: boolean;
};

type IconName = 'person' | 'status' | 'repository' | 'star' | 'gist' | 'organization' | 'enterprise' | 'heart' | 'settings' | 'agent' | 'flask' | 'appearance' | 'accessibility' | 'signout';
const iconPaths: Record<IconName, string> = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  status: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 14a5 5 0 0 0 8 0M8 9h.01M16 9h.01',
  repository: 'M5 3h14v18H6a3 3 0 0 1 0-6h13M5 3v15M8 7h7',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  gist: 'M7 2h7l4 4v16H7ZM14 2v5h4M10 11l-2 2 2 2M14 11l2 2-2 2',
  organization: 'M3 21V6h11v15M14 10h7v11M1 21h22M7 10h3M7 14h3M7 18h3M17 14h1M17 18h1',
  enterprise: 'M8 21V3h9v18M3 21V11h5M17 8h4v13M1 21h22M11 7h3M11 11h3M11 15h3',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 1v4l-2 1 1 3-2 3-3-1-1 5h-4l-1-3-3-1-3-1v-4l2-1-1-3 2-3 3 1Z',
  agent: 'M8 4h8v3H8ZM5 8h14a2 2 0 0 1 2 2v9H3v-9a2 2 0 0 1 2-2ZM8 12v2M16 12v2M9 17h6',
  flask: 'M9 2h6M10 2v7L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 9V2M7 15h10',
  appearance: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 3v18',
  accessibility: 'M14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM4 8l8 2 8-2M12 10v5M8 22l4-7 4 7',
  signout: 'M10 3H4v18h6M8 12h13M17 8l4 4-4 4',
};
function AccountIcon({name}: {name: IconName}) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}

const profileItems: {label: string; icon: IconName}[] = [
  {label: 'Repositories', icon: 'repository'},
  {label: 'Stars', icon: 'star'}, {label: 'Gists', icon: 'gist'},
  {label: 'Organizations', icon: 'organization'}, {label: 'Enterprises', icon: 'enterprise'},
  {label: 'Sponsors', icon: 'heart'},
];
function MenuItem({children, icon, unavailable = false, disabled = false, onSelect}: {children: React.ReactNode; icon: IconName; unavailable?: boolean; disabled?: boolean; onSelect?(): void}) {
  return <DropdownMenu.Item className="ac-menu-item" disabled={unavailable || disabled} data-unavailable={unavailable || undefined}
    onSelect={onSelect} title={unavailable ? 'Not available in this local workspace' : undefined}>
    <AccountIcon name={icon}/><span>{children}</span>
  </DropdownMenu.Item>;
}

export function AccountControls({preferences, loading, error, onReload, onSave, settingsRequest, onAppearance, application, account, connectedIdentity, connectionStatus, accountBusy = false, signInLabel = 'Sign in', signOutLabel = 'Sign out', allowDisconnect = false, onSignIn, onSignOut,
  onSettingsClose, initialSettingsOpen = false, initialMenuOpen = false}: AccountControlsProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(initialMenuOpen && !initialSettingsOpen && settingsRequest === 0);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen || settingsRequest > 0);
  const lastRequest = useRef(settingsRequest);
  const handingOffFocus = useRef(false);
  const canSignOut = Boolean(onSignOut && !account?.preview && (account || allowDisconnect));
  const appAccount = application?.status?.account;
  const appStatus = application?.busy ? 'Updating account…' : application?.error || application?.status?.notice || application?.status?.error || (application?.loading ? 'Loading account…' : application?.status?.state === 'offline' ? 'Account offline · reconnect to update' : application?.status?.state === 'expired' ? 'Session expired · sign in again' : application && (application.status?.state === 'unavailable' || !application.status?.configured) ? 'App sign-in is unavailable' : '');
  useLayoutEffect(() => {setHost(trigger.current?.closest<HTMLElement>('.fw-window') ?? null);}, []);
  useEffect(() => {
    if (lastRequest.current === settingsRequest) return;
    lastRequest.current = settingsRequest;
    handingOffFocus.current = true;
    setMenuOpen(false);
    setSettingsOpen(true);
  }, [settingsRequest]);
  const openSettings = () => {handingOffFocus.current = true; setMenuOpen(false); setSettingsOpen(true);};
  const closeSettings = () => {setSettingsOpen(false); onSettingsClose?.();};
  return <>
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="fw-icon ac-trigger" title="Account menu" aria-label="Account menu"><AccountIcon name="person"/></button></DropdownMenu.Trigger>
      {host && <DropdownMenu.Portal container={host}>
        <DropdownMenu.Content className="ac-menu" aria-label="Account" side="right" align="end" sideOffset={8} collisionBoundary={host} collisionPadding={8} loop
          onKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => {if (handingOffFocus.current) {event.preventDefault(); handingOffFocus.current = false;}}}>
          <DropdownMenu.Label className="ac-profile">
            <span className="ac-avatar"><AccountIcon name="person"/></span>
            <span className="ac-profile-text"><strong>{application ? appAccount?.displayName || appAccount?.email || 'Not signed in' : account ? account.username : 'Not signed in'}</strong>
              {application ? <><span>{appAccount ? 'asMagicBrain account' : 'Local workspace'}</span>{appAccount?.email && <span>{appAccount.email}</span>}{appStatus && <span role="status">{appStatus}</span>}</> : <>
                {account?.displayName ? <span>{account.displayName}</span> : !account && <span>Local workspace</span>}
                {account?.email && <span>{account.email}</span>}
                {account?.preview && <span className="ac-preview-label">Signed-in preview</span>}
                {connectionStatus && <span>{connectionStatus}</span>}
              </>}
            </span>
          </DropdownMenu.Label>
          {application ? <>
            {(!appAccount || application.status?.state === 'expired') && <MenuItem icon="person" disabled={application.busy || application.loading || !application.onSignIn} onSelect={application.onSignIn ? () => {handingOffFocus.current = true; application.onSignIn?.();} : undefined}>{application.status?.state === 'expired' ? 'Sign in again' : 'Sign in to asMagicBrain'}</MenuItem>}
            {(application.error || application.status?.state === 'offline' || application.status?.state === 'unavailable') && <MenuItem icon="status" disabled={application.busy || application.loading} onSelect={application.onRefresh}>Retry account connection</MenuItem>}
          </> : !account && <MenuItem icon="person" disabled={accountBusy || !onSignIn} onSelect={onSignIn ? () => {handingOffFocus.current = true; onSignIn();} : undefined}>{signInLabel}</MenuItem>}
          <DropdownMenu.Group data-unavailable><MenuItem icon="status" unavailable>Set status</MenuItem><DropdownMenu.Separator className="ac-menu-separator"/></DropdownMenu.Group>
          <MenuItem icon="person" disabled={application?.busy || !application?.onProfile} onSelect={application?.onProfile ? () => {handingOffFocus.current = true; application.onProfile?.();} : undefined}>Profile</MenuItem>
          <DropdownMenu.Group data-unavailable>{profileItems.map(item => <MenuItem key={item.label} icon={item.icon} unavailable>{item.label}</MenuItem>)}<DropdownMenu.Separator className="ac-menu-separator"/></DropdownMenu.Group>
          {application && <DropdownMenu.Group className="ac-github-connection" aria-label="GitHub connection">
            <DropdownMenu.Separator className="ac-menu-separator"/>
            <DropdownMenu.Label className="ac-connection-label"><strong>GitHub connection</strong><span>{account ? account.username : 'Not connected'}</span>{connectionStatus && <span role="status">{connectionStatus}</span>}</DropdownMenu.Label>
            {!account && <MenuItem icon="repository" disabled={accountBusy || !onSignIn} onSelect={onSignIn ? () => {handingOffFocus.current = true; onSignIn();} : undefined}>{signInLabel}</MenuItem>}
            {canSignOut && <MenuItem icon="signout" disabled={accountBusy} onSelect={onSignOut}>{signOutLabel}</MenuItem>}
            <DropdownMenu.Separator className="ac-menu-separator"/>
          </DropdownMenu.Group>}
          <DropdownMenu.Group>
            <MenuItem icon="settings" onSelect={openSettings}>Settings</MenuItem>
            <MenuItem icon="agent" unavailable>Ask agent settings</MenuItem>
            <MenuItem icon="flask" unavailable>Feature preview</MenuItem>
            <MenuItem icon="appearance" onSelect={() => {handingOffFocus.current = true; onAppearance();}}>Appearance</MenuItem>
            <MenuItem icon="accessibility" unavailable>Accessibility</MenuItem>
            <MenuItem icon="enterprise" unavailable>Try Enterprise</MenuItem>
          </DropdownMenu.Group>
          <DropdownMenu.Group>
            <DropdownMenu.Separator className="ac-menu-separator"/>
            <MenuItem icon="signout" disabled={application ? application.busy || !application.onSignOut : accountBusy || !canSignOut} onSelect={application ? application.onSignOut : onSignOut}>{application ? 'Sign out of asMagicBrain' : signOutLabel}</MenuItem>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>}
    </DropdownMenu.Root>
    {settingsOpen && <CommitSettingsDialog preferences={preferences} loading={loading} error={error} onReload={onReload} onSave={onSave} onClose={closeSettings} returnFocus={trigger} connectedIdentity={connectedIdentity}/>}
  </>;
}

type SettingsProps = Pick<AccountControlsProps, 'preferences' | 'loading' | 'error' | 'onReload' | 'onSave' | 'connectedIdentity'> & {
  onClose(): void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
};
function CommitSettingsDialog({preferences, loading, error, onReload, onSave, onClose, returnFocus, connectedIdentity}: SettingsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[role="menu"]')) previousFocus.focus();
      else returnFocus.current?.focus();
    };
  }, [returnFocus]);
  const close = () => {if (!saving.current) onClose();};
  const save = async (next: CommitPreferencesInput) => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {await onSave(next); onClose();}
    finally {saving.current = false; setBusy(false);}
  };
  return <dialog ref={dialog} className="ac-settings" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => {event.preventDefault(); close();}} onKeyDown={event => event.stopPropagation()}>
    <header><div><span className="ac-eyebrow">Settings</span><h2 id={`${id}-title`}>Commit author</h2></div><button type="button" className="ac-close" aria-label="Close settings" disabled={busy} onClick={close}>×</button></header>
    <p id={`${id}-description`} className="ac-description">Choose how to fill the name and email recorded in your Git commits.</p>
    <div className="ac-author-note"><AccountIcon name="repository"/><p>Git stores the author name and email in commit history. These settings are saved on this device and do not sign you in to an account.</p></div>
    {loading && <p role="status" className="ac-feedback">Loading commit settings…</p>}
    {error && <div className="ac-service-error"><p role="alert">{error}</p><button type="button" disabled={busy || loading} onClick={onReload}>Reload settings</button></div>}
    {preferences ? <CommitSettingsForm key={preferences.revision} preferences={preferences} busy={busy} loading={loading} onSave={save} onCancel={close} id={id} connectedIdentity={connectedIdentity}/>
      : <><p className="ac-help">Your commit settings will appear when the local connection is ready.</p>{!loading && !error && <button type="button" onClick={onReload}>Load settings</button>}<footer><button type="button" onClick={close}>Cancel</button></footer></>}
  </dialog>;
}

const modes: {value: CommitAuthorMode; label: string; description: string}[] = [
  {value: 'asmagicbrain', label: 'asMagicBrain profile', description: 'Use the local name and email you save below.'},
  {value: 'github', label: 'GitHub identity', description: 'Use the name and email you choose for GitHub commits.'},
  {value: 'manual', label: 'Manual each commit', description: 'Start with blank author fields for every commit.'},
];
function CommitSettingsForm({preferences, busy, loading, onSave, onCancel, id, connectedIdentity}: {
  preferences: CommitPreferences; busy: boolean; loading: boolean;
  onSave(next: CommitPreferencesInput): Promise<void>; onCancel(): void; id: string;
  connectedIdentity?: {name: string; email: string | null};
}) {
  const [draft, setDraft] = useState<CommitPreferencesInput>(() => ({expectedRevision: preferences.revision, mode: preferences.mode,
    asmagicbrain: {...preferences.asmagicbrain}, github: {...preferences.github}}));
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fields = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const identity = draft.mode === 'manual' ? null : draft[draft.mode];
  const fieldError = (value: string, field: 'name' | 'email') => value === '' ? null : authorFieldError(value, field);
  const nameError = submitted && identity ? fieldError(identity.name, 'name') : null;
  const emailError = submitted && identity ? fieldError(identity.email, 'email') : null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || busy || loading) return;
    setSubmitted(true); setSaveError('');
    for (const mode of ['asmagicbrain', 'github'] as const) {
      for (const field of ['name', 'email'] as const) {
        if (fieldError(draft[mode][field], field)) {
          setDraft(current => ({...current, mode}));
          requestAnimationFrame(() => fields.current?.querySelector<HTMLInputElement>(`[name="author-${field}"]`)?.focus());
          return;
        }
      }
    }
    inFlight.current = true;
    try {await onSave(draft);}
    catch (reason) {setSaveError(reason instanceof Error ? reason.message : 'Settings could not be saved. Please try again.'); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('.ac-save-error')?.focus());}
    finally {inFlight.current = false;}
  };
  return <form ref={form} onSubmit={event => {void submit(event);}} aria-busy={busy} noValidate>
    <fieldset className="ac-modes" disabled={busy || loading}><legend>Fill author fields from</legend>{modes.map(mode =>
      <label key={mode.value} className="ac-mode" data-selected={draft.mode === mode.value || undefined}>
        <input type="radio" name={`${id}-mode`} value={mode.value} checked={draft.mode === mode.value} onChange={() => {setDraft(current => ({...current, mode: mode.value})); setSaveError('');}}/>
        <span><strong>{mode.label}</strong><span>{mode.description}</span></span>
      </label>)}
    </fieldset>
    {identity && <div ref={fields} className="ac-identity-fields">
      <h3>{draft.mode === 'github' ? 'GitHub commit identity' : 'Local asMagicBrain profile'}</h3>
      <p className="ac-help" id={`${id}-identity-help`}>Save these once to fill future commits. Blank fields can be filled in when committing. You can edit the author for any individual commit.</p>
      {draft.mode === 'github' && connectedIdentity && <div className="ac-connected-identity"><button type="button" disabled={busy || loading} onClick={() => {
        setDraft(current => ({...current, github: {name: connectedIdentity.name, email: connectedIdentity.email ?? current.github.email}})); setSaveError('');
      }}>Use connected GitHub identity</button>{!connectedIdentity.email && <p className="ac-help">Your GitHub profile does not share an email. Enter the email you want recorded in commits below.</p>}</div>}
      {(['name', 'email'] as const).map(field => {
        const message = field === 'name' ? nameError : emailError;
        return <label key={field} className="ac-field">{field === 'name' ? draft.mode === 'github' ? 'GitHub username or name' : 'Author name' : 'Author email'}
          <input name={`author-${field}`} type={field === 'email' ? 'email' : 'text'} value={identity[field]} autoComplete="off" spellCheck={false} disabled={busy || loading}
            aria-invalid={Boolean(message)} aria-describedby={message ? `${id}-${field}-error` : `${id}-identity-help`}
            onChange={event => {const value = event.target.value; setDraft(current => current.mode === 'manual' ? current : {...current, [current.mode]: {...current[current.mode], [field]: value}}); setSaveError('');}}/>
          {message && <span role="alert" className="ac-field-error" id={`${id}-${field}-error`}>{message}</span>}
        </label>;
      })}
    </div>}
    {draft.mode === 'manual' && <p className="ac-manual-note">Your saved profile fields stay available if you choose them again. New commits will ask for an author name and email.</p>}
    {saveError && <p tabIndex={-1} role="alert" className="ac-save-error">{saveError}</p>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="ac-primary" disabled={busy || loading}>{busy ? 'Saving…' : 'Save settings'}</button></footer>
  </form>;
}
