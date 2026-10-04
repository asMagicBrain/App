import React from 'react';
import {createRoot} from 'react-dom/client';
import {getNativeBridge} from '../../../ui-workshop/src/native-bridge.mjs';
import {installNativeCloseRouter} from '../../../ui-workshop/src/native-close-router.mjs';
import type {NativeAppearance, NativeBuildConfiguration} from '../../../ui-workshop/src/native-types';
import {loadNativeBuildConfiguration} from './build-configuration.mjs';
import themes from '../../../ui-workshop/src/github-themes/themes.json';
import './native.css';

// Keep the startup status independent of the large workspace/editor bundle.
// Appearance still loads before mounting the workspace, preserving saved defaults.
const openingWorkspace = <main className="native-startup" role="status">Opening your local workspace…</main>;

/** The standalone application uses exactly the shared repository/CM6 interface. */
export function NativeApp({appearance, buildConfiguration, Workspace}: {appearance: NativeAppearance; buildConfiguration: NativeBuildConfiguration; Workspace: typeof import('../../../ui-workshop/src/FocusedWriting').FocusedWriting}) {
  return <Workspace repositoryHeader repositoryCode initialRepository="Workspace" buildChannel={buildConfiguration.channel}
    initialTheme={appearance.themeId} initialHideUnavailable={appearance.hideUnavailable}/>;
}

const element = document.getElementById('root');
if (!element) throw new Error('The native application root is missing.');
const root = createRoot(element);
const nativeBridge = getNativeBridge();
if (nativeBridge) installNativeCloseRouter(nativeBridge);

async function start() {
  root.render(openingWorkspace);
  try {
    const bridge = nativeBridge;
    if (!bridge) throw new Error('The native workspace connection is unavailable.');
    // No appearance write occurs during mount. Load the saved values before the
    // first shared-UI render so its defaults cannot overwrite persisted choices.
    const [appearance, buildConfiguration, workspace] = await Promise.all([bridge.getAppearance(), loadNativeBuildConfiguration(bridge), import('../../../ui-workshop/src/FocusedWriting')]);
    if (!appearance || typeof appearance.hideUnavailable !== 'boolean' ||
        (appearance.themeId !== null && !themes.some(theme => theme.id === appearance.themeId))) {
      throw new Error('The saved appearance could not be read. Your settings have not been changed.');
    }
    root.render(<NativeApp appearance={appearance} buildConfiguration={buildConfiguration} Workspace={workspace.FocusedWriting}/>);
  } catch (reason) {
    root.render(<main className="native-startup"><h1>Could not open the workspace</h1>
      <p role="alert">{reason instanceof Error ? reason.message : 'The local connection failed.'}</p>
      <button onClick={() => {void start();}}>Retry</button></main>);
  }
}

void start();
