import React, {useLayoutEffect, useRef, useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type {TeachCourseSummary} from './TeachCoursesStudy';
import type {TeachStudyCourse} from './teach-plugin-fixture';
import {teachDisplaySource} from './teach-content.mjs';
import {groupTeachCourses,teachCourseKey,teachTermLabel,selectCurrentTeachTerm,isTeachTermActive,sortTeachTerms} from './teach-course-groups';
import type {TeachCalendarState} from './TeachCalendarStudy';

type Action = () => boolean | void;
type Choice = {id:string;label:string;description?:string;accessibleName?:string;disabled?:boolean;current?:boolean;handoffFocus?:boolean;onSelect?:(returnFocus?:HTMLButtonElement|null)=>boolean|void};
type ChoiceGroup = {id:string;title:string;choices:readonly Choice[]};
type Props = {
  courses:readonly TeachStudyCourse[];
  homeActive?:boolean;
  calendarState:TeachCalendarState;
  activeCourse?:TeachStudyCourse;
  summaries:Record<string,TeachCourseSummary>;
  onCourses:Action;
  onHome:Action;
  onCourse(code:string):boolean|void;
  onAddTerm(code:string,returnFocus?:HTMLButtonElement|null):boolean|void;
  onTerm(id:string):boolean|void;
  onPage(id:string):boolean|void;
};

function Triangle() {
  return <svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="m2 4 4 4 4-4Z"/></svg>;
}

function ChoiceMenu({label,title,groups,disabled=false,compact=false}: {
  label:string;title:string;groups:readonly ChoiceGroup[];disabled?:boolean;compact?:boolean;
}) {
  const trigger=useRef<HTMLButtonElement>(null),handingOffFocus=useRef(false);
  const [host,setHost]=useState<HTMLElement|null>(null),[open,setOpen]=useState(false);
  useLayoutEffect(()=>{
    setHost(trigger.current?.closest<HTMLElement>('.fw-window')??null);
    const breakpoint=window.matchMedia('(max-width:760px)');
    const closeOnLayoutChange=()=>setOpen(false);
    breakpoint.addEventListener('change',closeOnLayoutChange);
    return()=>breakpoint.removeEventListener('change',closeOnLayoutChange);
  },[]);
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={value=>{if(value)handingOffFocus.current=false;setOpen(value);}}>
    <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className={compact?'pws-breadcrumb-overflow':'pws-breadcrumb-triangle'} aria-label={label} title={label} disabled={disabled}>{compact?<svg viewBox="0 0 18 18" aria-hidden="true" fill="currentColor"><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><circle cx="15" cy="9" r="1.4"/></svg>:<Triangle/>}</button></DropdownMenu.Trigger>
    {host&&<DropdownMenu.Portal container={host}><DropdownMenu.Content className="pws-ancestor-menu" aria-label={title} align="start" sideOffset={4} collisionBoundary={host} collisionPadding={8} loop onKeyDown={event=>event.stopPropagation()} onCloseAutoFocus={event=>{
      if(handingOffFocus.current){event.preventDefault();return;}
      if(!trigger.current?.getClientRects().length){
        event.preventDefault();
        const selector=window.matchMedia('(max-width:760px)').matches?'.pws-breadcrumb-overflow':'.pws-breadcrumb-root button';
        host.querySelector<HTMLButtonElement>(selector)?.focus({preventScroll:true});
      }
    }}>
      {groups.map((group,index)=><React.Fragment key={group.id}>{index>0&&<DropdownMenu.Separator className="pws-ancestor-separator"/>}<DropdownMenu.Group aria-label={group.title}>
        <DropdownMenu.Label className="pws-ancestor-current">{group.title}</DropdownMenu.Label>
        {group.choices.map(choice=><DropdownMenu.Item key={choice.id} className="pws-ancestor-item" aria-label={choice.accessibleName??choice.label} aria-description={choice.description} aria-current={choice.current?'page':undefined} disabled={choice.disabled} onSelect={event=>{
          handingOffFocus.current=Boolean(choice.handoffFocus);
          const accepted=choice.onSelect?.(trigger.current);
          if(accepted===false){handingOffFocus.current=false;event.preventDefault();}
        }}><strong>{choice.label}</strong>{choice.description&&<span>{choice.description}</span>}</DropdownMenu.Item>)}
      </DropdownMenu.Group></React.Fragment>)}
    </DropdownMenu.Content></DropdownMenu.Portal>}
  </DropdownMenu.Root>;
}

export function TeachBreadcrumb({courses,homeActive=false,activeCourse,calendarState,summaries,onHome,onCourses,onCourse,onAddTerm,onTerm,onPage}:Props) {
  const selectedCode=activeCourse?.code;
  const summary=activeCourse?summaries[activeCourse.id]:undefined;
  const homeTitle='Instructor page';
  const sectionId=summary?.sectionId??'home',sectionTitle=summary?.sectionTitle??homeTitle;
  const readySections=new Set(summary?.readySectionIds??(activeCourse?.reference?.pages.filter(page=>teachDisplaySource(page.source).trim()).map(page=>page.id)??[]));
  const pageAvailable=sectionId==='home'||sectionId==='student'||sectionId==='calendar'||readySections.has(sectionId);
  const courseGroups=groupTeachCourses(courses);
  const uniqueCourses=courseGroups.map(group=>selectCurrentTeachTerm(group.terms,calendarState.terms)!);
  const terms=selectedCode?courseGroups.find(group=>teachCourseKey(group.course.code)===teachCourseKey(selectedCode))?.terms??[]:[];
  const courseGroup:ChoiceGroup={id:'courses',title:'Courses',choices:uniqueCourses.length?uniqueCourses.map(course=>({
    id:course.code,label:course.code,description:course.title,accessibleName:`${course.code} — ${course.title}`,current:Boolean(selectedCode&&teachCourseKey(course.code)===teachCourseKey(selectedCode)),
    handoffFocus:course.id!==activeCourse?.id,onSelect:()=>onCourse(course.code),
  })):[{id:'empty',label:'Courses',description:'No courses yet',accessibleName:'Courses — No courses yet',disabled:true}]};
  const defaultTerm=selectCurrentTeachTerm(terms,calendarState.terms);
  const termChoices:Choice[]=sortTeachTerms(terms).map(course=>({
    id:course.id,label:teachTermLabel(course),description:[course.id===defaultTerm?.id?(isTeachTermActive(course,calendarState.terms)?'Current term':'Latest term'):undefined,course.id===activeCourse?.id?'Selected':undefined].filter(Boolean).join(' · ')||undefined,current:course.id===activeCourse?.id,
    handoffFocus:course.id!==activeCourse?.id,onSelect:()=>onTerm(course.id),
  }));
  if(selectedCode&&terms.length&&!terms.some(term=>term.readOnly))termChoices.push({id:'add-term',label:'Add term',handoffFocus:true,onSelect:returnFocus=>onAddTerm(selectedCode,returnFocus)});
  const termGroup:ChoiceGroup={id:'terms',title:'Year and term',choices:termChoices.length?termChoices:[{id:'empty',label:'Year Term',description:'Select a course first',accessibleName:'Year Term — Select a course first',disabled:true}]};
  const pageGroup:ChoiceGroup={id:'pages',title:'Course pages',choices:activeCourse?[
    {id:'home',label:homeTitle,description:activeCourse.readOnly?'Read-only course reference':'One complete course document',current:sectionId==='home',onSelect:()=>onPage('home')},
    {id:'student',label:'Student page',description:'Preview and review a student version',current:sectionId==='student',onSelect:()=>onPage('student')},
    {id:'calendar',label:'Course calendar',description:'Dates and class sessions',current:sectionId==='calendar',onSelect:()=>onPage('calendar')},
    ...(activeCourse.reference?.pages.map(page=>({id:page.id,label:page.title,description:'Preserved reference',disabled:!readySections.has(page.id),current:page.id===sectionId,onSelect:()=>onPage(page.id)}))??[]),
  ]:[{id:'empty',label:'Course page',description:'Select a term first',accessibleName:'Course page — Select a term first',disabled:true}]};
  const compactLabel=activeCourse?sectionTitle:'Courses';
  const catalogGroup:ChoiceGroup={id:'catalog',title:'asTeach',choices:[{id:'all-courses',label:'All courses',current:!activeCourse&&!homeActive,handoffFocus:true,onSelect:onCourses}]};
  return <nav className="pws-breadcrumb" aria-label="asTeach breadcrumb"><ol>
    <li className="pws-breadcrumb-root"><button type="button" aria-label="asTeach — Home" aria-current={homeActive?'page':undefined} title="asTeach · Home" onClick={onHome}>asTeach</button></li>
    <li className="pws-breadcrumb-catalog"><span aria-hidden="true">/</span><div className="pws-breadcrumb-split"><button type="button" className="pws-breadcrumb-label" aria-label="Courses — all courses" aria-current={!homeActive&&!activeCourse?'page':undefined} title="All courses" onClick={onCourses}>Courses</button>{!activeCourse&&<ChoiceMenu label="Choose course" title="Courses" groups={[courseGroup]} disabled={!courses.length}/>}</div></li>
    {activeCourse&&<>
      <li className="pws-breadcrumb-code pws-breadcrumb-desktop"><span aria-hidden="true">/</span><div className="pws-breadcrumb-split"><button type="button" className="pws-breadcrumb-label" aria-label={`${selectedCode} — open course`} title={`${selectedCode} · Open current or latest term`} onClick={()=>onCourse(selectedCode!)}>{selectedCode}</button><ChoiceMenu label="Choose course" title="Courses" groups={[courseGroup]}/></div></li>
      <li className="pws-breadcrumb-term pws-breadcrumb-desktop"><span aria-hidden="true">/</span><div className="pws-breadcrumb-split"><button type="button" className="pws-breadcrumb-label" aria-label={`${activeCourse.year} ${activeCourse.season} — open ${activeCourse.code} ${homeTitle}`} title={`${activeCourse.year} ${activeCourse.season} · ${homeTitle}`} onClick={()=>onPage('home')}>{activeCourse.year} {activeCourse.season}</button><ChoiceMenu label="Choose year and term" title="Year and term" groups={[termGroup]}/></div></li>
      <li className="pws-breadcrumb-current pws-breadcrumb-desktop"><span aria-hidden="true">/</span><div className="pws-breadcrumb-split"><button type="button" className="pws-breadcrumb-label" aria-label={`${sectionTitle} — current page`} aria-current="page" title={`${sectionTitle}${pageAvailable?'':' · No content yet'}`} disabled={!pageAvailable} onClick={()=>onPage(sectionId)}>{sectionTitle}</button><ChoiceMenu label="Choose course page" title="Course pages" groups={[pageGroup]}/></div></li>
      <li className="pws-breadcrumb-compact"><span aria-hidden="true">/</span><ChoiceMenu label="Open course navigation" title="Course navigation" groups={[catalogGroup,courseGroup,termGroup,pageGroup]} compact/></li>
      <li className="pws-breadcrumb-compact-current"><span aria-hidden="true">/</span><strong aria-current="page" title={compactLabel} className={!pageAvailable?'pws-breadcrumb-empty':undefined}>{compactLabel}</strong></li>
    </>}
  </ol></nav>;
}
