import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {createLocalWorkspaceClient} from './local-workspace-client';
import type {CommitPreferences, CommitPreferencesInput} from './commit-preferences';
import {getNativeBridge,nativeOperation} from './native-bridge.mjs';

type PreferencesContext = {
  preferences: CommitPreferences | null;
  loading: boolean;
  error: string;
  refresh(): Promise<CommitPreferences>;
  save(input: CommitPreferencesInput): Promise<void>;
  settingsRequest: number;
  settingsClosed: number;
  openSettings(): void;
  closeSettings(): void;
};
const Context = createContext<PreferencesContext | null>(null);

/** One local profile for all repository views; commit labels are not login state. */
export function CommitPreferencesProvider({children, enabled, initialSettingsOpen = false}: {
  children: React.ReactNode; enabled: boolean; initialSettingsOpen?: boolean;
}) {
  const client = useMemo(() => createLocalWorkspaceClient('Workspace'), []);
  const requestPreferences=useCallback(async<T,>(operation:string,args:Record<string,unknown>={})=>{
    const bridge=getNativeBridge();
    if(!bridge)return client.request<T>(operation,args);
    // Profile settings are shared; the default repository can have a new name.
    const catalog=await nativeOperation(()=>bridge.catalog());
    const repo=catalog.defaultRepository??catalog.repositories[0]?.name;
    if(!repo)throw new Error('The local profile is unavailable.');
    return nativeOperation(()=>bridge.request({repo,operation,args})) as Promise<T>;
  },[client]);
  const [preferences, setPreferences] = useState<CommitPreferences | null>(null);
  const current = useRef<CommitPreferences | null>(null), sequence = useRef(0);
  const [loading, setLoading] = useState(enabled), [error, setError] = useState('');
  const [settingsRequest, setSettingsRequest] = useState(initialSettingsOpen ? 1 : 0);
  const [settingsClosed, setSettingsClosed] = useState(0);
  const accept = useCallback((value: CommitPreferences) => {
    if (!current.current || value.revision >= current.current.revision) {
      current.current = value;
      setPreferences(value);
    }
    return current.current;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {return accept(await requestPreferences<CommitPreferences>('getCommitPreferences'));}
    catch (reason) {if (request === sequence.current) setError((reason as Error).message); throw reason;}
    finally {if (request === sequence.current) setLoading(false);}
  }, [accept, requestPreferences]);
  const save = useCallback(async (input: CommitPreferencesInput) => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {accept(await requestPreferences<CommitPreferences>('setCommitPreferences', input));}
    catch (reason) {if (request === sequence.current) setError((reason as Error).message); throw reason;}
    finally {if (request === sequence.current) setLoading(false);}
  }, [accept, requestPreferences]);
  useEffect(() => {if (enabled) void refresh().catch(() => {});}, [enabled, refresh]);
  const openSettings = useCallback(() => setSettingsRequest(value => value + 1), []);
  const closeSettings = useCallback(() => setSettingsClosed(value => value + 1), []);
  const value = useMemo(() => ({preferences, loading, error, refresh, save, settingsRequest, settingsClosed, openSettings, closeSettings}),
    [preferences, loading, error, refresh, save, settingsRequest, settingsClosed, openSettings, closeSettings]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCommitPreferences() {return useContext(Context);}
