export type RepositoryNameOrder = 'asc' | 'desc';
import {isDocumentationRepository} from './repository-capabilities.mjs';

/** Pin groups dominate the selected name order without changing catalog data. */
export function orderRepositories<T extends {name:string;builtin?:string;readOnly?:boolean}>(repositories:readonly T[],defaultRepository:string,pinnedRepositories:readonly string[],order:RepositoryNameOrder='asc'):T[] {
  const pins=new Set(pinnedRepositories);
  const group=(name:string)=>name===defaultRepository?0:pins.has(name)?1:2;
  return [...repositories].sort((a,b)=>{
    const docs=Number(isDocumentationRepository(a))-Number(isDocumentationRepository(b));if(docs)return docs;
    const rank=group(a.name)-group(b.name);if(rank)return rank;
    const name=a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'})||a.name.localeCompare(b.name);
    return order==='asc'?name:-name;
  });
}

export function isRepositoryPinned(name:string,defaultRepository:string,pinnedRepositories:readonly string[]):boolean {
  return name===defaultRepository||pinnedRepositories.includes(name);
}
