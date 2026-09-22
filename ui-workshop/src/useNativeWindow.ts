import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {getNativeBridge, isNativeClosing, nativeOperation, setNativeClosing, waitForNativeOperations} from './native-bridge.mjs';
import {createNativeCloseHandler} from './native-close.mjs';
import {registerNativeCloseHandler} from './native-close-router.mjs';
import type {NativeAppearance} from './native-types';

export function useNativeWindow(root: RefObject<HTMLDivElement | null>, beforeLeave: RefObject<((reason?: 'close') => Promise<void>) | null>) {
  const bridge = getNativeBridge();
  const [closing, setClosing] = useState(false), [error, setError] = useState('');
  const [appearanceError, setAppearanceError] = useState('');
  const appearance = useRef(Promise.resolve());
  const persistAppearance = useCallback((value: NativeAppearance) => {
    if (!bridge) return;
    // Serialize complete preference snapshots so quick changes cannot reorder on disk.
    const next = appearance.current.catch(() => {}).then(async () => {
      await nativeOperation(() => bridge.setAppearance(value));
    });
    appearance.current = next;
    void next.then(() => setAppearanceError(''), reason => setAppearanceError(`Appearance could not be saved: ${reason.message}`));
  }, [bridge]);

  useLayoutEffect(() => {
    if (!bridge) return;
    let composing = false, compositionEnded = -Infinity;
    const start = () => {composing = true;};
    const end = () => {composing = false; compositionEnded = performance.now();};
    // Include IME settlement: Chromium/CM6 can deliver the final DOM update just
    // after compositionend. A close at that boundary asks the user to retry.
    const handle = createNativeCloseHandler({
      composing: () => composing || performance.now() - compositionEnded < 100,
      prepare: async () => {
        // Main has drained publication, but its reply may still be refreshing
        // the renderer's file/session. Finish that admitted scope before the
        // editor's synchronous busy/filename guard. The close handler locks
        // input immediately while this promise settles.
        await waitForNativeOperations();
        await beforeLeave.current?.('close');
      },
      lock: (value: boolean) => {
        setNativeClosing(value);
        if (root.current) root.current.inert = value;
        setClosing(value);
      },
      settle: async () => {
        await appearance.current;
        await waitForNativeOperations();
        // Drain once more with input locked, including any already-queued DOM update.
        await beforeLeave.current?.('close');
        await waitForNativeOperations();
      },
      acknowledge: (value: {requestId: string; ok: boolean; error?: string}) => bridge.closeReady(value),
      report: (message: string) => setError(`Window kept open: ${message}`),
    });
    const block = (event: Event) => {
      if (isNativeClosing()) {event.preventDefault(); event.stopImmediatePropagation();}
    };
    const blockedEvents = ['beforeinput', 'keydown', 'pointerdown', 'click', 'paste', 'cut', 'drop', 'compositionstart'];
    for (const name of blockedEvents) document.addEventListener(name, block, true);
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    const unsubscribe = registerNativeCloseHandler(bridge, handle);
    return () => {
      unsubscribe();
      setNativeClosing(false);
      for (const name of blockedEvents) document.removeEventListener(name, block, true);
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
    };
  }, [bridge, root, beforeLeave]);

  const windowAction = (action: 'close' | 'minimize' | 'maximize') => {
    if (bridge) void bridge.windowAction(action).catch(reason => setError(reason.message));
  };
  return {native: Boolean(bridge), nativeWindowControls: bridge?.nativeWindowControls === true, closing, error, appearanceError, persistAppearance, windowAction};
}
