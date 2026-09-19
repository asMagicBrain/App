import React,{useRef} from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type {CatalogCommand,CatalogMenuAction} from './catalog-management';
import './repository-explorer.css';

type Props={actions:readonly CatalogMenuAction[];host:HTMLElement|null;onAction(command:CatalogCommand,trigger:HTMLElement|null):void};
function Items({actions,kind,onAction}:{actions:Props['actions'];kind:'context'|'dropdown';onAction(command:CatalogCommand):void}){
  const Item=kind==='context'?ContextMenu.Item:DropdownMenu.Item;
  const Separator=kind==='context'?ContextMenu.Separator:DropdownMenu.Separator;
  return <>{actions.map(action=><React.Fragment key={action.id}>{action.separator&&<Separator className="rex-menu-separator" data-unavailable={action.unavailable||undefined}/>}<Item className="rex-menu-item" disabled={action.disabled} data-unavailable={action.unavailable||undefined} data-danger={action.danger||undefined} title={action.title} onSelect={()=>onAction(action.id)}>{action.label}</Item></React.Fragment>)}</>;
}
export function CatalogGearMenu({repository,actions,host,onAction,busy=false,children}:Props&{repository:string;busy?:boolean;children:React.ReactNode}){
  const anchor=useRef<HTMLButtonElement>(null),selected=useRef(false);
  return <DropdownMenu.Root modal={false} onOpenChange={open=>{if(open)selected.current=false;}}><DropdownMenu.Trigger asChild><button ref={anchor} className="ar-settings" type="button" aria-label={`Repository actions for ${repository}`} title={`Repository actions for ${repository}`} disabled={busy} onClick={event=>event.stopPropagation()}>{children}</button></DropdownMenu.Trigger>{host&&<DropdownMenu.Portal container={host}><DropdownMenu.Content className="rex-menu ar-actions-menu" aria-label={`Repository actions for ${repository}`} align="end" sideOffset={4} collisionBoundary={host} collisionPadding={8} loop onKeyDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onCloseAutoFocus={event=>{if(selected.current)event.preventDefault();}}><Items kind="dropdown" actions={actions} onAction={command=>{selected.current=true;onAction(command,anchor.current);}}/></DropdownMenu.Content></DropdownMenu.Portal>}</DropdownMenu.Root>;
}
export function CatalogContextMenu({actions,host,onAction,label,children,onPrepare,busy=false}:Props&{label:string;children:React.ReactElement;onPrepare?():void;busy?:boolean}){
  const anchor=useRef<HTMLSpanElement>(null),selected=useRef(false);
  return <ContextMenu.Root modal={false} onOpenChange={open=>{if(open){selected.current=false;onPrepare?.();}}}><ContextMenu.Trigger ref={anchor} asChild disabled={busy} onKeyDown={event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();event.stopPropagation();if(!busy&&anchor.current){const box=anchor.current.getBoundingClientRect();anchor.current.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+12,clientY:box.top+Math.min(16,box.height/2)}));}}}}>{children}</ContextMenu.Trigger>{host&&<ContextMenu.Portal container={host}><ContextMenu.Content className="rex-menu ar-actions-menu" aria-label={label} collisionBoundary={host} collisionPadding={8} loop onKeyDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onCloseAutoFocus={event=>{event.preventDefault();if(!selected.current)anchor.current?.focus();}}><Items kind="context" actions={actions} onAction={command=>{selected.current=true;onAction(command,anchor.current);}}/></ContextMenu.Content></ContextMenu.Portal>}</ContextMenu.Root>;
}
