import React, {useEffect, useRef, useState} from 'react';
import {getNativeBridge, readRepositoryAsset} from './native-bridge.mjs';
import {localLink, type PreviewImage} from '../../apps/desktop/ui/markdown-preview.mjs';
import {isMediaFile} from './repository-file-session';
import {enhanceTechnicalPreview} from './technical-preview';
import './repository-document.css';

export const isRepositoryMedia = (path: string) => Boolean(getNativeBridge()) && isMediaFile(path);

function scrollToFragment(root: HTMLElement | null, fragment: string) {
  if (!root || !fragment) return;
  const target = Array.from(root.querySelectorAll<HTMLElement>('[id], [data-heading-anchor]'))
    .find(element => element.id === fragment || element.dataset.headingAnchor === fragment);
  if (target) {target.tabIndex = -1; target.focus({preventScroll: true}); target.scrollIntoView({block: 'start'});}
}

type DocumentProps = {
  repository: string; revision: string; sourcePath: string;
  rendered: {html: string; images: PreviewImage[]}; fragment?: string;
  onNavigate(path: string, fragment: string): void;
};

/** Markdown markup is inert until local links/assets pass the explicit catalog adapter. */
export function RepositoryDocument({repository, revision, sourcePath, rendered, fragment = '', onNavigate}: DocumentProps) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const controller = new AbortController(), urls: string[] = [];
    element.innerHTML = rendered.html;
    enhanceTechnicalPreview(element, controller.signal);
    const images = [...rendered.images];
    const load = async () => {
      while (images.length && !controller.signal.aborted) {
        const image = images.shift()!;
        const slot = element.querySelector<HTMLElement>(`[data-local-image="${image.id}"]`);
        const target = localLink(image.relativeUrl, sourcePath);
        if (!slot || !target) continue;
        try {
          const asset = await readRepositoryAsset({repo: repository, path: target.path, ref: revision}, controller.signal);
          if (controller.signal.aborted) return;
          if (!asset.mime.startsWith('image/')) throw new Error('This attachment is not an image.');
          const url = URL.createObjectURL(new Blob([asset.data], {type: asset.mime})); urls.push(url);
          const img = document.createElement('img');
          img.alt = image.alt; img.src = url; img.className = 'repository-local-image';
          img.addEventListener('error', () => {if (!controller.signal.aborted) {img.replaceWith(slot); slot.textContent = `${image.alt} — Image could not be decoded.`;}});
          slot.replaceWith(img);
        } catch (reason) {
          if (!controller.signal.aborted) slot.textContent = `${image.alt} — ${(reason as Error).message}`;
        }
      }
    };
    void Promise.all(Array.from({length: Math.min(3, images.length)}, load));
    return () => {controller.abort(); for (const url of urls) URL.revokeObjectURL(url);};
  }, [repository, revision, sourcePath, rendered]);
  useEffect(() => {scrollToFragment(root.current, fragment);}, [fragment, rendered]);
  return <article ref={root} onClick={event => {
    const anchor = (event.target as HTMLElement).closest('[data-local-link]');
    if (!anchor) return;
    event.preventDefault();
    const target = localLink(anchor.getAttribute('data-local-link') ?? '', sourcePath);
    if (!target) return;
    if (target.path === sourcePath && target.fragment) scrollToFragment(root.current, target.fragment);
    else onNavigate(target.path, target.fragment);
  }} dangerouslySetInnerHTML={{__html: rendered.html}}/>;
}

/** Media is always read-only; the same file tree and breadcrumb remain in place. */
export function RepositoryMedia({repository, revision, path}: {repository: string; revision: string; path: string}) {
  const selection = JSON.stringify([repository, revision, path]);
  const [asset, setAsset] = useState<{selection: string; url: string; mime: string} | null>(null), [failure, setFailure] = useState<{selection: string; message: string} | null>(null);
  const current = asset?.selection === selection ? asset : null;
  const error = failure?.selection === selection ? failure.message : '';
  useEffect(() => {
    const controller = new AbortController(); let url: string | undefined;
    setAsset(null); setFailure(null);
    void readRepositoryAsset({repo: repository, path, ref: revision}, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([result.data], {type: result.mime})); setAsset({selection, url, mime: result.mime});
    }).catch(reason => {if (!controller.signal.aborted) setFailure({selection, message: reason.message});});
    return () => {controller.abort(); if (url) URL.revokeObjectURL(url);};
  }, [repository, revision, path, selection]);
  return <div className="repository-media" aria-label="Local media preview">
    {error ? <p role="alert">{error}</p> : !current ? <p role="status">Loading local media…</p> : current.mime.startsWith('image/') ?
      <img key={current.url} src={current.url} alt={path.split('/').at(-1)} onError={() => setFailure({selection, message: 'This image could not be decoded.'})}/> :
      <video key={current.url} src={current.url} controls preload="metadata" aria-label={path.split('/').at(-1)} onError={() => setFailure({selection, message: 'This video format could not be played.'})}/>}
  </div>;
}
