import {useLayoutEffect, useRef, type RefObject} from 'react';
import type {EditorView} from '@codemirror/view';

type Point = {line: number; top: number; start?: boolean};
const inset = 20;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function interpolate(points: readonly Point[], value: number, input: 'line' | 'top', output: 'line' | 'top') {
  if (!points.length) return 0;
  if (value <= points[0][input]) return points[0][output];
  for (let index = 1; index < points.length; index++) {
    const next = points[index], previous = points[index - 1];
    if (value > next[input]) continue;
    const length = next[input] - previous[input];
    return previous[output] + (length > 0 ? (value - previous[input]) / length : 0) * (next[output] - previous[output]);
  }
  return points.at(-1)![output];
}

/** DOM block coordinates and CM6 logical lines share one monotone correspondence.
 * Interpolation is local to adjacent source blocks, never a document-wide ratio. */
function previewPoints(preview: HTMLElement, lines: number): Point[] {
  const top = preview.getBoundingClientRect().top, points = new Map<number, Point>();
  points.set(1, {line: 1, top: 0});
  const add = (line: number, y: number, start: boolean) => {
    if (!Number.isFinite(line) || line < 1 || line > lines + 1) return;
    const previous = points.get(line);
    if (!previous || (start && !previous.start) || (start === previous.start && y < previous.top)) points.set(line, {line, top: y, start});
  };
  for (const element of preview.querySelectorAll<HTMLElement>('[data-source-line]')) {
    const rect = element.getBoundingClientRect();
    if (!rect.height) continue;
    add(Number(element.dataset.sourceLine), rect.top - top + preview.scrollTop, true);
    add(Number(element.dataset.sourceEndLine), rect.bottom - top + preview.scrollTop, false);
  }
  const ordered = [...points.values()].sort((left, right) => left.line - right.line), monotone: Point[] = [];
  for (const point of ordered) {
    const last = monotone.at(-1);
    // Nested lists/tables and reference adapters can share mapped source lines.
    // Keep only forward-moving boundaries so either direction has one answer.
    if (!last || point.top > last.top + .5) monotone.push(point);
  }
  const last = monotone.at(-1);
  if (!last || last.line < lines + 1) monotone.push({line: lines + 1, top: Math.max(last?.top ?? 0, preview.scrollHeight)});
  return monotone;
}

function editorLine(view: EditorView) {
  const height = Math.max(0, view.scrollDOM.getBoundingClientRect().top + inset - view.documentTop);
  const block = view.lineBlockAtHeight(height), line = view.state.doc.lineAt(block.from).number;
  return line + clamp((height - block.top) / Math.max(1, block.height), 0, 1);
}

function editorTop(view: EditorView, line: number) {
  const number = clamp(Math.floor(line), 1, view.state.doc.lines), block = view.lineBlockAt(view.state.doc.line(number).from);
  const documentOffset = view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
  return documentOffset + block.top + clamp(line - number, 0, 1) * block.height - inset;
}

/** Synchronize without taking focus, moving the selection, or writing source. */
export function useDocumentSplitScroll({enabled, editor, reading, contentKey, resetKey}: {
  enabled: boolean;
  editor: RefObject<EditorView | null>;
  reading: RefObject<HTMLDivElement | null>;
  contentKey: string;
  resetKey: string | number;
}) {
  const refresh = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const view = editor.current, preview = reading.current;
    if (!enabled || !view || !preview) return;
    const source = view.scrollDOM;
    let live = true, frame = 0, lastDriver: 'source' | 'preview' = 'source';
    const current = () => live && editor.current === view && reading.current === preview && source.isConnected && preview.isConnected;
    let expectedSource: number | undefined, expectedPreview: number | undefined;
    const synchronize = (driver: 'source' | 'preview') => {
      if (!current() || !preview.getClientRects().length || !source.getClientRects().length) return;
      const points = previewPoints(preview, view.state.doc.lines);
      const origin = driver === 'source' ? source : preview, target = driver === 'source' ? preview : source;
      const originMax = Math.max(0, origin.scrollHeight - origin.clientHeight), targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
      let position: number;
      if (origin.scrollTop <= 1) position = 0;
      else if (originMax > 0 && origin.scrollTop >= originMax - 1) position = targetMax;
      else position = driver === 'source'
        ? interpolate(points, editorLine(view), 'line', 'top') - inset
        : editorTop(view, interpolate(points, preview.scrollTop + inset, 'top', 'line'));
      position = clamp(position, 0, targetMax);
      if (Math.abs(target.scrollTop - position) < .5) return;
      target.scrollTop = position;
      if (driver === 'source') expectedPreview = target.scrollTop;
      else expectedSource = target.scrollTop;
    };
    const schedule = (driver: 'source' | 'preview') => {
      if (!current()) return;
      lastDriver = driver;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {frame = 0; synchronize(driver);});
    };
    const sourceScroll = () => {
      if (expectedSource !== undefined && Math.abs(source.scrollTop - expectedSource) < 1) {expectedSource = undefined; return;}
      expectedSource = undefined; schedule('source');
    };
    const previewScroll = () => {
      if (expectedPreview !== undefined && Math.abs(preview.scrollTop - expectedPreview) < 1) {expectedPreview = undefined; return;}
      expectedPreview = undefined; schedule('preview');
    };
    const remeasure = () => {if (current()) {view.requestMeasure(); schedule(lastDriver);}};
    refresh.current = () => {if (current()) {view.requestMeasure(); schedule('source');}};
    source.addEventListener('scroll', sourceScroll, {passive: true});
    preview.addEventListener('scroll', previewScroll, {passive: true});
    preview.addEventListener('load', remeasure, true);
    const resize = new ResizeObserver(remeasure);
    resize.observe(source); resize.observe(preview);
    const article = preview.querySelector('article, .teach-markdown');
    if (article) resize.observe(article);
    schedule('source');
    return () => {
      live = false;
      cancelAnimationFrame(frame); resize.disconnect();
      source.removeEventListener('scroll', sourceScroll); preview.removeEventListener('scroll', previewScroll);
      preview.removeEventListener('load', remeasure, true); refresh.current = () => {};
    };
  }, [enabled, editor, reading, resetKey]);
  useLayoutEffect(() => {if (enabled) refresh.current();}, [enabled, contentKey]);
}
