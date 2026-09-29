import React, {useEffect, useMemo, useState} from 'react';
import {RepositoryFileEditor} from '../RepositoryFileEditor';
import {NativePluginProvider, NativePluginManager, PluginsIcon, usePluginHost} from '../NativePluginHost';
import type {LocalWorkspaceClient, WorkspaceDocument} from '../local-workspace-client';
import {proEditorManifest} from './manifest';
import themes from '../github-themes/themes.json';
import '../focused-writing.css';
import './pro-editor.css';

export const proStudySource = '\ufeff# Engineering notes\r\n\r\nA local Markdown document with equations, diagrams and plain source.\n\n'
  + '## Equation\n\n$$\nT = \\begin{bmatrix} \\cos\\theta & -\\sin\\theta & x \\\\ \\sin\\theta & \\cos\\theta & y \\\\ 0 & 0 & 1 \\end{bmatrix}\n$$\n\n'
  + '## Diagram\n\n```mermaid\nflowchart LR\n  A[Joint angle] --> B[Transform]\n  B --> C[Tool position]\n```\n\n'
  + '## Source remains available\n\nInline $x^2$ and unsupported blocks stay in source while editing.\n\n'
  + '> $$\n> Nested equations keep their original Markdown structure.\n> $$\n\n'
  + '## Local syntax diagnostics\n\n$$\\notARealCommand{x}$$\n\n'
  + '```mermaid\nflowchart LR\n  A-->B\n  click A "https://example.invalid"\n```\n\nEnd of document.\r';

/** Explicit in-memory test seam for the shared editor. It never calls a native
 * file writer and is not evidence for filesystem/Git or packaged acceptance. */
function studyWorkspace(): LocalWorkspaceClient {
  const files = new Map([['README.md', proStudySource]]), drafts = new Map<string, string>();
  const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
  const open = async (path: string): Promise<WorkspaceDocument> => {
    const text = files.get(path); if (text === undefined) throw Error('This sample file is unavailable.');
    const sourceHash = await digest(text);
    return {path, documentId: `pro-study:${path}`, sourceHash, text, readOnly: false,
      draft: drafts.has(path) ? {text: drafts.get(path)!, baseHash: sourceHash} : null};
  };
  return {async bootstrap() {return {local: true, newDrafts: []};}, async request<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
    const path = String(args.path ?? '');
    let result: unknown;
    if (operation === 'open') result = await open(path);
    else if (operation === 'discover') result = {entries: [...files.keys()].map(path => ({path, type: 'file'}))};
    else if (operation === 'runtimeStatus') result = {recoveryRequired: false};
    else if (operation === 'checkpoint') {drafts.set(path, String(args.text)); result = {};}
    else if (operation === 'discard') {drafts.delete(path); result = {};}
    else if (operation === 'save') {
      if (files.get(path) === undefined || await digest(files.get(path)!) !== args.baseHash) throw Error('This sample changed. Reload the story to start again.');
      files.set(path, String(args.text)); drafts.delete(path); result = await open(path);
    } else if (operation === 'gitStatus') result = {initialized: false, files: []};
    else throw Error('This operation is unavailable in the in-memory editor study.');
    return result as T;
  }};
}

function ProEditorStudyContent() {
  const host = usePluginHost();
  const [workspace] = useState(studyWorkspace), [manager, setManager] = useState(false), [dark, setDark] = useState(false);
  const theme = themes.find(theme => theme.id === (dark ? 'dark-default' : 'light-default'))!;
  const style = useMemo(() => ({...theme.variables,
    ...Object.fromEntries(Object.entries(theme.variables).map(([key, value]) => [key.replace('--ws-', '--fw-'), value])),
    colorScheme: theme.appearance}) as React.CSSProperties, [theme]);
  useEffect(() => {void host?.registry.enable(proEditorManifest.id);}, [host]);
  return <div className="fw-window pro-study" style={style}>
    <header className="fw-titlebar"><span className="pro-study-brand">as</span><span>asMagicBrain</span><span aria-hidden="true">/</span><strong>Pro Editor</strong><span className="fw-spacer"/><button className="pro-study-theme" onClick={() => setDark(value => !value)}>{dark ? 'Light theme' : 'Dark theme'}</button></header>
    <div className="pro-study-notice">Storybook study · Edits and Save stay in memory. Reload to restore the sample.</div>
    <div className="fw-body"><nav className="fw-rail" aria-label="Plugins"><button className="fw-icon" aria-label="Manage plugins" title="Manage plugins" onClick={() => setManager(true)}><PluginsIcon/></button><button className="fw-icon" aria-label="Open Pro Editor" title="Pro Editor" onClick={() => setManager(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 4h16v16H4zM7 8h10M7 12h6M7 16h10"/></svg></button></nav>
      <main className="fw-main">{manager && <NativePluginManager onReturn={() => setManager(false)}/>}<div className="pro-study-document" hidden={manager}>
        <RepositoryFileEditor repository="Pro-Editor-Study" initialPath="README.md" initialSource={proStudySource} revision="" branch="main" branches={['main']} tags={[]} workspace={workspace} onClose={() => setManager(true)} commit={null}/>
      </div></main>
    </div>
  </div>;
}
export function ProEditorStudy() {return <NativePluginProvider><ProEditorStudyContent/></NativePluginProvider>;}
