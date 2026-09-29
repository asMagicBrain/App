import React, {useLayoutEffect, useRef, useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {createEmptyTeachCourse, teachCourseRepositoryName, teachSeasons, teachTermFolder, teachStudyCourses, type TeachStudyCourse} from './teach-plugin-fixture';
import {groupTeachCourses,teachCourseKey,teachTermLabel,selectCurrentTeachTerm,isTeachTermActive,sortTeachTerms,type TeachCourseGroup} from './teach-course-groups';
import type {TeachCalendarState} from './TeachCalendarStudy';
import {emptyTeacherProfile,withTeacherProfileSnapshot,type TeachTeacherProfile} from './teach-teacher-profile';
import {TeachYearSelect} from './TeachYearSelect';
import './teach-courses-study.css';

export type TeachCourseSummary = {sectionId:string; sectionTitle:string; dirtyCount:number; readySectionIds:readonly string[]};
type Props = {
  courses:readonly TeachStudyCourse[];
  calendarState:TeachCalendarState;
  readOnly?:boolean;
  summaries:Record<string,TeachCourseSummary>;
  teacherProfile?:TeachTeacherProfile;
  onOpen(id:string):boolean|void;
  onCourse(code:string):boolean|void;
  onAddTerm(code:string,returnFocus?:HTMLButtonElement|null):boolean|void;
  onCreate(course:TeachStudyCourse):void;
  onReturnToRepository():void;
};

export function NewCourseButton({onClick}:{onClick():void}) {
  return <button type="button" className="pws-button tcs-primary tcs-new-course" aria-label="Create a new course" title="Create a new course" onClick={onClick}><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg></button>;
}

function CourseIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5"/></svg>;
}

function CourseTermMenu({group,calendarState,onOpen,onAddTerm}: {group:TeachCourseGroup;calendarState:TeachCalendarState;onOpen:Props['onOpen'];onAddTerm:Props['onAddTerm']}) {
  const current=selectCurrentTeachTerm(group.terms,calendarState.terms);
  const trigger=useRef<HTMLButtonElement>(null),handingOffFocus=useRef(false);
  const [host,setHost]=useState<HTMLElement|null>(null),[open,setOpen]=useState(false);
  useLayoutEffect(()=>{setHost(trigger.current?.closest<HTMLElement>('.fw-window')??null);},[]);
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={value=>{if(value)handingOffFocus.current=false;setOpen(value);}}>
    <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="pws-button tcs-term-menu" aria-label={`Choose term for ${group.course.code}`}>
      Choose term<svg viewBox="0 0 12 12" aria-hidden="true" fill="currentColor"><path d="m2 4 4 4 4-4Z"/></svg>
    </button></DropdownMenu.Trigger>
    {host&&<DropdownMenu.Portal container={host}><DropdownMenu.Content className="pws-ancestor-menu" aria-label={`${group.course.code} terms`} align="end" sideOffset={4} collisionBoundary={host} collisionPadding={8} loop onKeyDown={event=>event.stopPropagation()} onCloseAutoFocus={event=>{if(handingOffFocus.current)event.preventDefault();}}>
      <DropdownMenu.Label className="pws-ancestor-current">{group.course.code} · Terms</DropdownMenu.Label>
      {sortTeachTerms(group.terms).map(term=><DropdownMenu.Item key={term.id} className="pws-ancestor-item" aria-label={`Open ${group.course.code} ${teachTermLabel(term)}`} aria-description={term.id===current?.id?(isTeachTermActive(term,calendarState.terms)?'Current term':'Latest term'):undefined} onSelect={event=>{
        handingOffFocus.current=true;
        if(onOpen(term.id)===false){handingOffFocus.current=false;event.preventDefault();}
      }}><strong>{teachTermLabel(term)}</strong>{term.id===current?.id&&<span>{isTeachTermActive(term,calendarState.terms)?'Current term':'Latest term'}</span>}</DropdownMenu.Item>)}
      {!group.terms.some(term=>term.readOnly)&&<><DropdownMenu.Separator className="pws-ancestor-separator"/><DropdownMenu.Item className="pws-ancestor-item" onSelect={event=>{handingOffFocus.current=true;if(onAddTerm(group.course.code,trigger.current)===false){handingOffFocus.current=false;event.preventDefault();}}}>Add term</DropdownMenu.Item></>}
    </DropdownMenu.Content></DropdownMenu.Portal>}
  </DropdownMenu.Root>;
}

