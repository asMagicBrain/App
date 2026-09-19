import React, {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {getNativeBridge, isNativeClosing, nativeOperation} from './native-bridge.mjs';
import type {ApplicationAccount, ApplicationAccountState, ApplicationAuthorization, ApplicationAuthorizationResult, ApplicationSignInInput} from './native-types';
import './app-account.css';

/** Application identity is independent from GitHub access and local Git authors. */
export function useApplicationAccount() {
  const [status, setStatus] = useState<ApplicationAccountState | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(true), sequence = useRef(0), mutating = useRef(false);
  const accept = useCallback((value: ApplicationAccountState) => {
    sequence.current++;
    if (mounted.current) {setStatus(value); setError(''); setLoading(false);}
  }, []);
  const refresh = useCallback(async (revalidate = false) => {
    const bridge = getNativeBridge();
    if (!bridge?.getApplicationAccount || isNativeClosing() || mutating.current) return;
    const epoch = ++sequence.current; setLoading(true);
    try {
      const value = await nativeOperation(() => revalidate ? bridge.refreshApplicationAccount() : bridge.getApplicationAccount());
      if (mounted.current && sequence.current === epoch) {setStatus(value); setError('');}
    } catch (reason) {if (mounted.current && sequence.current === epoch) setError(message(reason, 'Could not load your account. Try again.'));}
    finally {if (mounted.current && sequence.current === epoch) setLoading(false);}
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const onFocus = () => {void refresh();}; window.addEventListener('focus', onFocus);
    return () => {mounted.current = false; sequence.current++; window.removeEventListener('focus', onFocus);};
  }, [refresh]);
  const signOut = useCallback(async () => {
    const bridge = getNativeBridge(); if (!bridge?.signOutApplicationAccount || isNativeClosing() || mutating.current) return;
    mutating.current = true; sequence.current++; setBusy(true); setLoading(false); setError('');
    try {const value = await nativeOperation(() => bridge.signOutApplicationAccount()); accept(value);}
    catch (reason) {if (mounted.current) setError(message(reason, 'Could not sign out. Try again.'));}
    finally {mutating.current = false; if (mounted.current) setBusy(false);}
  }, [accept]);
  return {status, error, loading, busy, refresh, accept, signOut};
}

function message(reason: unknown, fallback: string) {return reason instanceof Error ? reason.message : fallback;}
function restoreFocus(previous: Element | null) {
  if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[role="menu"]')) previous.focus();
  else document.querySelector<HTMLButtonElement>('.ac-trigger')?.focus();
}
type SignInProps = {
  status: ApplicationAccountState | null;
  onSignedIn(): void;
  onClose(): void;
};

export function ApplicationSignInDialog({status, onSignedIn, onClose}: SignInProps) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), emailInput = useRef<HTMLInputElement>(null), tokenInput = useRef<HTMLInputElement>(null);
  const active = useRef(true), generation = useRef(0), pending = useRef<ApplicationAuthorization | null>(null);
  const phase = useRef<'starting' | 'verifying' | 'cancelling' | null>(null);
  const callbacks = useRef({onSignedIn, onClose}); callbacks.current = {onSignedIn, onClose};
  const [authorization, setAuthorization] = useState<ApplicationAuthorization | null>(null);
  const [email, setEmail] = useState(''), [token, setToken] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [emailError, setEmailError] = useState(''), [tokenError, setTokenError] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState<'starting' | 'verifying' | 'cancelling' | null>(null), [expired, setExpired] = useState(false);
  const current = (epoch: number, requestId?: string) => active.current && generation.current === epoch && (!requestId || pending.current?.requestId === requestId);
  const clear = () => {pending.current = null; setAuthorization(null); setToken(''); setTokenError(''); setExpired(false); setShowCode(false);};
  const finish = (result: ApplicationAuthorizationResult, epoch: number, requestId: string, fromStart = false) => {
    if (!current(epoch, fromStart ? undefined : requestId)) return;
    if (result.requestId !== requestId) throw new Error('The sign-in response could not be verified. Please try again.');
    if (result.state === 'awaiting-browser' || result.state === 'awaiting-email') {if (result.error) setTokenError(result.error); return;}
    generation.current++; phase.current = null; setBusy(null); clear();
    if (result.state === 'signed-in') {callbacks.current.onSignedIn(); callbacks.current.onClose();}
    else setError(result.error || (result.state === 'expired' ? 'This sign-in request expired. Please start again.' : result.state === 'cancelled' ? 'Sign-in was cancelled.' : 'Sign-in could not be completed. Please try again.'));
  };

  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement; active.current = true; element.showModal();
    return () => {
      active.current = false; generation.current++; element.close();
      const attempt = pending.current, starting = phase.current === 'starting', bridge = getNativeBridge(); pending.current = null;
      if (!isNativeClosing() && bridge && (attempt || starting)) void nativeOperation(() => attempt
        ? bridge.cancelApplicationSignIn({requestId: attempt.requestId}) : bridge.cancelPendingApplicationSignIn()).catch(() => {});
      restoreFocus(previous);
    };
  }, []);
  useEffect(() => {
    if (!authorization) return;
    const remaining = authorization.expiresAt - Date.now(); setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining); return () => clearTimeout(timer);
  }, [authorization?.requestId, authorization?.expiresAt]);
  useEffect(() => {
    if (!authorization) return;
    const bridge = getNativeBridge(); if (!bridge) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current, requestId = authorization.requestId;
    const poll = async () => {
      if (stopped || !current(epoch, requestId)) return;
      if (!phase.current && !isNativeClosing()) {
        try {const result = await nativeOperation(() => bridge.pollApplicationSignIn({requestId})); if (!stopped && current(epoch, requestId)) finish(result, epoch, requestId);}
        catch (reason) {if (!stopped && current(epoch, requestId)) setError(message(reason, 'Could not check sign-in. You can try again.'));}
      }
      if (!stopped && current(epoch, requestId)) timer = setTimeout(() => {void poll();}, 1500);
    };
    timer = setTimeout(() => {void poll();}, 1000);
    return () => {stopped = true; clearTimeout(timer);};
  }, [authorization]);
  useEffect(() => {if (showCode) tokenInput.current?.focus();}, [showCode]);

  const start = async (input: ApplicationSignInInput) => {
    const bridge = getNativeBridge(); if (!bridge?.startApplicationSignIn || phase.current || pending.current || isNativeClosing()) return;
    if (input.method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email)) {setEmailError('Enter an email address such as name@example.com.'); emailInput.current?.focus(); return;}
    const epoch = ++generation.current; phase.current = 'starting'; setBusy('starting'); setError(''); setEmailError(''); setTokenError('');
    await nativeOperation(async () => {
      try {
        const result = await bridge.startApplicationSignIn(input);
        if (!current(epoch)) {if (!isNativeClosing()) await bridge.cancelApplicationSignIn({requestId: result.requestId}); return;}
        if (result.state === 'awaiting-browser' || result.state === 'awaiting-email') {pending.current = result; setAuthorization(result);}
        else finish(result, epoch, result.requestId, true);
      } catch (reason) {if (current(epoch)) setError(message(reason, 'Could not start sign-in. Try again.'));}
      finally {if (current(epoch)) {phase.current = null; setBusy(null);}}
    });
  };
  const cancel = async (close: boolean) => {
    if (phase.current === 'cancelling' || isNativeClosing()) return false;
    const attempt = pending.current, starting = phase.current === 'starting', bridge = getNativeBridge();
    if ((!attempt && !starting) || !bridge) {generation.current++; clear(); if (close) callbacks.current.onClose(); return true;}
    const epoch = ++generation.current; phase.current = 'cancelling'; setBusy('cancelling'); setError('');
    let cancelled = false;
    await nativeOperation(async () => {
      try {
        if (attempt) {
          const result = await bridge.cancelApplicationSignIn({requestId: attempt.requestId});
          // Publication can win the race with cancellation. Respect the host's
          // established account and do not start a replacement email request.
          if (result?.state === 'signed-in') {finish(result, epoch, attempt.requestId); return;}
        } else await bridge.cancelPendingApplicationSignIn();
        if (current(epoch)) {clear(); cancelled = true; if (close) callbacks.current.onClose(); else emailInput.current?.focus();}
      } catch (reason) {if (current(epoch)) {setError(message(reason, 'Could not cancel sign-in. Try again.')); setAuthorization(value => value ? {...value} : null);}}
      finally {if (current(epoch)) {phase.current = null; setBusy(null);}}
    });
    return cancelled;
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault(); const attempt = pending.current, bridge = getNativeBridge();
    if (!attempt || !bridge || phase.current || expired || isNativeClosing()) return;
    if (!/^\d{6,10}$/u.test(token.trim())) {setTokenError('Enter the complete 6–10 digit code from your email.'); tokenInput.current?.focus(); return;}
    const epoch = generation.current; phase.current = 'verifying'; setBusy('verifying'); setError(''); setTokenError('');
    try {
      const result = await nativeOperation(() => bridge.verifyApplicationEmail({requestId: attempt.requestId, token: token.trim()}));
      finish(result, epoch, attempt.requestId);
    } catch (reason) {if (current(epoch, attempt.requestId)) {setTokenError(message(reason, 'This code could not be verified. Check it and try again.')); tokenInput.current?.focus();}}
    finally {if (current(epoch, attempt.requestId)) {phase.current = null; setBusy(null);}}
  };
  const resend = async () => {if (await cancel(false)) await start({method: 'email', email: email.trim()});};
  const providerAvailable = Boolean(status?.configured && status.state !== 'unavailable');
  const emailAvailable = providerAvailable && Boolean(status?.providers.email), githubAvailable = providerAvailable && Boolean(status?.providers.github);
  return <dialog ref={dialog} className="ac-settings aa-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => {event.preventDefault(); void cancel(true);}} onKeyDown={event => event.stopPropagation()}>
    <header><div><span className="ac-eyebrow">Account</span><h2 id={`${id}-title`}>Sign in to asMagicBrain</h2></div><button type="button" className="ac-close" aria-label="Close sign-in" disabled={busy === 'cancelling'} onClick={() => {void cancel(true);}}>×</button></header>
    <p id={`${id}-description`} className="ac-description">Use your asMagicBrain account. You can keep working locally without signing in.{providerAvailable && status?.persistence === 'session' && ' You stay signed in until you quit asMagicBrain.'}</p>
    {!authorization ? <>
      {!providerAvailable && <p className="ac-help">Sign-in is currently unavailable. Please try again later.</p>}
      {githubAvailable && <button type="button" className="aa-provider" disabled={Boolean(busy)} onClick={() => {void start({method: 'github'});}}>Continue with GitHub</button>}
      {emailAvailable && <form onSubmit={event => {event.preventDefault(); void start({method: 'email', email: email.trim()});}} noValidate aria-busy={busy === 'starting'}>
        {githubAvailable && <div className="aa-divider">or use email</div>}
        <label className="ac-field">Email<input ref={emailInput} type="email" name="account-email" autoComplete="email" spellCheck={false} value={email} maxLength={254} disabled={Boolean(busy)} aria-invalid={Boolean(emailError)} aria-describedby={emailError ? `${id}-email-error` : `${id}-email-help`} onChange={event => {setEmail(event.target.value); setEmailError('');}}/></label>
        <p className="ac-help" id={`${id}-email-help`}>We’ll email you to sign in or create your account.</p>
        {emailError && <p role="alert" className="ac-field-error" id={`${id}-email-error`}>{emailError}</p>}
        <button type="submit" className="ac-primary aa-provider" disabled={Boolean(busy)}>Continue with email</button>
      </form>}
    </> : authorization.state === 'awaiting-email' ? <form onSubmit={event => {void verify(event);}} noValidate aria-busy={busy === 'verifying'}>
      <p className="aa-sent">Check <strong>{email.trim()}</strong> to finish signing in. Open the sign-in link on this computer while this window stays open.</p>
      {!showCode ? <button type="button" disabled={Boolean(busy) || expired} onClick={() => setShowCode(true)}>My email includes a code</button> : <>
      <label className="ac-field">Sign-in code<input ref={tokenInput} name="account-code" autoComplete="one-time-code" inputMode="numeric" spellCheck={false} value={token} maxLength={10} disabled={Boolean(busy) || expired} aria-invalid={Boolean(tokenError)} aria-describedby={tokenError ? `${id}-token-error` : `${id}-code-help`} onChange={event => {setToken(event.target.value); setTokenError('');}}/></label>
      <p className="ac-help" id={`${id}-code-help`}>You can paste the code from your email.</p>
      {tokenError && <p role="alert" className="ac-field-error" id={`${id}-token-error`}>{tokenError}</p>}
      <button type="submit" className="ac-primary aa-provider" disabled={Boolean(busy) || expired}>{busy === 'verifying' ? 'Signing in…' : 'Sign in'}</button>
      </>}
      <div className="aa-secondary"><button type="button" disabled={Boolean(busy)} onClick={() => {void resend();}}>Send another email</button><button type="button" disabled={Boolean(busy)} onClick={() => {void cancel(false);}}>Use a different email</button></div>
    </form> : <p className="aa-sent">Complete sign-in in your browser, then return here.</p>}
    {(error || (!authorization && status?.error)) && <p role="alert" className="ac-save-error">{error || status?.error}</p>}
    <p role="status" aria-live="polite" className="aa-status">{busy === 'cancelling' ? 'Cancelling sign-in…' : busy === 'starting' ? 'Preparing sign-in…' : expired ? 'This sign-in request expired. Start again to continue.' : authorization?.state === 'awaiting-browser' ? 'Waiting for browser sign-in…' : ''}</p>
    <footer><button type="button" disabled={busy === 'cancelling'} onClick={() => {void cancel(true);}}>{busy === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button>{authorization?.state === 'awaiting-browser' && <button type="button" disabled={Boolean(busy)} onClick={() => {void cancel(false);}}>Start again</button>}</footer>
  </dialog>;
}

