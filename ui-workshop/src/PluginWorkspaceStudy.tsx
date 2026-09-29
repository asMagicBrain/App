import React, {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {FocusedWriting} from './FocusedWriting';
import {TeachPluginStudy, type TeachPageNavigationRequest} from './TeachPluginStudy';
import {TeachBreadcrumb} from './TeachBreadcrumb';
import {TeachCoursesStudy, NewCourseDialog, type TeachCourseSummary} from './TeachCoursesStudy';
import {TeachHomeStudy,type TeachRecentDocument} from './TeachHomeStudy';
import {teachStudyCourses, type TeachStudyCourse} from './teach-plugin-fixture';
import {selectCurrentTeachTerm,teachCourseKey} from './teach-course-groups';
import {emptyTeacherProfile} from './teach-teacher-profile';
import {type TeachCalendarState} from './TeachCalendarStudy';
import {referenceTeachCalendarState} from './teach-reference-calendar.mjs';
import './plugin-workspace-study.css';

type PluginView = 'plugins' | 'teach' | null;

function PluginIcon({teach=false}: {teach?: boolean}) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {teach ? <><path d="m2 8 10-5 10 5-10 5Z"/><path d="M6 10v6c4 3 8 3 12 0v-6M22 8v7"/></> : <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/></>}
  </svg>;
}

function PluginManager({enabled,onEnabledChange,onOpen}: {enabled:boolean;onEnabledChange(enabled:boolean):void;onOpen():void}) {
  const [query,setQuery]=useState('');
  const [details,setDetails]=useState(false);
  const [feedback,setFeedback]=useState('');
  const matching='asteach courses teaching course home markdown'.includes(query.trim().toLowerCase());
  return <section className="pws-manager" aria-labelledby="pws-title" data-plugin-view="manager">
    <div className="pws-manager-content">
      <header className="pws-heading">
        <div><h1 id="pws-title">Plugins</h1><p>Choose the tools you use in asMagicBrain.</p></div>
        <button type="button" className="pws-button" disabled data-unavailable>Install plugin…</button>
      </header>
      <div className="pws-list-heading"><h2>Installed <span className="pws-count">1</span></h2>
        <label className="pws-search"><span className="pws-sr-only">Search installed plugins</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input type="search" placeholder="Search plugins" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      </div>
      {matching ? <article className="pws-plugin" aria-labelledby="pws-teach-title">
        <div className="pws-plugin-row">
          <span className="pws-plugin-icon"><PluginIcon teach/></span>
          <div className="pws-plugin-description"><div className="pws-plugin-title"><h3 id="pws-teach-title">asTeach</h3><span className="pws-badge">Included</span></div><p>Prepare course documents and reviewed student versions.</p><span className="pws-publisher">By asMagicBrain</span></div>
          <div className="pws-plugin-actions"><button type="button" role="switch" className="pws-enable" aria-label="Enable asTeach" aria-checked={enabled} onClick={()=>{onEnabledChange(!enabled);setFeedback(enabled?'asTeach disabled.':'asTeach enabled.');}}><span>{enabled?'Enabled':'Disabled'}</span><span className="pws-switch-track" aria-hidden="true"><span/></span></button><button type="button" className="pws-button" disabled={!enabled} onClick={onOpen}>Open asTeach</button></div>
        </div>
        <div className="pws-plugin-footer"><button type="button" className="pws-details-toggle" aria-expanded={details} aria-controls="pws-teach-details" onClick={()=>setDetails(value=>!value)}>{details?'Hide details':'View details'}<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={details?'m4 10 4-4 4 4':'m4 6 4 4 4-4'}/></svg></button><button type="button" className="pws-update" disabled data-unavailable>Check for updates</button></div>
        {details&&<div id="pws-teach-details" className="pws-details"><h4>Course workspace</h4><p>Edit each term as one Markdown document and review its student version.</p><h4>Uses your existing tools</h4><p>asTeach fits into the document area, with course pages on the left and a document outline on the right.</p></div>}
      </article> : <p className="pws-empty" role="status">No plugins match “{query}”.</p>}
      <p className="pws-hint">Disabling a plugin keeps its documents and course content.</p>
      <p className="pws-feedback" role="status">{feedback}</p>
    </div>
  </section>;
}