export function CourseDialog({title,onClose,children,returnFocusRef}: {title:string;onClose():void;children:React.ReactNode;returnFocusRef?:React.RefObject<HTMLElement|null>}) {
  const ref=useRef<HTMLDialogElement>(null);
  useLayoutEffect(()=>{
    const returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const dialog=ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('input:not([readonly]),select')?.focus();
    return()=>{dialog.close();const target=returnFocusRef?.current??returnFocus;if(target?.isConnected&&target.getClientRects().length)target.focus({preventScroll:true});};
  },[]);
  return <dialog className="tcs-dialog" ref={ref} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(element=>element.getClientRects().length>0);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}>
    <header><h2>{title}</h2><button type="button" className="tcs-close" aria-label="Close dialog" onClick={onClose}>×</button></header>
    {children}
  </dialog>;
}

const reservedRepositories=['Workspace','asMagicBrain-Docs','asMagicBrain-DevDocs','asTeach-App','research-notes','unavailable-course','studio-notes',...teachStudyCourses.map(course=>course.repository)];
const safeCourseCode=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9_/-]{0,31}$/.test(value)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
export function NewCourseDialog({courses,courseCode,teacherProfile=emptyTeacherProfile(),onClose,onCreate,returnFocusRef}:Pick<Props,'courses'|'teacherProfile'|'onCreate'>&{courseCode?:string;onClose():void;returnFocusRef?:React.RefObject<HTMLElement|null>}) {
  const [title,setTitle]=useState(''),[code,setCode]=useState(courseCode??'');
  const [year,setYear]=useState(String(Math.min(2100,Math.max(1949,new Date().getFullYear())))),[season,setSeason]=useState('');
  const [error,setError]=useState<{field:string;message:string}|null>(null);
  const existing=courses.find(course=>course.code.toLowerCase()===code.trim().toLowerCase());
  const canonicalCode=existing?.code??code.trim();
  const courseName=existing?.title??title;
  const termFolder=year&&season?teachTermFolder(year,season):'[year-season]';
  const repository=existing?.repository??teachCourseRepositoryName(canonicalCode);
  const submit=(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    let problem:{field:string;message:string}|null=null;
    if(!safeCourseCode(canonicalCode))problem={field:'code',message:'Enter a course code of up to 32 letters, numbers, slashes, hyphens or underscores. Start with a letter or number; reserved device names cannot be used.'};
    else if(existing?.readOnly)problem={field:'code',message:'Choose a new course code. This reference course is read-only.'};
    else if(!existing&&reservedRepositories.some(name=>name.toLowerCase()===repository.toLowerCase()||name.toLowerCase()===canonicalCode.toLowerCase()))problem={field:'code',message:'This name is already used by another repository. Choose a different course code.'};
    else if(courses.some(course=>course.code.toLowerCase()!==canonicalCode.toLowerCase()&&course.repository.toLowerCase()===repository.toLowerCase()))problem={field:'code',message:'This repository belongs to a different course code. Choose a different course code.'};
    else if(!courseName.trim())problem={field:'title',message:'Enter the full course name.'};
    else if(!/^\d{4}$/.test(year)||Number(year)<1949||Number(year)>2100)problem={field:'year',message:'Choose a teaching year from 1949 to 2100.'};
    else if(!teachSeasons.some(item=>item===season))problem={field:'season',message:'Choose a season.'};
    else if(courses.some(course=>course.code.toLowerCase()===canonicalCode.toLowerCase()&&course.year===year&&course.season===season))problem={field:'season',message:'This course already has that year and season. Open the existing term, or choose another.'};
    if(problem){setError(problem);event.currentTarget.querySelector<HTMLElement>(`[name="${problem.field}"]`)?.focus();return;}
    const created=createEmptyTeachCourse({id:`course-${crypto.randomUUID()}`,title:courseName.trim(),code:canonicalCode,year,season,repository});
    onCreate(existing?created:withTeacherProfileSnapshot(created,teacherProfile));
  };
  const invalid=(field:string)=>error?.field===field;
  return <CourseDialog title={courseCode?'Add term':'New course'} onClose={onClose} returnFocusRef={returnFocusRef}><form noValidate onSubmit={submit}>
    <p>{existing?'Add a teaching term to this course. Start with one course document and its section headings.':'Set up your course and its first teaching term. Saved teacher details will fill its teaching-team section.'}</p>
    <label>Course Code<input autoFocus={!courseCode} readOnly={Boolean(courseCode)} name="code" value={code} maxLength={32} onChange={event=>{setCode(event.target.value);setError(null);}} placeholder="e.g. DES5002" aria-describedby="tcs-code-help" aria-invalid={invalid('code')} required/></label>
    <p id="tcs-code-help" className="tcs-help">Your course code keeps its slashes. Only the repository folder name uses underscores instead.</p>
    <label>Course Name<input name="title" value={courseName} readOnly={Boolean(existing)} maxLength={160} onChange={event=>{setTitle(event.target.value);setError(null);}} placeholder="e.g. Design research and practice" aria-describedby="tcs-name-help" aria-invalid={invalid('title')} required/></label>
    <p id="tcs-name-help" className="tcs-help">{existing?'Existing course — its name and repository are retained for the new term.':'The full name is saved with the course details, without lengthening its folder name.'}</p>
    <fieldset className="tcs-term-fields"><legend>Year Season</legend><label>Year<TeachYearSelect autoFocus={Boolean(courseCode)} name="year" value={year} onChange={value=>{setYear(value);setError(null);}} invalid={invalid('year')} required/></label><label>Season<select name="season" value={season} onChange={event=>{setSeason(event.target.value);setError(null);}} aria-invalid={invalid('season')} required><option value="">Choose a season</option>{teachSeasons.map(item=><option key={item}>{item}</option>)}</select></label></fieldset>
    <section className="tcs-storage-preview" aria-label="Course folder preview"><strong>Proposed teacher repository</strong><code>asMagicBrain / {canonicalCode?repository:'[Course Code]_asTeach'} / {termFolder} / instructor.md</code><p>Teacher source stays in its own course repository. A separate student repository would require a reviewed export.</p></section>
    {error&&<p role="alert" className="tcs-error" id="tcs-setup-error">{error.message}</p>}
    <p className="tcs-session-note">Storybook preview: no folders are created on disk.</p>
    <footer><button type="button" className="pws-button" onClick={onClose}>Cancel</button><button type="submit" className="pws-button tcs-primary">{existing?'Create term':'Create course'}</button></footer>
  </form></CourseDialog>;
}

