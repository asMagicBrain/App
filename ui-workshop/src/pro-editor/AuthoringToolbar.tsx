import React from 'react';
import type {EditorView} from '@codemirror/view';
import {startCompletion} from '@codemirror/autocomplete';
import {formatCommand,insertTemplate, type Format, type Template} from './authoring';
export function AuthoringToolbar({editor,disabled}:{editor:()=>EditorView|null;disabled:boolean}){
 const mod=typeof navigator!=='undefined'&&/Mac/.test(navigator.platform)?'⌘':'Ctrl+';
 const run=(command:(view:EditorView)=>boolean)=>{const view=editor();if(disabled||!view)return;command(view);view.focus();};
 const controls:[string,Format,string][]=[['Bold','bold','B'],['Italic','italic','I'],['Strikethrough','strike',''],['Inline code','code','E'],['Link','link','K'],['Bullet list','bullet','Shift+8'],['Numbered list','ordered','Shift+7'],['Quote','quote','Shift+.']];
 return <div className="pro-authoring" role="group" aria-label="Markdown formatting">
  <label>Heading <select aria-label="Heading level" disabled={disabled} value="" onChange={e=>run(formatCommand(`heading${Number(e.target.value)}`))}><option value="" disabled>Choose…</option><option value="0">Paragraph ({mod}0)</option>{[1,2,3,4,5,6].map(n=><option key={n} value={n}>Heading {n} ({mod}{n})</option>)}</select></label>
  {controls.map(([label,kind,key])=><button key={kind} type="button" disabled={disabled} title={key?`${label} (${mod}${key})`:label} onMouseDown={e=>e.preventDefault()} onClick={()=>run(formatCommand(kind))}>{label}</button>)}
  <label>Insert <select aria-label="Insert Markdown" disabled={disabled} value="" onChange={e=>run(insertTemplate(e.target.value as Template))}><option value="" disabled>Choose…</option>{(['table','task','link','image','code','math','diagram'] as Template[]).map(t=><option key={t} value={t}>{t[0].toUpperCase()+t.slice(1)}</option>)}</select></label>
  <button type="button" disabled={disabled} title="Show suggestions (Ctrl+Space)" onMouseDown={e=>e.preventDefault()} onClick={()=>run(startCompletion)}>Suggestions</button>
 </div>;
}