type PanelChoices={sidebar:boolean;outline:boolean};
const defaultPanels:PanelChoices={sidebar:true,outline:false};
function MountedTeachCourse({course,active,panels,navigationRequest,onPanels,onSummary,onGuard,onBack,calendarState,onCalendarChange}: {
  course:TeachStudyCourse;active:boolean;panels:PanelChoices;navigationRequest?:TeachPageNavigationRequest;
  onPanels(id:string,changes:Partial<PanelChoices>):void;
  onSummary(id:string,summary:TeachCourseSummary):void;
  onGuard(id:string,guard:(()=>boolean)|null):void;
  onBack():void;
  calendarState:TeachCalendarState;
  onCalendarChange:React.Dispatch<React.SetStateAction<TeachCalendarState>>;
}) {
  const report=useCallback((summary:TeachCourseSummary)=>onSummary(course.id,summary),[course.id,onSummary]);
  const registerGuard=useCallback((guard:(()=>boolean)|null)=>onGuard(course.id,guard),[course.id,onGuard]);
  const surface=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(active) surface.current?.querySelector<HTMLElement>('.teach-calendar-page, .teach-editor-pane:not([hidden]) .cm-content, .teach-reading:not([hidden])')?.focus({preventScroll:true});
  },[active]);
  return <div className="pws-surface" ref={surface} hidden={!active}><TeachPluginStudy course={course} calendarState={calendarState} onCalendarChange={onCalendarChange} active={active} navigationRequest={navigationRequest} onNavigationGuardChange={registerGuard}
    sidebarOpen={panels.sidebar} onSidebarOpenChange={open=>onPanels(course.id,{sidebar:open})}
    outlineOpen={panels.outline} onOutlineOpenChange={open=>onPanels(course.id,{outline:open})}
    onBackToCourses={onBack} onSessionChange={report}/></div>;
}

