import type {LocalWorkspaceClient,WorkspaceDocument,WorkspaceEntry} from './local-workspace-client';
/** Storybook-only storage. Never imports the native bridge or calls fetch. */
export function createTeachSpacesMemory(initial:Record<string,string>){
 const files=new Map(Object.entries(initial)),folders=new Set<string>(),drafts=new Map<string,{text:string;baseHash:string}>(),newDrafts=new Map<string,{draftId:string;path:string;text:string}>();
 const trash=new Map<string,{path:string;files:[string,string][]}>();
 const hash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
 const entries=():WorkspaceEntry[]=>{const dirs=new Set(folders);for(const path of files.keys()){const parts=path.split('/');for(let n=1;n<parts.length;n++)dirs.add(parts.slice(0,n).join('/'));}return [...dirs].map(path=>({path,type:'directory' as const})).concat([...files.keys()].map(path=>({path,type:'file' as any}))).sort((a,b)=>a.path.localeCompare(b.path));};
 const open=async(path:string):Promise<WorkspaceDocument>=>{if(!files.has(path))throw Error('Sample file not found.');return {path,documentId:`spaces:${path}`,sourceHash:await hash(files.get(path)!),text:files.get(path)!,readOnly:false,draft:drafts.get(path)??null};};
 const readSnapshot=async(path:string)=>{if(files.has(path))return {type:'file' as const,content:files.get(path)!,entries:[],commit:null};const prefix=path?path+'/':'';return {type:'directory' as const,content:null,entries:entries().filter(e=>e.path.startsWith(prefix)&&!e.path.slice(prefix.length).includes('/')).map(e=>({...e,name:e.path.split('/').at(-1)!})),readmePath:files.has(prefix+'README.md')?prefix+'README.md':null,readme:files.get(prefix+'README.md')??null,commit:null};};
 const client:LocalWorkspaceClient={async bootstrap(){return {local:true,newDrafts:[...newDrafts.values()]};},async request<T>(operation:string,args:Record<string,unknown>={}):Promise<T>{
  const path=String(args.path??'');let value:unknown;
  if(operation==='open')value=await open(path);
  else if(operation==='discover')value={entries:entries()};
  else if(operation==='runtimeStatus')value={recoveryRequired:false};
  else if(operation==='checkpoint'){drafts.set(path,{text:String(args.text),baseHash:String(args.baseHash)});value={};}
  else if(operation==='checkpointNew'){newDrafts.set(String(args.draftId),{draftId:String(args.draftId),path,text:String(args.text)});value={};}
  else if(operation==='discardNew'){newDrafts.delete(String(args.draftId));value={};}
  else if(operation==='discard'){drafts.delete(path);value={};}
  else if(operation==='save'){if(!files.has(path)||await hash(files.get(path)!)!==args.baseHash)throw Error('Sample source conflict.');files.set(path,String(args.text));drafts.delete(path);value=await open(path);}
  else if(operation==='create'){if(entries().some(e=>e.path===path))throw Error('Sample destination exists.');files.set(path,String(args.text));value=await open(path);}
  else if(operation==='createFolder'){if(entries().some(e=>e.path===path))throw Error('Sample destination exists.');folders.add(path);value={};}
  else if(operation==='gitStatus')value={initialized:false,files:[]};
  else if(operation==='listTrash')value=[...trash].map(([trashId,x])=>({trashId,path:x.path,type:x.files.length===1&&x.files[0][0]===x.path?'file':'directory',deletedAt:Date.now()}));
  else if(operation==='restore'){const id=String(args.trashId),x=trash.get(id);if(!x)throw Error('Sample trash item unavailable.');if(entries().some(e=>e.path===x.path))throw Error('Sample restore destination exists.');for(const [p,t] of x.files)files.set(p,t);trash.delete(id);value={path:x.path,changedPaths:x.files.map(([p])=>p)};}
  else if(operation==='emptyTrash'){for(const id of args.trashIds as string[])trash.delete(id);value={status:'completed',operation:'empty-trash',items:[],pathMoves:[],changedPaths:[]};}
  else if(operation==='inspectEntry'){value={token:await hash(files.get(path)??path)};}
  else if(operation==='inspect'){value=await Promise.all((args.paths as string[]).map(async p=>({path:p,expectedHash:await hash(files.get(p)??p),type:files.has(p)?'file':'directory'})));}
  else if(operation==='manage'){
   const kind=String(args.operation),items=args.items as {path:string;newPath?:string}[],moves:{from:string;to:string}[]=[],changed:string[]=[];
   for(const item of items){const selected=[...files].filter(([p])=>p===item.path||p.startsWith(item.path+'/'));if(kind!=='trash'&&(!item.newPath||entries().some(e=>e.path===item.newPath)))throw Error('Sample destination exists.');
    if(kind==='trash'){trash.set(crypto.randomUUID(),{path:item.path,files:selected});for(const [p] of selected)files.delete(p);folders.delete(item.path);}
    else{for(const [p,t] of selected){const next=item.newPath!+p.slice(item.path.length);files.set(next,t);changed.push(next);if(kind==='move')files.delete(p);}if(!selected.length)folders.add(item.newPath!);if(kind==='move'){folders.delete(item.path);moves.push({from:item.path,to:item.newPath!});}}
    changed.push(item.path);
   }value={status:'completed',operation:kind,items,pathMoves:moves,changedPaths:changed};
  }else throw Error('Unavailable in this session-only Storybook sample. No filesystem or GitHub action was performed.');
  return value as T;
 }};
 return {client,readSnapshot};
}
