# Bundled plugin contracts

[Architecture](architecture.md) · [User guide](../docs/plugins.md)

Host API **1**, manifest schema **1**, currently supports explicitly bundled first-party modules. There is no third-party package installer or dynamic plugin loader. Imported artifact scripts require the separate explicit review and execution boundary below. Registry metadata is not an isolation boundary.

## Manifest and registration

The authoritative types and validators are in [`contracts.ts`](../ui-workshop/src/plugin-foundation/contracts.ts). A manifest declares a stable plugin ID, semantic version, inclusive host API range, capability names and prefixed contribution IDs. Unknown fields, unsupported schemas, undeclared commands and incompatible ranges are refused. The application imports a module and calls `registerBundled`; manifests contain no executable URL or entry path.

[`Markdown tools`](../ui-workshop/src/bundled-markdown-tools.ts) is a complete example. Its requested `document.read` / `document.edit` capabilities also require a separate host-owned allowlist. Enabling it activates its declared commands; disabling revokes access and removes contributions. Preference persistence belongs to the host UI.

## Document authority

[`repository-document-session.ts`](../ui-workshop/src/repository-document-session.ts) owns retained CM6 state, selection, history and the existing raw-source buffer. It permits only one attached view and detaches view callbacks on unmount. A contribution compartment can change without replacing state or history. Save, rename, draft checkpoints and Git still use the existing workspace service; plugin transactions are draft edits, not implicit saves.

Each operation binds repository, ref, session, path, saved source hash, monotonic source/selection version, read-only and conflict state. The renderer host rechecks these values, composition, cancellation and current UI admission immediately before applying a transaction. A stale request is refused, never automatically retried. New file Save can update identity without rebuilding its CM6 history.

The contribution renderer accepts host-owned command buttons, statistics and navigation. Bundled Pro presentation is an explicit host integration with the same session authority. Arbitrary plugin React pages or CM6 extensions are not admitted through manifest data.

## Lifecycle and failures

[`registry.ts`](../ui-workshop/src/plugin-foundation/registry.ts) owns activation scopes, command handlers, capability leases, cancellable tasks and disposables. Document replacement cancels scoped work. Disable, failed activation/command and host disposal revoke grants and clean up resources. Late results are dropped. Ordinary operation refusals return bounded codes and operation IDs; raw errors and document source are not published as diagnostics.

Cancellation is cooperative for trusted code. It does not preempt a blocked JavaScript thread. Untrusted interactive documents therefore require a separate, qualified execution boundary. The Stage 2 future-artifact schema only validates proposed data/decision identity; it cannot execute content or establish sandboxing. Stage 3 execution uses the distinct native implementation below.

## Verification

Run the source suites and `npm run typecheck`. [`plugin-foundation.mjs`](../apps/native/acceptance/plugin-foundation.mjs) qualifies actual packaged controls, one editor, undo, drafts, Save, selected-file commit and normal restart against synthetic data. Pure tests separately cover injected incompatible/failing modules and denied/stale operations; do not describe those as arbitrary native plugin-loading support.

## Stage 3: optional Pro Editor

The included `asmagicbrain.pro-editor` module uses the same document capability grants as Markdown tools. Equation/diagram insertions are checked transactions; Source/Visual reconfigures the retained session contribution compartment. CM6 StateField decorations provide presentation only. Code remains complete source, unsupported constructs stay visible, and raw-source history remains authoritative. The shared Split hook maps source lines to rendered blocks without changing selection or source.

The native artifact host is a separate execution boundary. `artifact-snapshot.mjs` admits only a managed working-tree HTML or `.artifact.json` file. Manifest-listed bytes are read with physical path/descriptor checks and held in memory. Review identity includes content, physical identities and runtime policy. Run rechecks that identity. The application renderer receives review data, never executable HTML in its DOM.

`artifact-host.mjs` creates an unprivileged WebContentsView within the existing window, an ephemeral session, strict response policy and read-only snapshot resolver. Main-process request admission, blocked transport, permissions, native navigation and lifecycle controls remain required even when the bundled plugin is enabled. No shell, account, preload or general filesystem bridge exists in the view. Stop, close, route changes and plugin disable dispose it. Resource bounds are admission/watchdog limits rather than universal frame-rate or hard OS memory guarantees.

Do not use the Stage 2 proposal validator as proof of native execution support. Qualify actual artifacts and hostile requests using the native Pro acceptance campaign on each supported platform. A new source dependency or runtime policy requires new execution review; no portable approval or persisted model/view state is inferred.

### Offline artifact manifest

A manifest ends in `.artifact.json`. All paths are relative to its directory. Declare every dependency and the text fallback; PNG posters are optional. The schema accepts only the fields below. Standalone `.html` needs no manifest, but receives no additional files.

```json
{
  "schemaVersion": 1,
  "id": "engineering.slider",
  "title": "Slider example",
  "entryPath": "index.html",
  "fallbackPath": "fallback.md",
  "network": "none",
  "assets": [
    {"path": "index.html", "role": "entry", "bytes": 123, "sha256": "<64 lowercase hexadecimal characters>"},
    {"path": "fallback.md", "role": "fallback", "bytes": 45, "sha256": "<64 lowercase hexadecimal characters>"}
  ]
}
```

Replace the illustrative byte counts and hashes with the actual files' values. Other roles are `script`, `style` and `data`; optional `posterPath` must identify a declared PNG data asset. Limits: 64 assets, 2 MiB per asset, 8 MiB total, 64 KiB manifest; a poster is at most 4096 × 4096. Approval is not portable or persisted. Run rechecks file bytes, physical identities and policy; editing an asset requires updated hashes and a new review.

The current runtime permits ordinary inline/local JavaScript and local modules, Canvas 2D and a qualified small WebGL2 example. It blocks workers, arbitrary nested frames, remote resources and WASM. Run lasts at most ten minutes, load at most fifteen seconds; renderer memory is sampled against 512 MiB. Sampling and unresponsive events do not provide hard CPU/GPU quotas. Persistent view state and general physics/3D-engine compatibility are not claimed.
