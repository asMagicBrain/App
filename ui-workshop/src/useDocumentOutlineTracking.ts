import {useEffect, useState, type RefObject} from 'react';
import {EditorView} from '@codemirror/view';
import type {DocumentOutlineEntry} from './outline-model';

/** Measure the owning document; no secondary buffer or proportional scroll approximation. */
export function useDocumentOutlineTracking(mainWindow:RefObject<HTMLDivElement|null>, entries:readonly DocumentOutlineEntry[], documentName?:string) {
  const [activeId, setActiveId] = useState<string>();

  useEffect(() => {
    const main = mainWindow.current;
    if (!main || !entries.length) {setActiveId(undefined); return;}
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Preview, directory README and repository overview all use the same
      // source-heading IDs. Hidden editors must never win over rendered content.
      const content = [...main.querySelectorAll<HTMLElement>('.rfe-preview article, .rfe-directory-content article, .rc-document article, .rfe-source .cm-editor')]
        .find(element => element.getClientRects().length && !element.closest('[hidden]'));
      if (!content) {setActiveId(undefined); return;}
      let top = 0, bottom = window.innerHeight;
      let scroller: HTMLElement | undefined;
      for (let ancestor = content.classList.contains('cm-editor') ? content.querySelector<HTMLElement>('.cm-scroller') : content.parentElement; ancestor && main.contains(ancestor); ancestor = ancestor.parentElement) {
        const overflow = getComputedStyle(ancestor).overflowY;
        if (!/^(auto|scroll|hidden|clip)$/.test(overflow)) continue;
        const bounds = ancestor.getBoundingClientRect();
        top = Math.max(top, bounds.top + ancestor.clientTop);
        bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
        if (!scroller && /^(auto|scroll)$/.test(overflow) && ancestor.scrollHeight > ancestor.clientHeight + 1) scroller = ancestor;
      }
      if (bottom <= top) return;
      const readingTop = Math.min(top + 24, bottom - 1);
      let current = entries[0].id;
      if (content.classList.contains('cm-editor')) {
        const editor = EditorView.findFromDOM(content);
        if (!editor) return;
        // CM6's measured blocks handle wrapping, folds and virtualized lines.
        const from = editor.lineBlockAtHeight(Math.max(0, readingTop - editor.documentTop)).from;
        for (const entry of entries) {if (entry.from > from) break; current = entry.id;}
      } else {
        const headings = new Map([...content.querySelectorAll<HTMLElement>('[id]')].map(element => [element.id, element]));
        for (const entry of entries) {
          const heading = headings.get(entry.id);
          if (!heading) continue;
          if (heading.getBoundingClientRect().top > readingTop) break;
          current = entry.id;
        }
      }
      // The last short section may never reach the top of the reading viewport.
      if (scroller && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) current = entries.at(-1)!.id;
      setActiveId(previous => previous === current ? previous : current);
    };
    const schedule = () => {if (!frame) frame = requestAnimationFrame(measure);};
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document || target instanceof Element && (target.contains(main) || main.contains(target) && target.closest('.rfe-document-pane, .rc-scroll'))) schedule();
    };
    // Mode/file changes, asynchronous images and CM6 measurements can all move
    // headings without a user scroll. Coalesce their updates into one frame.
    const mutations = new MutationObserver(schedule);
    mutations.observe(main, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style']});
    const resize = new ResizeObserver(schedule);
    resize.observe(main);
    window.addEventListener('scroll', onScroll, {capture: true, passive: true});
    main.addEventListener('load', schedule, true);
    window.addEventListener('resize', schedule, {passive: true});
    schedule();
    return () => {
      cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      main.removeEventListener('load', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [mainWindow, entries, documentName]);

  return activeId;
}
