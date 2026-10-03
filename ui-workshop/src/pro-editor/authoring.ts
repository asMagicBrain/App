import {Prec, type Extension} from '@codemirror/state';
import {EditorView, keymap, type Command} from '@codemirror/view';
import {syntaxTree} from '@codemirror/language';
import {autocompletion, completionKeymap, acceptCompletion, completionStatus, closeCompletion, startCompletion, snippet, snippetCompletion, type CompletionContext, type Completion} from '@codemirror/autocomplete';

export type Format = 'bold'|'italic'|'strike'|'code'|'link'|'bullet'|'ordered'|'quote'|`heading${number}`;
const delimiters = {bold:'**',italic:'*',strike:'~~',code:'`'};
function inCode(state: CompletionContext['state'], pos:number, inline=true) {
 for(let n=syntaxTree(state).resolveInner(pos,-1);n;n=n.parent!)if(/^(FencedCode|CodeBlock|HTMLBlock)$/.test(n.name)||(inline&&n.name==='InlineCode'))return true;
 return false;
}
export const writable=(view:EditorView)=>!view.state.readOnly&&!view.composing&&!view.compositionStarted;
/** Every authoring action dispatches through the existing CM6 session. */
export function formatCommand(kind:Format):Command{return view=>{
 if(!writable(view))return false;
 const {state}=view,r=state.selection.main;const from=r.from,to=r.to,text=state.doc.sliceString(from,to);
 if(inCode(state,from,kind!=='code'))return false;
 if(kind in delimiters){
  const mark=delimiters[kind as keyof typeof delimiters];
  const exactEdges=kind!=='italic'||(!text.startsWith('**')&&!text.endsWith('**'));
  if(kind==='code'&&/\n/.test(text))return false;
  if(exactEdges&&text.startsWith(mark)&&text.endsWith(mark)&&text.length>=mark.length*2){
   view.dispatch({changes:[{from,to:from+mark.length,insert:''},{from:to-mark.length,to,insert:''}],selection:{anchor:from,head:to-2*mark.length},userEvent:'input.format'});return true;
  }
  const surrounded=(kind!=='italic'||(state.doc.sliceString(Math.max(0,from-2),from)!=='**'&&state.doc.sliceString(to,to+2)!=='**'))&&from>=mark.length&&state.doc.sliceString(from-mark.length,from)===mark&&state.doc.sliceString(to,to+mark.length)===mark;
  const insert=text||'text';
  view.dispatch({changes:surrounded?[{from:from-mark.length,to:from,insert:''},{from:to,to:to+mark.length,insert:''}]:from===to?[{from,to,insert:mark+insert+mark}]:[{from,to:from,insert:mark},{from:to,to,insert:mark}],selection:{anchor:surrounded?from-mark.length:from+mark.length,head:surrounded?to-mark.length:from+mark.length+insert.length},userEvent:'input.format'});return true;
 }
 if(kind==='link'){for(let n=syntaxTree(state).resolveInner(from,1);n;n=n.parent!){if(n.name==='Link'){const url=n.getChild('URL');if(url){view.dispatch({selection:{anchor:url.from,head:url.to}});return true;}}}const label=text||'text';view.dispatch({changes:from===to?[{from,to,insert:`[${label}](destination)`}]:[{from,to:from,insert:'['},{from:to,to,insert:'](destination)'}],selection:{anchor:from+label.length+3,head:from+label.length+14},userEvent:'input.format'});return true;}

 const first=state.doc.lineAt(from).number,last=state.doc.lineAt(to>from&&state.doc.lineAt(to).from===to?to-1:to).number;
 const lines=Array.from({length:last-first+1},(_,i)=>state.doc.line(first+i));
 const expression=kind==='bullet'?/^(\s*)[-+*] /:kind==='ordered'?/^(\s*)\d+[.)] /:kind==='quote'?/^(\s*)> ?/:/^(\s*)#{1,6} /;
 const remove=!kind.startsWith('heading')&&lines.every(l=>expression.test(l.text));
 const changes=lines.map((l,i)=>{const indent=l.text.match(/^\s*/)?.[0]??'',match=l.text.match(expression),heading=Number(kind.slice(7));const prefix=remove?'':kind==='bullet'?'- ':kind==='ordered'?`${i+1}. `:kind==='quote'?'> ':heading>0?'#'.repeat(heading)+' ':'';return{from:l.from+indent.length,to:l.from+(match?match[0].length:indent.length),insert:prefix};});
 view.dispatch({changes,userEvent:'input.format'});return true;
};}
export const templates={
 table:'| ${Column 1} | ${Column 2} |\n| --- | --- |\n| ${Value 1} | ${Value 2} |',
 task:'- [ ] ${Task}',link:'[${text}](${destination})',image:'![${description}](${path})',
 code:'```${language}\n${code}\n```',math:'$$\n${E = mc^2}\n$$',diagram:'```mermaid\nflowchart LR\n  ${A[Start] --> B[Finish]}\n```',
};
export type Template=keyof typeof templates;
export const insertTemplate=(kind:Template):Command=>view=>{if(!writable(view))return false;const r=view.state.selection.main;const block=!['link','image'].includes(kind),prefix=block&&r.from>0&&view.state.doc.sliceString(r.from-1,r.from)!=='\n'?'\n\n':'';snippet(prefix+templates[kind]+(block?'\n':''))(view,null,r.from,r.to);return true;};
const languages=['text','python','javascript','typescript','json','bash','html','css','yaml','sql','cpp','mermaid'];
export function relativeLink(from:string,target:string){const parent=from.split('/').slice(0,-1),parts=target.split('/');while(parent.length&&parts.length&&parent[0]===parts[0]){parent.shift();parts.shift();}return [...parent.map(()=>'..'),...parts.map(p=>encodeURIComponent(p).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()))].join('/');}
export function completionSource(files:()=>string[],path:()=>string,enabled:()=>boolean=()=>true){return(context:CompletionContext)=>{
 if(context.state.readOnly||!enabled())return null;
 const line=context.state.doc.lineAt(context.pos),before=line.text.slice(0,context.pos-line.from);
 const fence=/^\s*```([\w-]*)$/.exec(before);
 if(fence)return{from:context.pos-fence[1].length,options:languages.map(label=>({label,type:'type'})),validFor:/^[\w-]*$/};
 if(inCode(context.state,context.pos))return null;
 const link=/(!?\[[^\]\n]*\]\()([^\s)]*)$/.exec(before);
 if(link){const image=link[1].startsWith('!');const options:Completion[]=Array.from(new Set(files())).filter(p=>!image||/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p)).map(p=>({label:relativeLink(path(),p),detail:p,type:'file'}));return{from:context.pos-link[2].length,options,validFor:/^[^\s)]*$/};}
 const slash=/^\s*\/([\w-]*)$/.exec(before);
 if(slash||context.explicit){const options=Object.entries(templates).map(([label,value])=>snippetCompletion(value,{label,type:'keyword',detail:'Markdown snippet'}));return{from:slash?context.pos-slash[1].length-1:context.pos,options,filter:!slash, ...(slash?{options:options.filter(o=>o.label.startsWith(slash[1]))}:{} )};}
 return null;
};}
export function authoringExtensions(files:()=>string[],path:()=>string,enabled:()=>boolean):Extension{
 const bindings:[string,Format][]=[['Mod-b','bold'],['Mod-i','italic'],['Mod-e','code'],['Mod-k','link'],['Mod-Shift-7','ordered'],['Mod-Shift-8','bullet'],['Mod-Shift-.','quote'],...Array.from({length:7},(_,i)=>[`Mod-${i}`,`heading${i}`] as [string,Format])];
 return [autocompletion({override:[completionSource(files,path,enabled)],defaultKeymap:false,interactionDelay:0}),Prec.highest(keymap.of([
  ...completionKeymap.filter(b=>!['Enter','Tab','Ctrl-Space','Escape'].includes(b.key??'')),
  ...bindings.map(([key,kind])=>({key,run:formatCommand(kind)})),
  {key:'Ctrl-Space',run:startCompletion},
  {key:'Tab',run:(view:EditorView)=>completionStatus(view.state)==='active'&&writable(view)?acceptCompletion(view):false},
  {key:'Escape',run:closeCompletion},
  {key:'Enter',run:(view:EditorView)=>{closeCompletion(view);return false;}},
 ].map(binding=>({...binding,run:(view:EditorView)=>enabled()&&writable(view)?binding.run!(view):false}))))];
}
