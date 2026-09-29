import {admitDiagramGraph, admitDiagramSource, DIAGRAM_LIMITS, DIAGRAM_RENDERER_VERSION} from './technical-diagram-policy';
import {sanitizeDiagramSvg} from './technical-diagram-svg';

type Theme = 'light' | 'dark';
type Options = {signal?: AbortSignal; theme?: Theme};
type CacheEntry = {source: string; svg: string};
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0, renderSerial = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
const generations = new WeakMap<HTMLElement, object>();
const layoutChanged = (root: HTMLElement) => root.dispatchEvent(new Event('asmb:preview-layout', {bubbles: true}));

function remember(key: string, entry: CacheEntry) {
  const size = (entry.source.length + entry.svg.length) * 2;
  if (size > DIAGRAM_LIMITS.cacheBytes) return;
  while (cache.size >= DIAGRAM_LIMITS.cacheEntries || cacheBytes + size > DIAGRAM_LIMITS.cacheBytes) {
    const oldest = cache.keys().next().value!; const previous = cache.get(oldest)!;
    cacheBytes -= (previous.source.length + previous.svg.length) * 2; cache.delete(oldest);
  }
  cache.set(key, entry); cacheBytes += size;
}

async function render(source: string, theme: Theme, active: () => boolean): Promise<string> {
  const kind = admitDiagramSource(source);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const key = `${DIAGRAM_RENDERER_VERSION}:${theme}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const hit = cache.get(key);
  if (hit?.source === source) {cache.delete(key); cache.set(key, hit); return hit.svg;}
  if (!active()) throw Error('Diagram rendering cancelled.');
  const {default: mermaid} = await import('mermaid');
  if (!active()) throw Error('Diagram rendering cancelled.');
  mermaid.initialize({startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default', fontFamily: 'sans-serif', htmlLabels: false,
    maxTextSize: DIAGRAM_LIMITS.source, maxEdges: DIAGRAM_LIMITS.edges,
    deterministicIds: true, deterministicIDSeed: key, arrowMarkerAbsolute: false,
    flowchart: {htmlLabels: false, defaultRenderer: 'dagre-wrapper', useMaxWidth: false},
    sequence: {useMaxWidth: false}, state: {useMaxWidth: false},
  });
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  admitDiagramGraph(kind, diagram.db);
  if (!active()) throw Error('Diagram rendering cancelled.');
  // Mermaid measures SVG text via the DOM. This trusted temporary mount is
  // separate from document content and always removed. It shares the renderer
  // context and is NOT an isolation boundary; strict source admission comes first.
  // Layout runs synchronously: admission bounds are NOT a hard time deadline.
  const mount = document.createElement('div'); mount.className = 'technical-diagram-measure'; mount.setAttribute('aria-hidden', 'true');
  document.body.append(mount);
  try {
    const result = await mermaid.render(`asmb-mermaid-${++renderSerial}`, source, mount);
    if (!active()) throw Error('Diagram rendering cancelled.');
    const svg = new XMLSerializer().serializeToString(sanitizeDiagramSvg(result.svg));
    remember(key, {source, svg}); return svg;
  } finally {mount.remove();}
}

function createBlock(slot: HTMLElement, source: string, index: number) {
  slot.classList.add('technical-diagram');
  const caption = document.createElement('figcaption'); caption.textContent = `Diagram ${index + 1}`;
  const status = document.createElement('p'); status.className = 'technical-diagram-status'; status.setAttribute('role', 'status'); status.textContent = 'Rendering diagram…';
  const controls = document.createElement('div'); controls.className = 'technical-diagram-controls';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy source';
  const enlarge = document.createElement('button'); enlarge.type = 'button'; enlarge.textContent = 'Enlarge'; enlarge.disabled = true; enlarge.setAttribute('aria-pressed', 'false');
  const copyFeedback = document.createElement('span'); copyFeedback.className = 'technical-diagram-copy-feedback'; copyFeedback.setAttribute('role', 'status');
  controls.append(copy, enlarge, copyFeedback);
  const viewport = document.createElement('div'); viewport.className = 'technical-diagram-viewport'; viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', `Diagram ${index + 1}; scroll to explore enlarged diagram`);
  const details = document.createElement('details'); details.className = 'technical-diagram-source';
  const summary = document.createElement('summary'); summary.textContent = 'Diagram source (text alternative)';
  const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = source; pre.append(code); details.append(summary, pre);
  const descriptionId = `asmb-diagram-source-${++renderSerial}`; code.id = descriptionId;
  copy.addEventListener('click', async () => {
    try {await navigator.clipboard.writeText(source); copyFeedback.textContent = 'Copied';}
    catch {details.open = true; const range = document.createRange(); range.selectNodeContents(code); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); copyFeedback.textContent = 'Source selected; use Copy.';}
    setTimeout(() => {copyFeedback.textContent = '';}, 2500);
  });
  enlarge.addEventListener('click', () => {
    const expanded = viewport.classList.toggle('is-enlarged'); enlarge.setAttribute('aria-pressed', String(expanded)); enlarge.textContent = expanded ? 'Fit diagram' : 'Enlarge'; layoutChanged(slot);
  });
  details.addEventListener('toggle', () => layoutChanged(slot));
  slot.replaceChildren(caption, controls, status, viewport, details);
  return {status, viewport, details, enlarge, descriptionId};
}

/** Hydrate only renderer-issued inert Mermaid slots. Caller aborts when replacing
 * a document/theme. All source remains text; no Mermaid bindFunctions is called.
 */
export async function hydrateTechnicalDiagrams(root: HTMLElement, options: Options = {}): Promise<void> {
  const generation = {}; generations.set(root, generation);
  const active = () => !options.signal?.aborted && generations.get(root) === generation;
  const theme = options.theme ?? (getComputedStyle(root).colorScheme.includes('dark') ? 'dark' : 'light');
  const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-diagram]')).slice(0, DIAGRAM_LIMITS.blocks + 1);
  const jobs: Promise<void>[] = [];
  for (const [index, slot] of slots.entries()) {
    if (index >= DIAGRAM_LIMITS.blocks) {
      let notice = slot.querySelector<HTMLElement>('.technical-diagram-limit');
      if (!notice) {notice = document.createElement('p'); notice.className = 'technical-diagram-status technical-diagram-limit is-error'; slot.prepend(notice);}
      notice.textContent = 'Document limit: only the first 16 diagrams are rendered. Additional diagrams remain as source.';
      slot.dataset.diagramState = 'error'; layoutChanged(slot); continue;
    }
    const source = slot.querySelector('code')?.textContent ?? '';
    const ui = createBlock(slot, source, index);
    const fail = (message: string) => {ui.status.textContent = `Diagram ${index + 1}: ${message}`; ui.status.classList.add('is-error'); ui.details.open = true; slot.dataset.diagramState = 'error'; layoutChanged(slot);};
    slot.dataset.diagramState = 'pending';
    try {admitDiagramSource(source);}
    catch (error) {fail((error as Error).message); continue;}
    const job = renderQueue.then(async () => {
      if (!active() || !root.contains(slot)) return;
      // Yield between blocks so navigation/edits can invalidate queued work.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (!active() || !root.contains(slot)) return;
      try {
        const markup = await render(source, theme, active);
        if (!active() || !root.contains(slot)) return;
        const svg = sanitizeDiagramSvg(markup); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Diagram ${index + 1}`); svg.setAttribute('aria-describedby', ui.descriptionId);
        ui.viewport.append(svg); ui.enlarge.disabled = false; ui.status.textContent = ''; slot.dataset.diagramState = 'ready'; layoutChanged(slot);
      } catch (error) {
        if (active() && root.contains(slot)) fail(error instanceof Error && /^Diagram|^Supported|^This diagram|^The diagram/.test(error.message) ? error.message : 'Could not render this source. Check the diagram syntax.');
      }
    });
    renderQueue = job.catch(() => {}); jobs.push(job);
  }
  await Promise.all(jobs);
}
