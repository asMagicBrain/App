export type ProVisualBlock = Readonly<{kind: 'equation' | 'diagram'; from: number; to: number; source: string}>;
export const PRO_VISUAL_LIMITS: Readonly<{document: number; blocks: number; diagrams: number; block: number; renderedSource: number}>;
export function findProVisualBlocks(source: string): readonly ProVisualBlock[];
export function proBlockSelected(block: ProVisualBlock, selection: {ranges: readonly {from: number; to: number}[]}): boolean;
