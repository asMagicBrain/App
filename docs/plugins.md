# Plugins

[User guide](README.md)

Open **Plugins** in the left rail to install and manage local `.asmbplugin` files. Choose **Install plugin…**, review its publisher, version and access, then install it. Packages are checked before installation and stay in private application storage outside your repositories.

The manager separates **Bundled** and **Installed** plugins. This version bundles no optional plugins. Markdown editing is part of asMagicBrain itself. Disabling or uninstalling a plugin keeps repository files, drafts, undo history and Git history.

## Markdown editing

Check document statistics or add bold formatting to selected text. These core tools stay available without installing a plugin. Formatting stays in your draft until you save.

## Pro Editor

Pro Editor is separately installable. Download `asMagicBrain-Pro-Editor-0.1.0.asmbplugin` from the same [GitHub release](https://github.com/asMagicBrain/App/releases) as the app, verify it against that release's `SHA256SUMS`, install it through **Plugins**, then enable it. It uses the same Markdown editor and files.

The package contains no executable code. Its exact verified identity activates Pro Editor code already reviewed and compiled with asMagicBrain. A changed or third-party package remains inert declarative content and cannot activate application code.

- **Source** shows your Markdown. **Visual** displays supported equations and Mermaid diagrams in place; select **Edit source** to change one.
- **Insert equation** and **Insert diagram** add a starting example at your selection.
- **Split** shows the editor and a live preview with synchronized scrolling.
- Unsupported Markdown stays available as source. Save and Git commits remain separate.

Ordinary math and diagram reading works without Pro Editor.

### Local interactive views

With Pro Editor enabled, open a local `.html` file or `.artifact.json` package and choose **Review interactive view**. Review the listed files, then choose **Run interactive view**. Nothing runs just because you open a repository.

The view runs inside the app with network, account access, popups and downloads blocked. **Stop**, **Source** and **Static fallback** keep a reading option available. **Reset** restarts the example and its controls without changing your files. Closing the view disposes it.

Standalone HTML can use its own embedded code. Additional local scripts and images need a manifest listing their hashes. Changed content needs another review. One interactive view can run at a time, for up to ten minutes. WebGL depends on the computer's graphics support; source and static fallback remain available when it cannot run.

Viewing state is not saved between runs. Workers, WebRTC, remote resources and physics/WASM engines are unsupported. [Offline reading exports](packages-and-export.md) keep interactive HTML as inactive source.

asTeach is still being designed and is not included in the native application yet.

## Update or remove a plugin

Plugin updates are manual in this preview. Download the new `.asmbplugin`, choose **Install plugin…**, and review it as a new package. The previous exact package is retained for **Restore previous version**. **Uninstall** removes the package and its retained previous version while keeping repositories, drafts and Git history.
