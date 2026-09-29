import React, {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {teachingYears} from './teach-calendar.mjs';
import './teach-year-select.css';

type TeachYearSelectProps = {
  value:string;
  onChange(value:string):void;
  name?:string;
  required?:boolean;
  invalid?:boolean;
  autoFocus?:boolean;
};

/** A short viewport, with every supported year still reachable by scrolling or keyboard. */
export function TeachYearSelect({value,onChange,name,required=false,invalid=false,autoFocus=false}:TeachYearSelectProps) {
  const trigger=useRef<HTMLButtonElement>(null),requiredId=useId();
  const [host,setHost]=useState<HTMLElement|null>(null),[open,setOpen]=useState(false);
  const [currentYear]=useState(()=>Math.min(2100,Math.max(1949,new Date().getFullYear())));
  const positionYearMenu=useCallback((menu:HTMLDivElement|null)=>{
    if(!menu)return;
    const current=menu.querySelector<HTMLElement>(`[data-year="${currentYear}"]`);
    if(!current)return;
    // Run once per opening: ordinary renders must preserve the user's scroll position.
    current.focus({preventScroll:true});
    const top=menu.getBoundingClientRect().top+menu.clientTop+parseFloat(getComputedStyle(menu).paddingTop);
    menu.scrollTop+=current.getBoundingClientRect().top-top;
  },[currentYear]);
  useLayoutEffect(()=>{setHost(trigger.current?.closest<HTMLElement>('dialog')??trigger.current?.closest<HTMLElement>('.fw-window')??document.body);},[]);
  useEffect(()=>{if(autoFocus)trigger.current?.focus({preventScroll:true});},[autoFocus]);
  return <span className="tyear-select">
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild><button ref={trigger} className="tyear-trigger" type="button" name={name} value={value} aria-label="Year" aria-invalid={invalid||undefined} aria-describedby={required?requiredId:undefined}>
        <span>{value||'Choose a year'}</span><svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="m2 4 4 4 4-4Z"/></svg>
      </button></DropdownMenu.Trigger>
      {host&&<DropdownMenu.Portal container={host}><DropdownMenu.Content ref={positionYearMenu} className="tyear-menu" aria-label="Year" align="start" sideOffset={4} collisionPadding={8} loop onKeyDown={event=>event.stopPropagation()}>
        <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
          {teachingYears.map((year:number)=><DropdownMenu.RadioItem key={year} className="tyear-option" data-year={year} value={String(year)} textValue={String(year)}>
            <DropdownMenu.ItemIndicator className="tyear-check"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 8 3 3 7-7"/></svg></DropdownMenu.ItemIndicator>{year}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content></DropdownMenu.Portal>}
    </DropdownMenu.Root>
    {name&&<input type="hidden" name={name} value={value}/>}
    {required&&<span id={requiredId} className="tyear-sr-only">Required field.</span>}
  </span>;
}
