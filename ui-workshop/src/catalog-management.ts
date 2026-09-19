import type {ExplorerCommand} from './repository-explorer-model';

export type CatalogRepositoryOperation =
  | {kind:'rename';repository:string;name:string}
  | {kind:'duplicate';repository:string;name:string;requestId:string}
  | {kind:'trash';repository:string;requestId:string}
  | {kind:'restore';trashId:string;name:string};
export type CatalogEntryAction = {repository:string;path:string;type:'file'|'directory';command:ExplorerCommand|'rename'|'reveal'};
export type CatalogTarget = {kind:'root'} | {kind:'repository';repository:string} | {kind:'file'|'directory';repository:string;path:string};
export type CatalogCommand = 'open'|'new-repository'|'restore-repository'|'rename'|'duplicate'|'move'|'trash'|'reveal'|'copy-path'|'new-file'|'new-folder';
export type CatalogMenuAction = {id:CatalogCommand;label:string;disabled?:boolean;unavailable?:boolean;separator?:boolean;danger?:boolean;title?:string};

/** Both catalog entry points consume this single repository command list. */
export function repositoryMenuActions(repository:string,{defaultRepository,busy=false,manage=false,reveal=false,move=false,readOnly=false}:{defaultRepository:string;busy?:boolean;manage?:boolean;reveal?:boolean;move?:boolean;readOnly?:boolean}):CatalogMenuAction[] {
  return [
    {id:'open',label:'Open',disabled:busy},
    {id:'rename',label:'Rename',disabled:busy||!manage||readOnly,unavailable:false,separator:true},
    {id:'duplicate',label:'Duplicate…',disabled:busy||!manage,unavailable:false},
    {id:'move',label:'Move to…',disabled:busy||!move||readOnly,unavailable:!move},
    {id:'reveal',label:'Reveal the file',disabled:busy||!reveal,unavailable:false,separator:true},
    {id:'trash',label:'Move to Trash',disabled:busy||!manage||readOnly||repository===defaultRepository,unavailable:false,separator:true,danger:true,title:readOnly?'Bundled documentation stays available. Duplicate it to make an editable copy.':repository===defaultRepository?'The default repository must remain available.':undefined},
  ];
}
export function suggestDuplicateRepositoryName(repository:string,names:readonly string[]):string {
  const occupied=new Set(names.map(name=>name.toLocaleLowerCase()));
  for(let index=1;index<10000;index++){
    const suffix=index===1?'-copy':`-copy-${index}`;
    const value=repository.slice(0,100-suffix.length).replace(/\.+$/,'')+suffix;
    if(!occupied.has(value.toLocaleLowerCase()))return value;
  }
  return '';
}
