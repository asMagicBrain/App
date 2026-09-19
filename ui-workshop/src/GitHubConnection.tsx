import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {getNativeBridge, isNativeClosing, nativeOperation} from './native-bridge.mjs';
import type {GitHubAccount, GitHubAuthorization, GitHubConnection} from './native-types';
import './ZipImportDialog.css';

const connectionChanged = 'asmb:github-connection-changed';
/** Reload cached host identity after an operation that can expire or replace it. */
export function invalidateGitHubConnection() {window.dispatchEvent(new Event(connectionChanged));}

export function useGitHubConnection() {
  const [connection, setConnection] = useState<GitHubConnection | null>(null), [error, setError] = useState('');
  const mounted = useRef(true), generation = useRef(0);
  const refresh = useCallback(async () => {
    const bridge = getNativeBridge();
    if (!bridge?.getGitHubConnection || isNativeClosing()) return;
    const request = ++generation.current;
    try {const value = await nativeOperation(() => bridge.getGitHubConnection()); if (mounted.current && generation.current === request) {setConnection(value); setError('');}}
    catch (reason) {if (mounted.current && generation.current === request) setError(reason instanceof Error ? reason.message : 'GitHub connection is unavailable.');}
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const onFocus = () => {void refresh();}; window.addEventListener('focus', onFocus); window.addEventListener(connectionChanged, onFocus);
    return () => {mounted.current = false; generation.current++; window.removeEventListener('focus', onFocus); window.removeEventListener(connectionChanged, onFocus);};
  }, [refresh]);
  const connected = useCallback((account: GitHubAccount) => {generation.current++; setConnection(previous => ({configured: true, state: 'connected', account, ...(previous?.persistence ? {persistence: previous.persistence} : {})})); setError(''); invalidateGitHubConnection();}, []);
  return {connection, error, refresh, connected};
}