export function AddCourseDialog({courses,onClose,onCreate}:Pick<Props,'courses'|'onCreate'>&{onClose():void}) {
  const [repository,setRepository]=useState('');
  const existing=repository==='design-foundations'?teachStudyCourses[0]:undefined;
  const recognized=repository==='studio-notes'||Boolean(existing);
  const recognizedCode=existing?.code??'ARC103',recognizedTitle=existing?.title??'Spatial studies';
  const recognizedRepository=existing?.repository??repository;
  const recognizedYear=existing?.year??'2026',recognizedSeason=existing?.season??'Autumn';
  const matchingCourse=courses.find(course=>recognized&&course.code.toLowerCase()===recognizedCode.toLowerCase());
  const canonicalCode=matchingCourse?.code??recognizedCode;
  const conflict=courses.find(course=>recognized&&course.code.toLowerCase()===canonicalCode.toLowerCase()&&(course.repository.toLowerCase()!==recognizedRepository.toLowerCase()||course.title!==recognizedTitle));
  const duplicate=courses.some(course=>course.repository.toLowerCase()===recognizedRepository.toLowerCase()||(recognized&&course.code.toLowerCase()===canonicalCode.toLowerCase()&&course.year===recognizedYear&&course.season===recognizedSeason));
  const accept=()=>{
    if(!recognized||duplicate||conflict)return;
    if(existing){onCreate({...existing,code:canonicalCode});return;}
    const course=createEmptyTeachCourse({id:'existing-studio-notes',code:canonicalCode,title:recognizedTitle,year:recognizedYear,season:recognizedSeason,repository:recognizedRepository,description:'A sample existing course, added without changing its sections.'});
    const sections=course.sections.map((section,index)=>({...section,path:`2026-autumn/Teacher/.gitbook/includes/${section.id}.md`,source:index===0?'# Course Description\n\nExplore the relationship between people and everyday spaces.\n\n## Studio notes\n\nThis existing sample content is retained when the course is added to asTeach.\n':`# ${section.title}\n\nExisting course notes for ${section.title.toLowerCase()}.\n`}));
    onCreate({...course,sections,sample:true});
  };
  return <CourseDialog title="Add existing course" onClose={onClose}>
    <p>Choose a repository and review its course structure before adding it to asTeach.</p>
    <label>Repository<select autoFocus value={repository} onChange={event=>setRepository(event.target.value)}><option value="">Select a sample repository</option><option value="studio-notes">studio-notes</option><option value="design-foundations">{teachStudyCourses[0].repository}</option><option value="research-notes">research-notes</option><option value="unavailable-course">unavailable-course</option></select></label>
    {repository&&<section className="tcs-inspection" aria-label="Course inspection" aria-live="polite">
      {conflict?<><h3>Course details conflict</h3><p>{canonicalCode} is already listed as “{conflict.title}” in {conflict.repository}. The selected repository has a different name or repository for that course code. Review the course details before adding it.</p></>:duplicate?<><h3>Already in asTeach</h3><p>This repository is already listed. Open it from Courses.</p></>:recognized?<><h3>{existing?.title??'Spatial studies'} <span>{existing?.code??'ARC103'}</span></h3><p>Recognized course structure</p><dl><div><dt>Year Season</dt><dd>{existing?`${existing.year} ${existing.season}`:'2026 Autumn'}</dd></div><div><dt>Course Home</dt><dd>{existing?teachTermFolder(existing.year,existing.season):'2026-autumn'}/Teacher/README.md</dd></div><div><dt>Markdown sections</dt><dd>13 found</dd></div><div><dt>Missing referenced assets</dt><dd>None in this sample</dd></div></dl><p>Your existing content stays unchanged.</p></>:repository==='research-notes'?<><h3>Course mapping needed</h3><p>This is an ordinary Markdown repository. Choosing its Course Home and sections is not available yet. It remains accessible through the repository explorer.</p></>:<><h3>Repository unavailable</h3><p>The course folder could not be found. Return to your repositories to check its location. No replacement folder will be created.</p></>}
    </section>}
    <div className="tcs-zip" data-unavailable><button type="button" className="pws-button" disabled>Import course ZIP…</button><span>Course recognition after ZIP import will be connected later.</span></div>
    <p className="tcs-session-note">Storybook preview: this list uses sample repositories.</p>
    <footer><button type="button" className="pws-button" onClick={onClose}>Cancel</button><button type="button" className="pws-button tcs-primary" disabled={!recognized||duplicate||Boolean(conflict)} onClick={accept}>Add course</button></footer>
  </CourseDialog>;
}

