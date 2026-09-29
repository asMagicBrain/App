/** Session-only reading history. Contains positions, never document bytes or authority. */
export const READING_HISTORY_LIMIT = 100;
const modes = new Set(['preview', 'source', 'visual', 'split']);
function text(value, max) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/u.test(value); }
function offset(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 100000000; }
export function readingLocation(value) {
  if (!value || value.schemaVersion !== 1 || !text(value.repoId, 256) || !value.repoId || !text(value.repo, 256) || !value.repo || !text(value.ref, 1024) || !text(value.path, 2048) || value.path.startsWith('/') || value.path.includes('\\') || value.path.split('/').some(part => part === '..' || part === '.') || !['file','directory'].includes(value.type) || !modes.has(value.mode) || typeof value.editing !== 'boolean') throw new Error('Invalid reading location.');
  if (value.fragment !== undefined && !text(value.fragment, 2048)) throw new Error('Invalid reading target.');
  if (!value.selection || !offset(value.selection.anchor) || !offset(value.selection.head) || !value.scroll || !['main','source','preview'].every(key => Number.isFinite(value.scroll[key]) && value.scroll[key] >= 0 && value.scroll[key] <= 100000000)) throw new Error('Invalid reading position.');
  return {schemaVersion:1,repoId:value.repoId,repo:value.repo,ref:value.ref,path:value.path,type:value.type,mode:value.mode,editing:value.editing,visual:value.visual===true,fragment:value.fragment??'',selection:{anchor:value.selection.anchor,head:value.selection.head},scroll:{main:value.scroll.main,source:value.scroll.source,preview:value.scroll.preview}};
}
const identity = item => JSON.stringify([item.repoId,item.ref,item.path,item.type,item.fragment]);
export class ReadingHistory {
  #entries=[]; #index=-1; #generation=0; #pending=null; #serial=0;
  constructor(limit=READING_HISTORY_LIMIT) { if (!Number.isSafeInteger(limit)||limit<2||limit>READING_HISTORY_LIMIT) throw new Error('Invalid history bound.'); this.limit=limit; }
  state() { return {back:this.#index>0,forward:this.#index>=0&&this.#index<this.#entries.length-1,count:this.#entries.length,index:this.#index}; }
  current() { return this.#index<0?null:structuredClone(this.#entries[this.#index]); }
  checkpoint(value) { const next=readingLocation(value); if (this.#index<0) return this.visit(next); if(identity(next)!==identity(this.#entries[this.#index])) return this.state(); this.#entries[this.#index]=next;return this.state(); }
  visit(value) { const next=readingLocation(value); if(this.#index>=0&&identity(next)===identity(this.#entries[this.#index]))return this.checkpoint(next);this.#entries.splice(this.#index+1);this.#entries.push(next);if(this.#entries.length>this.limit)this.#entries.shift();this.#index=this.#entries.length-1;this.#generation++;this.#pending=null;return this.state(); }
  peek(direction) { if(direction!==-1&&direction!==1)throw new Error('Invalid history direction.');const index=this.#index+direction;if(index<0||index>=this.#entries.length)return null;const token=`${++this.#serial}:${this.#generation}`;this.#pending={token,index,generation:this.#generation};return{token,location:structuredClone(this.#entries[index])}; }
  complete(token,value) {const pending=this.#pending,next=readingLocation(value);if(!pending||pending.token!==token||pending.generation!==this.#generation||identity(next)!==identity(this.#entries[pending.index]))throw new Error('This reading navigation is stale.');this.#index=pending.index;this.#entries[this.#index]=next;this.#generation++;this.#pending=null;return this.state();}
  cancel(token) {if(this.#pending?.token===token)this.#pending=null;return this.state();}
  removeRepository(repoId) {const current=this.#entries[this.#index];this.#entries=this.#entries.filter(item=>item.repoId!==repoId);this.#index=current&&current.repoId!==repoId?this.#entries.indexOf(current):Math.min(this.#index,this.#entries.length-1);this.#pending=null;this.#generation++;return this.state();}
  renamePaths(repoId,moves) {for(const item of this.#entries){if(item.repoId!==repoId)continue;for(const move of moves){if(item.path===move.from||item.path.startsWith(`${move.from}/`)){item.path=move.to+item.path.slice(move.from.length);break;}}}this.#pending=null;this.#generation++;return this.state();}
  clear(){this.#entries=[];this.#index=-1;this.#pending=null;this.#generation++;return this.state();}
}

/** Saving/checkpointing drafts is mandatory; recording reading position is not.
 * A failed optional history write must never make a successfully retained draft
 * impossible to leave or close. Preservation failures still reject unchanged. */
export async function preserveBeforeNavigation(preserve,checkpoint){
 await preserve();
 try{return {historyState:await checkpoint(),historyUnavailable:false};}
 catch{return {historyState:null,historyUnavailable:true};}
}
