# Prepare a portable interactive example

The host uses immutable, hash-pinned offline artifact snapshots. Markdown uses the `asmb-interactive` fence described in the standalone user guide `docs/interactive-examples.md`. Never insert repository JavaScript in the app renderer.

Put the manifest at the shared root of the HTML and its required assets. Generate an explicit inventory from saved regular files:

```sh
node tools/create-artifact-manifest.mjs \
  --root=/absolute/physical/example-folder \
  --output=rotation.artifact.json --id=teaching.rotation \
  --title='Frame rotation' --entry=media/rotation.html \
  --fallback=fallback.md --asset=media/rotation.js \
  --asset=fonts/MiSans-Regular.woff2 --asset=fonts/MiSans-LICENSE.txt
```

Use repeated `--asset=` arguments. This does not run scripts or automatically discover files. It validates admission before publishing the manifest. After editing saved assets, review those changes and pass `--replace` to regenerate their hashes. A linked root/file or missing/oversized asset refuses admission.

The native acceptance fixtures contain original illustrative saturation, sampling, coordinate and sensitivity examples. Their mathematical curves are intentionally separate from actual hardware datasets and simulation engines. Tests use isolated profiles and exact packaged source metadata. Parent screenshots alone omit a native child renderer; retain a child capture and geometry receipt as well.

For lifecycle qualification, retain native host state and window events throughout sustained repeated slider/tab input. `lastStop` keeps the disposing run identity, fixed cause and owner visibility/minimize/fullscreen/focus flags after disposal. Renderer stop requests accept only fixed causal labels; unknown labels are rejected. Hide/minimize still dispose immediately. Document intended page/navigation cleanup separately from unexpected stops; a stale native accessibility ID is not a renderer failure.

Native transition checks must also withhold owner animation frames: start, geometry and focus use a cancellable bounded layout schedule. A closed or superseded viewer cannot Run later. Visible child views keep window frames live; offscreen views resume throttling, and real hide/minimize still disposes. Show/restore/fullscreen events require fresh admitted geometry. Fixed run phases/native error codes are retained without exception text. Test screenshots and control changes separately from runtime status.
