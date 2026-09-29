import {StateEffect, StateField, type EditorState, type Extension} from '@codemirror/state';
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate} from '@codemirror/view';
import {renderSourcePreview} from '../../../apps/desktop/ui/markdown-preview.mjs';
import {findProVisualBlocks, proBlockSelected, type ProVisualBlock} from './blocks.mjs';

/** Composition affects presentation only; IME input stays in CM6's source. */
export const proComposition = StateEffect.define<boolean>();
type WidgetLife = {controller: AbortController; frame: number | null};
const widgetLives = new WeakMap<HTMLElement, WidgetLife>();
class ProBlockWidget extends WidgetType {
  readonly block: ProVisualBlock;
  constructor(block: ProVisualBlock) {super(); this.block = block;}
  eq(other: ProBlockWidget) {return this.block.kind === other.block.kind && this.block.from === other.block.from && this.block.to === other.block.to && this.block.source === other.block.source;}
  toDOM(view: EditorView) {
    const root = document.createElement('div'); root.className = 'pro-visual-widget'; root.contentEditable = 'false';
    root.dataset.proBlock = this.block.kind;
    const life: WidgetLife = {controller: new AbortController(), frame: null}; widgetLives.set(root, life);
    const header = document.createElement('div'); header.className = 'pro-visual-heading';
    const label = document.createElement('span'); label.textContent = this.block.kind === 'equation' ? 'Equation' : 'Diagram';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit source';
    edit.setAttribute('aria-label', `Edit ${this.block.kind} source`);
    edit.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (life.controller.signal.aborted || view.composing || view.compositionStarted) return;
      // The widget can disappear between pointer events. Never apply a position
      // from a different source generation, even though this is selection only.
      if (view.state.doc.sliceString(this.block.from, this.block.to) !== this.block.source) return;
      view.dispatch({selection: {anchor: this.block.from}, effects: EditorView.scrollIntoView(this.block.from, {y: 'nearest'})});
      view.focus();
    }, {signal: life.controller.signal});
    header.append(label, edit);
    const preview = document.createElement('div'); preview.className = 'pro-visual-preview';
    preview.innerHTML = renderSourcePreview(this.block.source, '', {technical: true}).html;
    root.append(header, preview);
    const measure = () => {
      if (life.controller.signal.aborted || life.frame !== null) return;
      life.frame = requestAnimationFrame(() => {life.frame = null; if (!life.controller.signal.aborted) view.requestMeasure();});
    };
    preview.addEventListener('asmb:preview-layout', measure, {signal: life.controller.signal});
    void import('../technical-preview.ts').then(({enhanceTechnicalPreview}) => {
      if (!life.controller.signal.aborted) {enhanceTechnicalPreview(preview, life.controller.signal); measure();}
    }).catch(() => {
      if (life.controller.signal.aborted) return;
      const notice = document.createElement('p'); notice.className = 'pro-visual-error';
      notice.textContent = 'Preview is unavailable. Use Edit source to continue.'; preview.append(notice); measure();
    });
    return root;
  }
  destroy(root: HTMLElement) {
    const life = widgetLives.get(root); if (!life) return;
    life.controller.abort(); if (life.frame !== null) cancelAnimationFrame(life.frame); widgetLives.delete(root);
  }
  ignoreEvent() {return true;}
}
type VisualState = {blocks: readonly ProVisualBlock[]; composing: boolean; decorations: DecorationSet};
function decorate(blocks: readonly ProVisualBlock[], state: EditorState, composing: boolean) {
  if (composing) return Decoration.none;
  return Decoration.set(blocks.filter(block => !proBlockSelected(block, state.selection))
    .map(block => Decoration.replace({widget: new ProBlockWidget(block), block: true, inclusive: false}).range(block.from, block.to)), true);
}
/** StateField provides block replacements before viewport layout. The existing
 * session compartment owns installation/removal; this never creates an editor. */
export const proVisualState = StateField.define<VisualState>({
  create(state) {const blocks = findProVisualBlocks(state.doc.toString()); return {blocks, composing: false, decorations: decorate(blocks, state, false)};},
  update(value, transaction) {
    let composing = value.composing;
    for (const effect of transaction.effects) if (effect.is(proComposition)) composing = effect.value;
    if (!transaction.docChanged && !transaction.selection && composing === value.composing) return value;
    const blocks = transaction.docChanged ? findProVisualBlocks(transaction.state.doc.toString()) : value.blocks;
    return {blocks, composing, decorations: decorate(blocks, transaction.state, composing)};
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
// No-wrap source may be wider than its viewport. Keep rendered block controls
// within the visible editor width instead of stretching them to the longest
// source line. This view plugin measures geometry only, never supplies blocks.
const visualGeometry = ViewPlugin.fromClass(class {
  view: EditorView; alive = true; width = -1;
  constructor(view: EditorView) {this.view = view; this.measure();}
  update(update: ViewUpdate) {if (update.geometryChanged || update.viewportChanged) this.measure();}
  measure() {
    this.view.requestMeasure({key: this,
      read: view => Math.max(100, Math.floor(view.scrollDOM.clientWidth -
        (view.contentDOM.getBoundingClientRect().left - view.scrollDOM.getBoundingClientRect().left + view.scrollDOM.scrollLeft) - 12)),
      write: width => {if (this.alive && width !== this.width) {this.width = width; this.view.contentDOM.style.setProperty('--pro-content-width', `${width}px`);}},
    });
  }
  destroy() {this.alive = false; this.view.contentDOM.style.removeProperty('--pro-content-width');}
});
export function createProVisualExtension(): Extension {
  return [proVisualState, visualGeometry, EditorView.domEventHandlers({
    compositionstart(_event, view) {view.dispatch({effects: proComposition.of(true)}); return false;},
    compositionend(_event, view) {view.dispatch({effects: proComposition.of(false)}); return false;},
  })];
}
