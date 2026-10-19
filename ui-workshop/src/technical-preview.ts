import {installDocumentClipboard} from './document-clipboard.mjs';
import {copyWorkspaceText} from './native-bridge.mjs';
import {hydrateTechnicalDiagrams} from './technical-diagrams';
import 'katex/dist/katex.min.css';
import './technical-preview.css';
import './technical-diagrams.css';

/** Adds reader-only affordances; source and the CM6 document remain untouched. */
export function enhanceTechnicalPreview(root: HTMLElement, signal: AbortSignal) {
  installDocumentClipboard(root, signal);
  let menu: HTMLElement | null = null;
  let menuMath: HTMLElement | null = null;
  const close = () => {menu?.remove(); menu = null;};
  const open = (math: HTMLElement, x: number, y: number) => {
    close(); menuMath = math;
    menu = document.createElement('div'); menu.className = 'technical-math-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Equation');
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = 'Copy TeX'; button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {void copyWorkspaceText(math.dataset.mathSource ?? '').then(() => {close(); math.focus({preventScroll:true});}).catch(() => {button.textContent = 'Copy failed — retry';});}, {signal});
    menu.append(button); document.body.append(menu);
    menu.style.left = `${Math.max(0, Math.min(x, innerWidth-menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, innerHeight-menu.offsetHeight))}px`;
    button.focus();
  };
  for (const math of root.querySelectorAll<HTMLElement>('[data-math-source]')) {
    math.tabIndex = 0;
    math.setAttribute('aria-label', 'Equation; context menu offers Copy TeX');
  }
  root.addEventListener('contextmenu', event => {
    const math = (event.target as Element).closest<HTMLElement>('[data-math-source]');
    if (!math || !root.contains(math)) return;
    event.preventDefault(); open(math, event.clientX, event.clientY);
  }, {signal});
  root.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const math = (event.target as Element).closest<HTMLElement>('[data-math-source]');
    if (!math) return;
    event.preventDefault(); const rect = math.getBoundingClientRect(); open(math, rect.left, rect.bottom);
  }, {signal});
  document.addEventListener('pointerdown', event => {if (menu && !menu.contains(event.target as Node)) close();}, {signal});
  document.addEventListener('keydown', event => {if (menu && (event.key === 'Escape' || event.key === 'Tab')) {event.stopPropagation(); if(event.key === 'Escape')event.preventDefault(); close(); menuMath?.focus({preventScroll:true});}}, {signal,capture:true});
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
  signal.addEventListener('abort', () => {observer.disconnect(); close();}, {once: true});
}