type ProfileProps = {
  account: ApplicationAccount;
  status: ApplicationAccountState;
  onChanged(value: ApplicationAccountState): void;
  onReauthenticate(): void;
  onClose(): void;
};
export function ApplicationProfileDialog({account, status, onChanged, onReauthenticate, onClose}: ProfileProps) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), active = useRef(true), saving = useRef(false);
  const [displayName, setDisplayName] = useState(account.displayName), [busy, setBusy] = useState(false), [error, setError] = useState(''), [nameError, setNameError] = useState(''), [feedback, setFeedback] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement; active.current = true; element.showModal();
    return () => {active.current = false; element.close(); restoreFocus(previous);};
  }, []);
  const close = () => {if (!saving.current) onClose();};
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); const bridge = getNativeBridge(); if (!bridge || saving.current || isNativeClosing()) return;
    if (!displayName.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(displayName)) {setNameError('Enter a display name without control characters.'); dialog.current?.querySelector<HTMLInputElement>('[name="display-name"]')?.focus(); return;}
    saving.current = true; setBusy(true); setError(''); setNameError(''); setFeedback('');
    try {
      const value = await nativeOperation(() => bridge.updateApplicationProfile({displayName: displayName.trim()}));
      if (active.current) {onChanged(value); if (value.state === 'signed-in') {setDisplayName(value.account?.displayName ?? displayName.trim()); setFeedback('Profile saved.');} else setError(value.error || 'Sign in again to update your profile.');}
    } catch (reason) {
      if (active.current) setError(message(reason, 'Could not save your profile. Try again.'));
      try {const value = await nativeOperation(() => bridge.getApplicationAccount()); if (active.current) onChanged(value);}
      catch { /* Preserve the form and the original save error if status is also unavailable. */ }
    }
    finally {saving.current = false; if (active.current) setBusy(false);}
  };
  const reconnect = async () => {
    const bridge = getNativeBridge(); if (!bridge || saving.current || isNativeClosing()) return;
    saving.current = true; setBusy(true); setReconnecting(true); setError(''); setFeedback('');
    try {
      const value = await nativeOperation(() => bridge.refreshApplicationAccount());
      if (active.current) {onChanged(value); if (value.state === 'signed-in') setFeedback('Account connected.'); else setError(value.error || 'Could not reconnect. Try again or sign in again.');}
    } catch (reason) {if (active.current) setError(message(reason, 'Could not reconnect. Try again.'));}
    finally {saving.current = false; if (active.current) {setBusy(false); setReconnecting(false);}}
  };
  const connected = status.state === 'signed-in';
  return <dialog ref={dialog} className="ac-settings aa-dialog aa-profile-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => {event.preventDefault(); close();}} onKeyDown={event => event.stopPropagation()}>
    <header><div><span className="ac-eyebrow">asMagicBrain account</span><h2 id={`${id}-title`}>Profile</h2></div><button type="button" className="ac-close" aria-label="Close profile" disabled={busy} onClick={close}>×</button></header>
    <p id={`${id}-description`} className="ac-description">Your account name and email.{status.persistence === 'session' && (connected || status.state === 'offline') && ' You stay signed in until you quit asMagicBrain.'}</p>
    <form onSubmit={event => {void save(event);}} noValidate aria-busy={busy}>
      <label className="ac-field">Display name<input name="display-name" autoComplete="nickname" value={displayName} maxLength={80} disabled={busy || !connected} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? `${id}-name-error` : undefined} onChange={event => {setDisplayName(event.target.value); setError(''); setNameError(''); setFeedback('');}}/></label>
      {nameError && <p role="alert" className="ac-field-error" id={`${id}-name-error`}>{nameError}</p>}
      <label className="ac-field">Account email<input name="profile-email" type="text" readOnly value={account.email || 'No email shared'} aria-describedby={`${id}-email-help`}/></label>
      <p className="ac-help" id={`${id}-email-help`}>Your sign-in email is shown here. Commit author settings are saved separately on this device.</p>
      {status.notice && <p className="ac-help" role="status">{status.notice}</p>}
      {!connected && <div className="aa-reconnect"><p className="ac-help">{status.state === 'offline' ? 'Reconnect to update your profile.' : 'Sign in again to update your profile.'}</p><div className="aa-secondary">{status.state === 'offline' && <button type="button" disabled={busy} onClick={() => {void reconnect();}}>Refresh account</button>}<button type="button" disabled={busy} onClick={onReauthenticate}>Sign in again</button></div></div>}
      {error && <p role="alert" className="ac-save-error" id={`${id}-profile-error`}>{error}</p>}
      <p role="status" className="aa-status">{busy ? reconnecting ? 'Reconnecting…' : 'Saving profile…' : feedback}</p>
      <footer><button type="button" disabled={busy} onClick={close}>Done</button><button type="submit" className="ac-primary" disabled={busy || !connected || displayName.trim() === account.displayName}>{busy && !reconnecting ? 'Saving…' : 'Save profile'}</button></footer>
    </form>
  </dialog>;
}