type Props = {
  connection: GitHubConnection | null; error: string;
  onRefresh(): void; onConnected(account: GitHubAccount): void; onClose(): void;
};
export function GitHubConnectionDialog({connection, error: connectionError, onRefresh, onConnected, onClose}: Props) {
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), attempt = useRef<GitHubAuthorization | null>(null);
  const generation = useRef(0), phase = useRef<'starting' | 'cancelling' | null>(null), copySequence = useRef(0);
  const [authorization, setAuthorization] = useState<GitHubAuthorization | null>(null);
  const [busy, setBusy] = useState(false), [cancelling, setCancelling] = useState(false), [opening, setOpening] = useState(false), [copying, setCopying] = useState(false);
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [copied, setCopied] = useState(false), [expired, setExpired] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({onConnected, onClose}); callbacks.current = {onConnected, onClose};
  const current = (epoch: number, requestId?: string) => active.current && generation.current === epoch && (!requestId || attempt.current?.requestId === requestId);
  const clearCopy = () => {copySequence.current++; if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = null; setCopied(false); setCopying(false);};
  const clearAttempt = () => {attempt.current = null; setAuthorization(null); setOpening(false); clearCopy();};

  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement;
    active.current = true; element.showModal();
    return () => {
      active.current = false; generation.current++; copySequence.current++;
      element.close(); if (copyTimer.current) clearTimeout(copyTimer.current);
      const pending = attempt.current, starting = phase.current === 'starting', bridge = getNativeBridge();
      attempt.current = null;
      // Main already invalidates and drains authorization during native close.
      // Ordinary unmount also cancels a start whose public request ID is pending.
      if (!isNativeClosing() && bridge && (pending || starting)) void nativeOperation(() => pending
        ? bridge.cancelGitHubConnection({requestId: pending.requestId}) : bridge.cancelPendingGitHubConnection()).catch(() => {});
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[role="menu"]')) previous.focus();
      else document.querySelector<HTMLButtonElement>('.ac-trigger')?.focus();
    };
  }, []);
  useEffect(() => {
    if (!authorization) {setExpired(false); return;}
    const remaining = authorization.expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [authorization?.requestId, authorization?.expiresAt]);
  useEffect(() => {
    if (!authorization) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const bridge = getNativeBridge()!, requestId = authorization.requestId, epoch = generation.current;
    const schedule = () => {
      const value = attempt.current;
      if (!value || stopped || !current(epoch, requestId)) return;
      const remaining = Math.max(0, value.expiresAt - Date.now());
      timer = setTimeout(() => {void poll();}, isNativeClosing() ? 1000 : Math.min(Math.max(1, value.pollInterval) * 1000, remaining));
    };
    const poll = async () => {
      if (stopped || !current(epoch, requestId)) return;
      if (isNativeClosing()) {schedule(); return;}
      try {
        const result = await nativeOperation(() => bridge.pollGitHubConnection({requestId}));
        if (stopped || !current(epoch, requestId)) return;
        if (isNativeClosing()) {schedule(); return;}
        if (result.requestId !== requestId) throw new Error('GitHub returned an unexpected connection response. Try again.');
        if (result.state === 'connected') {
          generation.current++; clearAttempt(); callbacks.current.onConnected(result.account); callbacks.current.onClose(); return;
        }
        if (result.state !== 'awaiting-authorization') {
          generation.current++; clearAttempt(); setStatus('');
          setError(result.error ?? (result.state === 'expired' ? 'This code expired. Start again to get a new code.' : result.state === 'cancelled' ? 'Connection cancelled.' : 'GitHub connection was not completed.')); return;
        }
        attempt.current = result; setAuthorization(result); setError('');
      } catch (reason) {
        if (!stopped && current(epoch, requestId)) {
          setError(reason instanceof Error ? reason.message : 'Could not check GitHub authorization.');
          // An expired local code stays disabled even if the native reply is
          // temporarily unavailable. Retry at a bounded rate, never a tight loop.
          timer = setTimeout(() => {void poll();}, Math.max(5, attempt.current?.pollInterval ?? 5) * 1000);
        }
      }
    };
    schedule();
    return () => {stopped = true; clearTimeout(timer);};
  }, [authorization]);

  const start = async () => {
    if (phase.current || attempt.current || isNativeClosing()) return;
    const bridge = getNativeBridge(); if (!bridge?.startGitHubConnection || !connection?.configured) return;
    const epoch = ++generation.current;
    phase.current = 'starting'; clearCopy(); setOpening(false); setBusy(true); setError(''); setStatus('Preparing GitHub connection…');
    await nativeOperation(async () => {
      try {
        const result = await bridge.startGitHubConnection();
        if (!current(epoch)) {if (!isNativeClosing()) await bridge.cancelGitHubConnection({requestId: result.requestId}); return;}
        attempt.current = result; setAuthorization(result); setStatus('Waiting for authorization on GitHub…');
      } catch (reason) {if (current(epoch)) {setError(reason instanceof Error ? reason.message : 'GitHub connection could not start.'); setStatus('');}}
      finally {if (current(epoch)) {phase.current = null; setBusy(false);}}
    });
  };
  const close = async () => {
    if (phase.current === 'cancelling') return;
    const pending = attempt.current, starting = phase.current === 'starting', bridge = getNativeBridge();
    if ((!pending && !starting) || !bridge) {generation.current++; clearAttempt(); onClose(); return;}
    const epoch = ++generation.current;
    phase.current = 'cancelling'; setBusy(false); setCancelling(true); setOpening(false); clearCopy(); setError('');
    await nativeOperation(async () => {
      try {
        if (pending) await bridge.cancelGitHubConnection({requestId: pending.requestId});
        else await bridge.cancelPendingGitHubConnection();
        if (current(epoch)) {clearAttempt(); onClose();}
      } catch (reason) {
        if (current(epoch)) {setError(reason instanceof Error ? reason.message : 'Could not cancel the connection. Try again.'); setAuthorization(value => value ? {...value} : null);}
      } finally {if (current(epoch)) {phase.current = null; setCancelling(false); setStatus('');}}
    });
  };
  const openGitHub = async () => {
    const bridge = getNativeBridge(), pending = attempt.current;
    if (!bridge || !pending || opening || phase.current || pending.expiresAt <= Date.now() || isNativeClosing()) return;
    const epoch = generation.current, requestId = pending.requestId; setOpening(true); setError('');
    try {await nativeOperation(() => bridge.openGitHubVerification({requestId}));}
    catch (reason) {if (current(epoch, requestId)) setError(reason instanceof Error ? reason.message : 'Could not open GitHub in your browser.');}
    finally {if (current(epoch, requestId)) setOpening(false);}
  };
  const copyCode = async () => {
    const pending = attempt.current;
    if (!pending || copying || phase.current || pending.expiresAt <= Date.now() || isNativeClosing()) return;
    const epoch = generation.current, requestId = pending.requestId, sequence = ++copySequence.current;
    setCopying(true); setCopied(false);
    try {
      await navigator.clipboard.writeText(pending.userCode);
      if (!current(epoch, requestId) || copySequence.current !== sequence) return;
      setCopied(true); if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {if (current(epoch, requestId) && copySequence.current === sequence) setCopied(false);}, 2000);
    } catch {if (current(epoch, requestId) && copySequence.current === sequence) setError('Could not copy the code. Select and copy the code below.');}
    finally {if (current(epoch, requestId) && copySequence.current === sequence) setCopying(false);}
  };

  return <dialog ref={dialog} className="zi-dialog gc-connect-dialog" aria-labelledby="gc-connect-title" aria-describedby="gc-connect-description" onCancel={event => {event.preventDefault(); void close();}} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="gc-connect-title">Connect GitHub</h2><button type="button" className="zi-close" aria-label="Close GitHub connection" disabled={cancelling} onClick={() => {void close();}}>×</button></header>
    <p id="gc-connect-description">Connect your account to clone repositories you can access. Your existing repositories and local changes are not uploaded.{connection?.configured && connection.persistence === 'session' && ' GitHub stays connected until you quit asMagicBrain.'}</p>
    {authorization ? <>
      <p className="zi-help">Enter this code on GitHub, then return here.</p>
      <div className="gc-code-row"><output className="gc-user-code" aria-label="GitHub authorization code">{authorization.userCode}</output><button type="button" disabled={copying || cancelling || expired} onClick={() => {void copyCode();}}>{copying ? 'Copying…' : 'Copy code'}</button><span className="gc-copy-status" role="status">{copied ? 'Copied' : ''}</span></div>
      <p className="zi-help">github.com/login/device · Code expires at {new Date(authorization.expiresAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}.</p>
      <button type="button" className="zi-primary" disabled={opening || cancelling || expired} onClick={() => {void openGitHub();}}>{opening ? 'Opening GitHub…' : 'Open GitHub'}</button>
    </> : <>
      {!connection?.configured && <p className="zi-error">GitHub connection is unavailable in this build. You can still clone public repositories and work locally.</p>}
      {connection?.state === 'expired' && <p className="zi-help">Your previous GitHub connection expired. Connect again to access private repositories.</p>}
    </>}
    {(error || connectionError || (!authorization && !busy && connection?.error)) && <p role="alert" className="zi-error">{error || connectionError || connection?.error}</p>}
    {connectionError && <button type="button" disabled={busy || cancelling} onClick={onRefresh}>Retry connection status</button>}
    <p className="zi-progress" role="status" aria-live="polite">{cancelling ? 'Cancelling connection…' : expired ? 'This code has expired. Waiting for the connection to finish…' : status}</p>
    <footer><button type="button" disabled={cancelling} onClick={() => {void close();}}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>{!authorization && <button type="button" className="zi-primary" disabled={busy || cancelling || !connection?.configured || connection.state === 'unavailable'} onClick={() => {void start();}}>{busy ? 'Connecting…' : 'Connect GitHub'}</button>}</footer>
  </dialog>;
}
