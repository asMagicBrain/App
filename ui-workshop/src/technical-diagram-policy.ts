/** Deliberately small, static subset. These are admission limits, not timeouts. */
export const DIAGRAM_RENDERER_VERSION = 'mermaid@11.17.2/static-svg-v1';
export const DIAGRAM_LIMITS = Object.freeze({source: 8192, lines: 80, tokens: 600, nodes: 48, edges: 80, depth: 4, blocks: 16, svgBytes: 524288, svgNodes: 4000, cacheEntries: 32, cacheBytes: 2097152});
export type DiagramKind = 'flowchart' | 'sequence' | 'state';

export function admitDiagramSource(source: string): DiagramKind {
  if (!source.trim()) throw Error('The diagram is empty.');
  if (source.length > DIAGRAM_LIMITS.source || source.split(/\r\n?|\n/).length > DIAGRAM_LIMITS.lines) throw Error('Diagram limit: use at most 8,192 characters and 80 lines.');
  if (/%%\s*\{|^\s*---|<\s*[a-z/!]|&|(?:javascript|data|https?|file):|@\{|\$\$/im.test(source)) throw Error('Diagram configuration, HTML, links and embedded content are disabled.');
  if (/:::|\b(?:click|callbacks?|classDef|style|linkStyle|cssClass)\b|(?:^|[;\n\r])\s*(?:links?|class)\b/i.test(source)) throw Error('Diagram links, callbacks and custom styles are disabled.');
  const text = source.replace(/^\s*%%[^\n\r]*/gm, '').trim();
  const header = text.split(/[\n\r;]/, 1)[0].trim();
  const kind = /^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\s*$/.test(header) ? 'flowchart'
    : header === 'sequenceDiagram' ? 'sequence'
    : header === 'stateDiagram-v2' ? 'state' : null;
  if (!kind) throw Error('Supported diagrams: flowchart, sequenceDiagram and stateDiagram-v2.');
  if ((text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) > DIAGRAM_LIMITS.tokens) throw Error('Diagram limit: too many labels or statements.');
  if ((text.match(/-->|==>|-\.->|->>|-->>|->|--x|--\)|--o|--\|/g)?.length ?? 0) > DIAGRAM_LIMITS.edges) throw Error('Diagram limit: use at most 80 edges or messages.');
  let depth = 0;
  for (const line of text.split(/[\n\r;]/)) {
    if (/^\s*(?:subgraph\b|state\b[^\n]*\{)/.test(line) || (kind === 'sequence' && /^\s*(?:loop|alt|opt|par|critical|break|rect|box)\b/.test(line))) depth++;
    if (depth > DIAGRAM_LIMITS.depth) throw Error('Diagram limit: nesting is limited to four levels.');
    if (/^\s*(?:end\b|\})/.test(line)) depth = Math.max(0, depth - 1);
  }
  return kind;
}

type DiagramDatabase = {
  getVertices?: () => Map<unknown, unknown>;
  getEdges?: () => unknown[];
  getActors?: () => Map<unknown, unknown>;
  getMessages?: () => unknown[];
  getStates?: () => Map<unknown, unknown>;
  getRelations?: () => unknown[];
  getData?: () => {nodes?: unknown[]; edges?: unknown[]};
};

/** Inspect the parsed graph before Dagre/layout, including nested state nodes. */
export function admitDiagramGraph(kind: DiagramKind, input: unknown) {
  const database = input as DiagramDatabase;
  const data = kind === 'state' ? database.getData?.() : undefined;
  const nodes = kind === 'flowchart' ? database.getVertices?.().size : kind === 'sequence' ? database.getActors?.().size : data?.nodes?.length;
  const edges = kind === 'flowchart' ? database.getEdges?.().length : kind === 'sequence' ? database.getMessages?.().length : data?.edges?.length;
  if (!Number.isInteger(nodes) || !Number.isInteger(edges)) throw Error('This diagram cannot be checked against the static rendering limits.');
  if (nodes! > DIAGRAM_LIMITS.nodes || edges! > DIAGRAM_LIMITS.edges) throw Error('Diagram limit: use at most 48 nodes and 80 edges or messages.');
  return {nodes: nodes!, edges: edges!};
}