export function TeachCoursesStudy({courses,calendarState,readOnly=false,summaries,teacherProfile,onOpen,onCourse,onAddTerm,onCreate,onReturnToRepository}:Props) {
  const [query,setQuery]=useState(''),[dialog,setDialog]=useState<'new'|'add'|null>(null);
  const courseGroups=groupTeachCourses(courses);
  const matchesQuery=(course:TeachStudyCourse)=>`${course.title} ${course.code} ${course.repository} ${course.year} ${course.season}`.toLowerCase().includes(query.trim().toLowerCase());
  const matchingGroups=courseGroups.filter(group=>group.terms.some(matchesQuery));
  const created=(course:TeachStudyCourse)=>{setDialog(null);setQuery('');onCreate(course);};
  return <section className="tcs-landing" aria-labelledby="tcs-heading" data-plugin-view="courses">
    <div className="tcs-content">
      <header className="tcs-heading"><div><span className="tcs-eyebrow">asTeach</span><h1 id="tcs-heading" tabIndex={-1}>Courses</h1><p>Your course content, organized by teaching term.</p></div><div className="tcs-heading-actions">{readOnly?<span className="pws-badge">Reference courses</span>:<button type="button" className="pws-button" onClick={()=>setDialog('add')}>Add existing course</button>}<NewCourseButton onClick={()=>setDialog('new')}/></div></header>
      {courses.length>0?<>
        <div className="tcs-list-heading"><h2>Courses <span className="pws-count">{matchingGroups.length}</span></h2><label className="pws-search"><span className="pws-sr-only">Search courses</span><input type="search" placeholder="Search courses" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>
        <div className="tcs-list">{matchingGroups.map(group=>{
          const {terms}=group;
          const course=selectCurrentTeachTerm(terms,calendarState.terms)!;
          const dirtyCount=terms.reduce((count,term)=>count+(summaries[term.id]?.dirtyCount??0),0);
          return <article className="tcs-row" key={teachCourseKey(course.code)} aria-label={course.code||course.title}>
            <span className="tcs-course-icon"><CourseIcon/></span><div className="tcs-row-details"><div className="tcs-row-title"><h3><button type="button" onClick={()=>onCourse(course.code)}>{course.title}</button></h3>{course.code&&<span className="tcs-code">{course.code}</span>}{terms.every(term=>term.sample)&&<span className="pws-badge">Sample</span>}</div><div className="tcs-row-meta"><span>{isTeachTermActive(course,calendarState.terms)?'Current term':'Latest term'}: {teachTermLabel(course)}</span><span>{terms.length} {terms.length===1?'term':'terms'}</span><span>Source: {course.repository}</span>{dirtyCount>0&&<span className="tcs-draft">{dirtyCount} unsaved section{dirtyCount===1?'':'s'}</span>}</div></div>
            <div className="tcs-row-actions"><CourseTermMenu group={group} calendarState={calendarState} onOpen={onOpen} onAddTerm={onAddTerm}/><button type="button" className="pws-button" aria-label={`Open course ${course.code||course.title}`} onClick={()=>onCourse(course.code)}>Open course</button></div>
          </article>;
        })}{!matchingGroups.length&&<div className="tcs-empty"><h2>No matching courses</h2><p>Try a different name, code or teaching term.</p><button type="button" className="pws-button" onClick={()=>setQuery('')}>Clear search</button></div>}</div>
      </>:<div className="tcs-empty tcs-first"><span className="tcs-course-icon"><CourseIcon/></span><h2>Your first course starts here</h2><p>Create a course or add one you already have.<br/>Your files stay in your asMagicBrain workspace.</p><ol><li><strong>Prepare</strong><span>Build reusable Markdown sections.</span></li><li><strong>Teach</strong><span>Adapt your material for each term.</span></li><li><strong>Reuse</strong><span>Carry your improvements forward.</span></li></ol></div>}
      <footer className="tcs-footer"><span>{readOnly?'Local reference · Original repositories unchanged.':'Storybook preview · Changes stay in this tab.'}</span><button type="button" onClick={onReturnToRepository}>Return to repository</button></footer>
    </div>
    {dialog==='new'&&<NewCourseDialog courses={courses} teacherProfile={teacherProfile} onClose={()=>setDialog(null)} onCreate={created}/>}
    {!readOnly&&dialog==='add'&&<AddCourseDialog courses={courses} onClose={()=>setDialog(null)} onCreate={created}/>}
  </section>;
}
