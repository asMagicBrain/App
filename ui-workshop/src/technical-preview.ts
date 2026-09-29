import {hydrateTechnicalDiagrams} from './technical-diagrams';
import 'katex/dist/katex.min.css';
import './technical-preview.css';
import './technical-diagrams.css';

/** Adds reader-only affordances; source and the CM6 document remain untouched. */
export function enhanceTechnicalPreview(root: HTMLElement, signal: AbortSignal) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  root.addEventListener('click', async event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy-math]');
    if (!button || !root.contains(button)) return;
    const source = button.closest<HTMLElement>('[data-math-source]')?.dataset.mathSource;
    if (source === undefined) return;
    event.preventDefault(); event.stopPropagation();
    let message = 'Copied';
    try {await navigator.clipboard.writeText(source);} catch {message = 'Copy failed';}
    if (signal.aborted || !button.isConnected) return;
    let status = button.parentElement?.querySelector<HTMLElement>('.technical-copy-status');
    if (!status) {
      status = document.createElement('span'); status.className = 'technical-copy-status';
      status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true'); button.after(status);
    }
    status.textContent = message;
    const target = status;
    const timer = setTimeout(() => {target.textContent = ''; timers.delete(timer);}, 2200);
    timers.add(timer);
  }, {signal});
  let theme = getComputedStyle(root).colorScheme.includes('dark') ? 'dark' as const : 'light' as const;
  const renderDiagrams = () => {void hydrateTechnicalDiagrams(root, {signal, theme});};
  renderDiagrams();
  const themeRoot = root.closest('.fw-window');
  const observer = new MutationObserver(() => {
    const current = getComputedStyle(root).colorScheme.includes('dark') ? 'dark' : 'light';
    if (current !== theme && !signal.aborted) {theme = current; renderDiagrams();}
  });
  if (themeRoot) observer.observe(themeRoot, {attributes: true, attributeFilter: ['style', 'class']});
  document.fonts?.ready.then(() => {
    if (!signal.aborted) root.dispatchEvent(new Event('asmb:preview-layout', {bubbles: true}));
  });
  signal.addEventListener('abort', () => {observer.disconnect(); for (const timer of timers) clearTimeout(timer); timers.clear();}, {once: true});
}
