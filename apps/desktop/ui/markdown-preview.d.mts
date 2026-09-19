export const PREVIEW_LIMIT: number;
export type PreviewHeading = { id: string; level: number; title: string };
export type PreviewImage = { id: string; relativeUrl: string; alt: string };
export type PreviewOptions = { externalLinks?: boolean };
export function localLink(value: string, currentPath?: string): { path: string; fragment: string } | null;
export function renderSourcePreview(source: string, sourcePath?: string, options?: PreviewOptions): { html: string; headings: PreviewHeading[]; images: PreviewImage[]; limited: boolean };
