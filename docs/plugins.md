# Plugins

[User guide](README.md)

Open **Plugins** in the left rail to enable the included tools. Disabling a plugin keeps your files, drafts and undo history. Installing third-party plugins is not available yet.

## Markdown tools

Check document statistics or add bold formatting to selected text. Formatting stays in your draft until you save.

## Pro Editor

Pro Editor is optional and included. It uses the same Markdown editor and files.

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