/** Browser-only presentation study. Course and editor sessions never write through a host adapter. */
export function PluginWorkspaceStudy({initialView='plugins',initialTheme='light-default',initialEmpty=false,initialCourses}: {initialView?:Exclude<PluginView,null>;initialTheme?:string;initialEmpty?:boolean;initialCourses?:readonly TeachStudyCourse[]}) {
  const [view,setView]=useState<PluginView>(initialView);
  const [enabled,setEnabled]=useState(true);
  const [courses,setCourses]=useState<readonly TeachStudyCourse[]>(()=>initialCourses??(initialEmpty?[]:teachStudyCourses));
  const readOnlyCatalog=Boolean(initialCourses?.length&&initialCourses.every(item=>item.readOnly));
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [landing,setLanding]=useState<'home'|'courses'>('home');
  const [teacherProfile,setTeacherProfile]=useState(emptyTeacherProfile);
  const [calendarState,setCalendarState]=useState<TeachCalendarState>(()=>referenceTeachCalendarState(courses) as TeachCalendarState);
  const [recent,setRecent]=useState<readonly TeachRecentDocument[]>([]);
  const [newTermCode,setNewTermCode]=useState<string>();
  const newTermReturnFocus=useRef<HTMLButtonElement|null>(null);
  const [navigationRequests,setNavigationRequests]=useState<Record<string,TeachPageNavigationRequest>>({});
  const navigationGuards=useRef(new Map<string,()=>boolean>());
  const [visited,setVisited]=useState<readonly string[]>([]);
  const [panels,setPanels]=useState<Record<string,PanelChoices>>({});
  const [summaries,setSummaries]=useState<Record<string,TeachCourseSummary>>({});
  const course=courses.find(item=>item.id===selectedId);
  const activeCourse=view==='teach'?course:undefined;
  const activeCourseId=useRef<string|undefined>(undefined),summariesRef=useRef(summaries);
  activeCourseId.current=activeCourse?.id;summariesRef.current=summaries;
  const coursesSurface=useRef<HTMLDivElement>(null),homeSurface=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(view==='teach'&&!course)(landing==='home'?homeSurface:coursesSurface).current?.querySelector<HTMLElement>(landing==='home'?'#ths-heading':'#tcs-heading')?.focus({preventScroll:true});
  },[view,course?.id,landing]);
  const currentPanels=course?panels[course.id]??defaultPanels:defaultPanels;
  const canNavigate=()=>!activeCourse||navigationGuards.current.get(activeCourse.id)?.()!==false;
  const showHome=()=>{if(!canNavigate())return false;setView('teach');setLanding('home');setSelectedId(null);return true;};
  const showCourses=()=>{if(!canNavigate())return false;setView('teach');setLanding('courses');setSelectedId(null);return true;};
  const rememberDocument=useCallback((document:TeachRecentDocument)=>setRecent(previous=>{
    const last=previous[0];
    if(last?.courseId===document.courseId&&last.sectionId===document.sectionId&&last.sectionTitle===document.sectionTitle)return previous;
    return [document,...previous.filter(item=>item.courseId!==document.courseId||item.sectionId!==document.sectionId)].slice(0,6);
  }),[]);
  const openCourse=(id:string,remember=true)=>{
    if(!canNavigate())return false;
    setView('teach');setSelectedId(id);setVisited(previous=>previous.includes(id)?previous:[...previous,id]);
    const offering=courses.find(item=>item.id===id),summary=summariesRef.current[id];
    if(offering&&remember)rememberDocument({courseId:id,sectionId:summary?.sectionId??'home',sectionTitle:summary?.sectionTitle??'Instructor page'});
    return true;
  };
  const createCourse=(created:TeachStudyCourse)=>{setCourses(previous=>[...previous,created]);openCourse(created.id);};
  const openDocument=(document:TeachRecentDocument,forcePage=false)=>{
    if(!openCourse(document.courseId,false))return false;
    if(forcePage||summariesRef.current[document.courseId]?.sectionId!==document.sectionId)setNavigationRequests(previous=>({...previous,[document.courseId]:{sequence:(previous[document.courseId]?.sequence??0)+1,sectionId:document.sectionId}}));
    rememberDocument(document);
    return true;
  };
  const openCoursePage=(sectionId:string)=>{
    if(!activeCourse||!canNavigate())return false;
    setNavigationRequests(previous=>({...previous,[activeCourse.id]:{sequence:(previous[activeCourse.id]?.sequence??0)+1,sectionId}}));
    return true;
  };
  const openCurrentCourse=(code:string)=>{
    const current=selectCurrentTeachTerm(courses.filter(item=>teachCourseKey(item.code)===teachCourseKey(code)),calendarState.terms);
    return current?openDocument({courseId:current.id,sectionId:'home',sectionTitle:'Instructor page'},true):false;
  };
  const addTerm=(code:string,returnFocus?:HTMLButtonElement|null)=>{
    const terms=courses.filter(item=>teachCourseKey(item.code)===teachCourseKey(code));
    if(!terms.length||terms.some(item=>item.readOnly)||!canNavigate())return false;
    newTermReturnFocus.current=returnFocus??null;setNewTermCode(terms[0].code);return true;
  };
  const registerNavigationGuard=useCallback((id:string,guard:(()=>boolean)|null)=>{if(guard)navigationGuards.current.set(id,guard);else navigationGuards.current.delete(id);},[]);
  const updatePanels=useCallback((id:string,changes:Partial<PanelChoices>)=>setPanels(previous=>({...previous,[id]:{...(previous[id]??defaultPanels),...changes}})),[]);
  const reportSummary=useCallback((id:string,summary:TeachCourseSummary)=>{
    const old=summariesRef.current[id];
    if(old&&old.sectionId===summary.sectionId&&old.sectionTitle===summary.sectionTitle&&old.dirtyCount===summary.dirtyCount&&old.readySectionIds.length===summary.readySectionIds.length&&old.readySectionIds.every((id,index)=>id===summary.readySectionIds[index]))return;
    const next={...summariesRef.current,[id]:summary};summariesRef.current=next;setSummaries(next);
    if(activeCourseId.current===id&&(!old||old.sectionId!==summary.sectionId||old.sectionTitle!==summary.sectionTitle))rememberDocument({courseId:id,sectionId:summary.sectionId,sectionTitle:summary.sectionTitle});
  },[rememberDocument]);
  const rail=<>
    <button type="button" className="fw-icon pws-rail-button" aria-label="Manage plugins" title="Manage plugins" aria-current={view==='plugins'?'page':undefined} onClick={()=>{if(canNavigate())setView('plugins');}}><PluginIcon/></button>
    <button type="button" className="fw-icon pws-rail-button" aria-label="asTeach" title={enabled?'asTeach':'asTeach — enable in Manage plugins'} aria-current={view==='teach'?'page':undefined} disabled={!enabled} onClick={showHome}><PluginIcon teach/></button>
  </>;
  const content=<>
    <div className="pws-surface" hidden={view!=='plugins'}><PluginManager enabled={enabled} onEnabledChange={setEnabled} onOpen={showHome}/></div>
    <div className="pws-surface" ref={homeSurface} hidden={view!=='teach'||Boolean(course)||landing!=='home'}><TeachHomeStudy calendarState={calendarState} onCalendarChange={setCalendarState} courses={courses} recent={recent} teacherProfile={teacherProfile} readOnly={readOnlyCatalog} onSaveProfile={setTeacherProfile} onOpenDocument={openDocument} onOpenTerm={id=>openDocument({courseId:id,sectionId:'calendar',sectionTitle:'Course calendar'})} onCreate={createCourse} onReturnToRepository={()=>setView(null)}/></div>
    <div className="pws-surface" ref={coursesSurface} hidden={view!=='teach'||Boolean(course)||landing!=='courses'}><TeachCoursesStudy courses={courses} calendarState={calendarState} readOnly={readOnlyCatalog} summaries={summaries} teacherProfile={teacherProfile} onOpen={openCourse} onCourse={openCurrentCourse} onAddTerm={addTerm} onCreate={createCourse} onReturnToRepository={()=>setView(null)}/></div>
    {newTermCode&&<NewCourseDialog returnFocusRef={newTermReturnFocus} courses={courses} courseCode={newTermCode} teacherProfile={teacherProfile} onClose={()=>setNewTermCode(undefined)} onCreate={created=>{setNewTermCode(undefined);createCourse(created);}}/>}
    {courses.filter(item=>visited.includes(item.id)).map(item=><MountedTeachCourse key={item.id} course={item} calendarState={calendarState} onCalendarChange={setCalendarState} active={activeCourse?.id===item.id} panels={panels[item.id]??defaultPanels} navigationRequest={navigationRequests[item.id]} onPanels={updatePanels} onSummary={reportSummary} onGuard={registerNavigationGuard} onBack={showCourses}/>)}
  </>;
  const headerContext=view==='plugins'?<div className="tcs-header-context"><button type="button" title="Plugins" onClick={()=>setView('plugins')}><strong>Plugins</strong></button></div>:<TeachBreadcrumb courses={courses} homeActive={view==='teach'&&!course&&landing==='home'} activeCourse={activeCourse} calendarState={calendarState} summaries={summaries} onHome={showHome} onCourses={showCourses} onCourse={openCurrentCourse} onAddTerm={addTerm} onTerm={openCourse} onPage={openCoursePage}/>;
  return <FocusedWriting repositoryHeader repositoryCode initialRepository="asTeach-App" initialTheme={initialTheme} workspaceStudy={{
    active:view!==null,rail,content,headerContext,headerContextReplacesOwner:view==='teach',onExit:()=>setView(null),
    sidebar:activeCourse?{open:currentPanels.sidebar,onToggle:()=>updatePanels(activeCourse.id,{sidebar:!currentPanels.sidebar})}:undefined,
    outline:activeCourse?{open:currentPanels.outline,onToggle:()=>updatePanels(activeCourse.id,{outline:!currentPanels.outline})}:undefined,
  }}/>;
}
