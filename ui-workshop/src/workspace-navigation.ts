import type {DocumentOutlineEntry} from './outline-model';
import type {ExplorerCommand} from './repository-explorer-model';

/** Saved search locations never replace a live editor buffer. */
export type WorkspaceLocation = {
  repo:string; path:string; ref?:string; type?:'file'|'directory';
  line?:number; column?:number; endColumn?:number; lineText?:string;
  /** Catalog menus enter the existing repository manager before executing. */
  entryAction?:{path:string;type:'file'|'directory';command:ExplorerCommand|'rename'};
};
export type NavigationRequest = WorkspaceLocation & {id:number};
export type OutlineState = {
  documentName:string; entries:DocumentOutlineEntry[];
  onSelect(entry:DocumentOutlineEntry):void;
};
export type SearchRequest = {mode:'files'|'content';repo:string|null;ref?:string;finder?:boolean};

export function isTypingTarget(target:EventTarget|null):boolean {
  return target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable=true],.cm-editor,[role=dialog],dialog'));
}

/** Content results use UTF-16 columns; refuse a stale saved-line selection. */
export function searchSelection(text:string,target:WorkspaceLocation):{from:number;to:number}|null {
  if(!target.line||target.line<1)return null;
  const lines=text.split('\n');
  const line=lines[target.line-1];
  if(line===undefined||target.lineText!==undefined&&line.replace(/\r$/,'')!==target.lineText.replace(/\r?\n$/,'').replace(/\r$/,''))return null;
  const start=lines.slice(0,target.line-1).reduce((offset,value)=>offset+value.length+1,0);
  const from=start+Math.min(line.length,Math.max(0,(target.column??1)-1));
  const to=start+Math.min(line.length,Math.max((target.column??1)-1,(target.endColumn??target.column??1)-1));
  return {from,to};
}
