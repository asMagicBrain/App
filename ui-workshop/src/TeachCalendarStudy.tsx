import React, {useId, useLayoutEffect, useRef, useState} from 'react';
import type {TeachStudyCourse} from './teach-plugin-fixture';
import {TeachYearSelect} from './TeachYearSelect';
import {combinedTeachingMondays, currentTeachingSeason, teachingCompactDate, teachingCourseAnchorError, teachingDateAt, teachingDays, teachingISODate, teachingNoClassDayError, teachingSeasons, teachingSessionOccurs, teachingSessionsOverlap, teachingTimeError, teachingWeekAt, teachingWeekError} from './teach-calendar.mjs';
import './teach-calendar-study.css';

export type TeachClassSession = {id:string;title:string;weekday:number;start:string;end:string;location:string;weekFrom:number;weekTo:number};
export type TeachRecordedClass = {id:string;title:string;date:string;start:string;end:string;status:'scheduled'|'cancelled'|'rescheduled'|'unconfirmed';notes:string;sourceLine:number};
export type TeachTermCalendar = {monday:string;totalWeeks:number;sessions:TeachClassSession[];recordedClasses?:TeachRecordedClass[];sourcePath?:string;sourceCommit?:string};
export type TeachNoClassDay = {id:string;date:string;description:string};
export type TeachCalendarState = {terms:Record<string,TeachTermCalendar>;noClassDays:TeachNoClassDay[]};
export const emptyTeachCalendarState = ():TeachCalendarState => ({terms:{},noClassDays:[]});
export const defaultTeachTermCalendar = ():TeachTermCalendar => ({monday:'',totalWeeks:14,sessions:[]});
type StateProps = {state:TeachCalendarState;onChange:React.Dispatch<React.SetStateAction<TeachCalendarState>>};
type CalendarCourse = {course:TeachStudyCourse;calendar:TeachTermCalendar};
const dateFormatter = new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const monthFormatter = new Intl.DateTimeFormat('en-GB',{month:'short',timeZone:'UTC'});
const dateLabel = (iso:string) => dateFormatter.format(new Date(`${iso}T00:00:00Z`));
const courseLabel = (course:TeachStudyCourse) => `${course.code} · ${course.year} ${course.season}`;
const nextId = () => globalThis.crypto.randomUUID();
const todayISO = () => {const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;};
const calendarPhase = (calendar:TeachTermCalendar) => !calendar.monday?'Dates not set':teachingDateAt(calendar.monday,calendar.totalWeeks,6)!<todayISO()?'Past':calendar.monday>todayISO()?'Planning':'Active';

function CalendarDialog({title,onClose,children,fallbackFocus}:{title:string;onClose():void;children:React.ReactNode;fallbackFocus:React.RefObject<HTMLElement|null>}) {
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useLayoutEffect(()=>{
    const returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const dialog=ref.current!;dialog.showModal();dialog.querySelector<HTMLElement>('input,select,button')?.focus();
    return()=>{dialog.close();queueMicrotask(()=>{const target=returnFocus?.isConnected&&returnFocus.getClientRects().length?returnFocus:fallbackFocus.current;target?.focus({preventScroll:true});});};
  },[]);
  return <dialog ref={ref} className="tcal-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter(element=>element.getClientRects().length);
    if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus();}
    else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus();}
  }}><h3 id={titleId}>{title}</h3>{children}</dialog>;
}

function DateEntry({label,value,onChange,error,optional=false}:{label:string;value:string;onChange(value:string):void;error?:boolean;optional?:boolean}) {
  const id=useId(),iso=teachingISODate(value);
  return <div className="tcal-date-entry"><label htmlFor={id}>{label}{optional?' (optional)':''}</label><div className="tcal-date-inputs"><input id={id} type="text" inputMode="numeric" maxLength={8} placeholder="YYYYMMDD" value={value} aria-invalid={error||undefined} onChange={event=>onChange(event.target.value)}/><input type="date" className="tcal-date-picker" min="1949-01-01" max="2100-12-31" aria-label={`Choose ${label} from calendar`} title={`Choose ${label} from calendar`} value={iso??''} onChange={event=>onChange(teachingCompactDate(event.target.value))}/></div></div>;
}

function NoClassDialog({initial,initialDate,days,onClose,onSave,fallbackFocus}:{initial:TeachNoClassDay|null;initialDate:string;days:TeachNoClassDay[];onClose():void;onSave(day:TeachNoClassDay):void;fallbackFocus:React.RefObject<HTMLElement|null>}) {
  const [date,setDate]=useState(teachingCompactDate(initial?.date??initialDate)),[description,setDescription]=useState(initial?.description??''),[error,setError]=useState('');
  return <CalendarDialog title={initial?'Edit no-class day':'Add no-class day'} onClose={onClose} fallbackFocus={fallbackFocus}><p>Applies to every course on this date. Class sessions are retained.</p><form noValidate onSubmit={event=>{
    event.preventDefault();const iso=teachingISODate(date),problem=teachingNoClassDayError(iso??'',days,initial?.id);setError(problem);if(problem){event.currentTarget.querySelector<HTMLInputElement>('input[type=text]')?.focus();return;}
    onSave({id:initial?.id??nextId(),date:iso!,description:description.trim()});
  }}><div className="tcal-form-grid"><div className="tcal-wide"><DateEntry label="Date" value={date} onChange={value=>{setDate(value);setError('');}} error={!!error}/></div><label className="tcal-wide">Description (optional)<input value={description} maxLength={200} onChange={event=>setDescription(event.target.value)}/></label></div>{error&&<p className="tcal-error" role="alert">{error}</p>}<footer><button className="tcal-button" type="button" onClick={onClose}>Cancel</button><button className="tcal-button tcal-primary" type="submit">{initial?'Save no-class day':'Add no-class day'}</button></footer></form></CalendarDialog>;
}

function SessionDialog({initial,totalWeeks,onClose,onSave,fallbackFocus}:{initial:TeachClassSession|null;totalWeeks:number;onClose():void;onSave(session:TeachClassSession):void;fallbackFocus:React.RefObject<HTMLButtonElement|null>}) {
  const [title,setTitle]=useState(initial?.title??''),[weekday,setWeekday]=useState(String(initial?.weekday??0));
  const [start,setStart]=useState(initial?.start??''),[end,setEnd]=useState(initial?.end??''),[location,setLocation]=useState(initial?.location??'');
  const [from,setFrom]=useState(String(initial?.weekFrom??1)),[to,setTo]=useState(String(initial?.weekTo??totalWeeks)),[error,setError]=useState('');
  return <CalendarDialog title={initial?'Edit class session':'Add class session'} onClose={onClose} fallbackFocus={fallbackFocus}><p>{initial?'Changes apply to every occurrence of this session.':'Add a lecture, tutorial or other recurring class for this course.'}</p><form noValidate onChange={()=>setError('')} onSubmit={event=>{
    event.preventDefault();const problem=(!title.trim()?'Enter a class name.':'')||teachingTimeError(start,end)||teachingWeekError(from,to)||(Number(to)>totalWeeks?`Sessions must end by Week ${totalWeeks}.`:'');setError(problem);if(problem){const selector=!title.trim()?'input[type=text]':teachingTimeError(start,end)?'input[type=time]':'input[type=number]';event.currentTarget.querySelector<HTMLInputElement>(selector)?.focus();return;}
    onSave({id:initial?.id??nextId(),title:title.trim(),weekday:Number(weekday),start,end,location:location.trim(),weekFrom:Number(from),weekTo:Number(to)});
  }}><div className="tcal-form-grid"><label className="tcal-wide">Class name<input value={title} maxLength={120} placeholder="e.g. Lecture, Tutorial A" onChange={event=>setTitle(event.target.value)}/></label><label className="tcal-wide">Day<select value={weekday} onChange={event=>setWeekday(event.target.value)}>{teachingDays.map((day:string,index:number)=><option key={day} value={index}>{day}</option>)}</select></label><label>Start time<input type="time" value={start} onChange={event=>setStart(event.target.value)}/></label><label>End time<input type="time" value={end} onChange={event=>setEnd(event.target.value)}/></label><label className="tcal-wide">Room or location (optional)<input value={location} maxLength={160} onChange={event=>setLocation(event.target.value)}/></label><label>First class week<input type="number" min="1" max={totalWeeks} step="1" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>Last class week<input type="number" min="1" max={totalWeeks} step="1" value={to} onChange={event=>setTo(event.target.value)}/></label></div>{error&&<p className="tcal-error" role="alert">{error}</p>}<footer><button className="tcal-button" type="button" onClick={onClose}>Cancel</button><button className="tcal-button tcal-primary" type="submit">{initial?'Save session':'Add session'}</button></footer></form></CalendarDialog>;
}

function CourseCalendarSettings({course,calendar,onSave}:{course:TeachStudyCourse;calendar:TeachTermCalendar;onSave(next:TeachTermCalendar):void}) {
  const [monday,setMonday]=useState(teachingCompactDate(calendar.monday)),[weeks,setWeeks]=useState(String(calendar.totalWeeks)),[error,setError]=useState(''),[saved,setSaved]=useState('');
  return <form className="tcal-settings" noValidate onChange={()=>{setError('');setSaved('');}} onSubmit={event=>{
    event.preventDefault();const iso=teachingISODate(monday);
    const problem=(iso===null?'Enter the Monday as YYYYMMDD.':'')||teachingCourseAnchorError(iso??'',course.year)||teachingWeekError(1,weeks)||(calendar.sessions.some(session=>session.weekTo>Number(weeks))?'A class extends beyond these weeks. Edit its last class week before shortening the calendar.':'');
    setError(problem);if(problem){event.currentTarget.querySelector<HTMLInputElement>(iso===null||teachingCourseAnchorError(iso??'',course.year)?'input[type=text]':'input[type=number]')?.focus();return;}onSave({...calendar,monday:iso!,totalWeeks:Number(weeks)});setSaved('Calendar settings saved.');
  }}><div className="tcal-setting-period"><span>Year</span><strong>{course.year}</strong></div><div className="tcal-setting-period"><span>Season</span><strong>{course.season}</strong></div><DateEntry label="Week 1 Monday" optional value={monday} onChange={setMonday}/><label className="tcal-total-weeks">Total number of weeks<input type="number" min="1" max="53" step="1" value={weeks} onChange={event=>setWeeks(event.target.value)}/></label><button className="tcal-button" type="submit">Save calendar settings</button>{error&&<p className="tcal-error" role="alert">{error}</p>}{saved&&<p className="tcal-status" role="status">{saved}</p>}</form>;
}

type CalendarOccurrence = Pick<TeachClassSession,'id'|'title'|'start'|'end'|'location'> & {recorded?:TeachRecordedClass};
const classTime = (session:CalendarOccurrence) => session.start&&session.end?`${session.start}–${session.end}`:session.recorded&&/TBC|to be confirmed/i.test(session.recorded.notes)?'Time to be confirmed':'Time not specified';
const recordedOccurrence = (recorded:TeachRecordedClass):CalendarOccurrence => ({...recorded,location:'',recorded});

function CalendarSessionContent({course,session,cancelled,overlap,onOpenTerm}:{course:TeachStudyCourse;session:CalendarOccurrence;cancelled:boolean;overlap:boolean;onOpenTerm?(id:string):void}) {
  const record=session.recorded;
  const content=<><strong>{course.code}</strong><span className="tcal-class-title">{session.title}</span><b>{classTime(session)}</b>{session.location&&<span>{session.location}</span>}{record?.status==='cancelled'?<span className="tcal-class-status">Cancelled</span>:cancelled?<span className="tcal-class-status">No class</span>:null}{record?.status==='rescheduled'&&<span className="tcal-class-status">Rescheduled</span>}{overlap&&<span className="tcal-overlap">Time overlap</span>}</>;
  return <>{onOpenTerm?<button type="button" className="tcal-open" onClick={()=>onOpenTerm(course.id)}>{content}</button>:<div className="tcal-open">{content}</div>}{record?.notes&&<details className="tcal-recorded-note"><summary>Schedule note</summary><p>{record.notes}</p></details>}</>;
}

function UndatedClasses({items,onOpenTerm}:{items:CalendarCourse[];onOpenTerm?(id:string):void}) {
  const undated=items.flatMap(({course,calendar})=>(calendar.recordedClasses??[]).filter(record=>!record.date).map(record=>({course,record})));
  if(!undated.length)return null;
  return <section className="tcal-undated" aria-label="Classes with dates to be confirmed"><h3>Date to be confirmed</h3><p>These classes stay outside the dated calendar until their dates are confirmed.</p><div>{undated.map(({course,record})=><article className="tcal-session" data-recorded-class={record.id} key={`${course.id}-${record.id}`}><CalendarSessionContent course={course} session={recordedOccurrence(record)} cancelled={record.status==='cancelled'} overlap={false} onOpenTerm={onOpenTerm}/></article>)}</div></section>;
}

function CalendarGrid({items,noClassDays,onOpenTerm,onNoClassDate,relative=false}:{items:CalendarCourse[];noClassDays:TeachNoClassDay[];onOpenTerm?(id:string):void;onNoClassDate?(date:string):void;relative?:boolean}) {
  const datedMondays=relative?[]:combinedTeachingMondays(items.map(item=>item.calendar));
  const rows=relative?Array.from({length:items[0]?.calendar.totalWeeks??0},(_,index)=>({monday:'',week:index+1})):datedMondays.map((monday:string)=>({monday,week:0}));
  const noClassByDate=new Map(noClassDays.map(day=>[day.date,day]));
  return <div className="tcal-grid" data-teach-area="TH4"><table className="tcal-table"><caption>{relative?`${courseLabel(items[0].course)} · Weeks 1–${items[0].calendar.totalWeeks} · Dates not set`:'Combined teaching calendar · Monday to Sunday'}</caption><thead><tr><th scope="col">{relative?'Course week':'Week starting'}</th>{teachingDays.map((day:string)=><th scope="col" key={day}><abbr title={day}>{day.slice(0,3)}</abbr></th>)}</tr></thead><tbody>{rows.map(({monday,week}:{monday:string;week:number})=>{
    const active=items.flatMap(item=>{const localWeek=relative?week:teachingWeekAt(item.calendar.monday,monday);return localWeek&&localWeek>=1&&localWeek<=item.calendar.totalWeeks?[{...item,week:localWeek}]:[];});
    return <tr key={monday||week}><th scope="row">{monday&&<time dateTime={monday}>{dateLabel(monday)}</time>}{active.map(item=><span className="tcal-course-week" key={item.course.id}><strong>{item.course.code}</strong><span>Week {item.week}{item.week===1?' · First week':''}{item.week===item.calendar.totalWeeks?' · Final week':''}</span></span>)}</th>{teachingDays.map((day:string,weekday:number)=>{
      const iso=monday?teachingDateAt(monday,1,weekday):null,closure=iso?noClassByDate.get(iso):undefined;
      const occurrences=active.flatMap(item=>[
        ...item.calendar.sessions.filter(session=>teachingSessionOccurs(session,item.week,weekday)).map((session):CalendarOccurrence=>session),
        ...(iso?(item.calendar.recordedClasses??[]).filter(record=>record.date===iso).map(recordedOccurrence):[]),
      ].map(session=>({...item,session}))).sort((a,b)=>(a.session.start||'99').localeCompare(b.session.start||'99'));
      const conflictIds=new Set<string>();
      if(!closure)for(let i=0;i<occurrences.length;i++)for(let j=i+1;j<occurrences.length;j++){
        const a=occurrences[i].session,b=occurrences[j].session;
        if(a.recorded?.status!=='cancelled'&&b.recorded?.status!=='cancelled'&&a.start&&a.end&&b.start&&b.end&&a.start<b.end&&b.start<a.end){conflictIds.add(a.id);conflictIds.add(b.id);}
      }
      const canEditDay=Boolean(iso&&onNoClassDate),dayAction=`${closure?'Edit':'Add'} no-class day ${iso}`;
      return <td key={day} data-day={day} data-date={iso??''} tabIndex={canEditDay?0:undefined} aria-label={canEditDay?dayAction:undefined} title={canEditDay?`${dayAction}. Double-click, or focus this cell and press Enter or Space.`:undefined} onDoubleClick={canEditDay?event=>{
        if((event.target as HTMLElement).closest('button,a,input,select,textarea,summary,details'))return;
        event.preventDefault();event.currentTarget.focus({preventScroll:true});onNoClassDate!(iso!);
      }:undefined} onKeyDown={canEditDay?event=>{
        if(event.target!==event.currentTarget||!['Enter',' '].includes(event.key))return;
        event.preventDefault();onNoClassDate!(iso!);
      }:undefined}>{iso&&<time className="tcal-date" dateTime={iso}>{Number(iso.slice(8))} {monthFormatter.format(new Date(`${iso}T00:00:00Z`))}</time>}{closure&&(onNoClassDate?<button type="button" className="tcal-no-class" aria-label={`Edit no-class day ${closure.date}`} onClick={()=>onNoClassDate(closure.date)}>No class{closure.description&&<span>{closure.description}</span>}</button>:<div className="tcal-no-class">No class{closure.description&&<span>{closure.description}</span>}</div>)}{occurrences.map(({course,session,week:localWeek})=>{
        const cancelled=!!closure||session.recorded?.status==='cancelled';
        return <article className={`tcal-session${cancelled?' tcal-cancelled':''}`} data-recorded-class={session.recorded?.id} data-class-status={session.recorded?.status} key={`${course.id}-${session.id}`} aria-label={`${course.code}, ${session.title}, Week ${localWeek}, ${day} ${classTime(session)}${cancelled?', no class':''}`}><CalendarSessionContent course={course} session={session} cancelled={cancelled} overlap={conflictIds.has(session.id)} onOpenTerm={onOpenTerm}/></article>;
      })}</td>;
    })}</tr>;
  })}</tbody></table></div>;
}

function RecordedCalendarSummary({calendar}:{calendar:TeachTermCalendar}) {
  const records=calendar.recordedClasses??[],first=records.filter(record=>record.date).map(record=>record.date).sort()[0],last=records.filter(record=>record.date).map(record=>record.date).sort().at(-1);
  return <section className="tcal-recorded-summary" aria-label="Recorded course dates" data-teach-area="T7.1"><dl><div><dt>Week 1 Monday</dt><dd>{calendar.monday?teachingCompactDate(calendar.monday):'Not confirmed'}</dd></div><div><dt>Calendar weeks</dt><dd>{calendar.totalWeeks}</dd></div><div><dt>First recorded class</dt><dd>{first?dateLabel(first):'Not confirmed'}</dd></div><div><dt>Last recorded class</dt><dd>{last?dateLabel(last):'Not confirmed'}</dd></div></dl><p>{records.length} classes in the teaching schedule. Weeks span the Monday of the first recorded class through the final class week, including holidays. Original teaching-week labels stay in the Teaching Schedule.</p></section>;
}

/** Home is an overview. Course pages own schedule edits; no-class dates are shared. */
export function TeachCalendarStudy({courses,state,onChange,onOpenTerm}:{courses:readonly TeachStudyCourse[];onOpenTerm(id:string):boolean|void}&StateProps) {
  const [year,setYear]=useState(String(new Date().getFullYear())),[season,setSeason]=useState(currentTeachingSeason()),[editing,setEditing]=useState<{day:TeachNoClassDay|null;date:string}|undefined>(undefined),[status,setStatus]=useState('');
  const heading=useRef<HTMLHeadingElement>(null);
  const titleId=useId(),filtered=courses.filter(course=>course.year===year&&course.season===season),items=filtered.map(course=>({course,calendar:state.terms[course.id]??defaultTeachTermCalendar()}));
  const dated=items.filter(item=>item.calendar.monday),relative=items.filter(item=>!item.calendar.monday);
  const openNoClassDate=(date:string)=>setEditing({day:state.noClassDays.find(day=>day.date===date)??null,date});
  return <section className="tcal tcal-overview" aria-labelledby={titleId}>
    <header className="tcal-heading"><div><h2 ref={heading} id={titleId} tabIndex={-1}>Teaching calendar</h2><p>All your courses in one view. Edit class schedules within each course.</p></div><div className="tcal-controls" data-teach-area="TH3"><label>Year<TeachYearSelect value={year} onChange={setYear}/></label><label>Season<select value={season} onChange={event=>setSeason(event.target.value)}>{teachingSeasons.map((value:string)=><option key={value}>{value}</option>)}</select></label></div></header>
    {!items.length&&<p className="tcal-empty">No courses in {year} {season}. Choose another year or season to view past or planned courses.</p>}
    <div className="tcal-course-key">{items.map(({course,calendar})=>{
      const pending=(calendar.recordedClasses??[]).filter(record=>!record.date),firstPending=pending[0];
      return <div className="tcal-course-row" key={course.id}>
        <button className="tcal-course-summary" type="button" onClick={()=>onOpenTerm(course.id)}><strong>{course.code}</strong><span>{course.title}</span><span>{calendar.monday?`${dateLabel(calendar.monday)} – ${dateLabel(teachingDateAt(calendar.monday,calendar.totalWeeks,6)!)}`:'Week 1 Monday not set'}</span><span>Week 1 → Week {calendar.totalWeeks}{calendar.recordedClasses?' (calendar weeks)':''} · {calendarPhase(calendar)}</span></button>
        {firstPending&&<button type="button" className="tcal-pending-class" data-recorded-class={firstPending.id} aria-label={`${course.code}, ${firstPending.title}, date to be confirmed; ${pending.length} pending ${pending.length===1?'class':'classes'}. Open course calendar.`} title={`${firstPending.title} · Date to be confirmed`} onClick={()=>onOpenTerm(course.id)}>{firstPending.title}</button>}
      </div>;
    })}</div>
    {!!dated.length&&<CalendarGrid items={dated} noClassDays={state.noClassDays} onOpenTerm={id=>{onOpenTerm(id);}} onNoClassDate={openNoClassDate}/>}
    {!!relative.length&&<section className="tcal-relative"><h3>Dates not set</h3><p>These course weeks stay separate until a Week 1 Monday is set in each course.</p>{relative.map(item=><CalendarGrid key={item.course.id} items={[item]} relative noClassDays={[]} onOpenTerm={id=>{onOpenTerm(id);}}/>)}</section>}
    <section className="tcal-closures" aria-label="No-class days"><h3>No-class days</h3>{state.noClassDays.length?<ul>{[...state.noClassDays].sort((a,b)=>a.date.localeCompare(b.date)).map(day=><li key={day.id}><span><time dateTime={day.date}>{dateLabel(day.date)}</time>{day.description&&<> · {day.description}</>}</span><button type="button" className="tcal-text-button" aria-label={`Edit no-class day ${day.date}`} onClick={()=>openNoClassDate(day.date)}>Edit</button><button type="button" className="tcal-text-button" aria-label={`Remove no-class day ${day.date}`} onClick={()=>{onChange(previous=>({...previous,noClassDays:previous.noClassDays.filter(item=>item.id!==day.id)}));setStatus(`Removed no-class day ${dateLabel(day.date)}.`);heading.current?.focus({preventScroll:true});}}>Remove</button></li>)}</ul>:<p>No no-class days added.</p>}</section>
    <p className="tcal-status" role="status">{status}</p>
    {editing!==undefined&&<NoClassDialog fallbackFocus={heading} initial={editing.day} initialDate={editing.date} days={state.noClassDays} onClose={()=>setEditing(undefined)} onSave={day=>{onChange(previous=>({...previous,noClassDays:editing.day?previous.noClassDays.map(item=>item.id===editing.day!.id?day:item):[...previous.noClassDays,day]}));setStatus(`${editing.day?'Updated':'Added'} no-class day ${dateLabel(day.date)}.`);setEditing(undefined);}}/>}
  </section>;
}

/** Recorded reference dates are read-only; new course plans remain session-local. */
export function TeachCourseCalendarStudy({course,state,onChange,onOpenSchedule}:{course:TeachStudyCourse;onOpenSchedule?():void}&StateProps) {
  const calendar=state.terms[course.id]??defaultTeachTermCalendar(),[editing,setEditing]=useState<TeachClassSession|null|undefined>(undefined),[status,setStatus]=useState('');
  const addButton=useRef<HTMLButtonElement>(null);
  const recordedReference=Boolean(course.readOnly&&calendar.recordedClasses?.length);
  const update=(next:TeachTermCalendar)=>onChange(previous=>({...previous,terms:{...previous.terms,[course.id]:next}}));
  const overlap=calendar.sessions.some((session,index)=>calendar.sessions.slice(index+1).some(other=>teachingSessionsOverlap(session,other)));
  return <section className="tcal tcal-course-calendar" aria-label={`${courseLabel(course)} teaching calendar`}><header className="tcal-heading"><div><h2>Teaching calendar</h2><p>{courseLabel(course)} · {recordedReference?'Class dates from the teaching schedule.':'Plan class sessions for this course.'}</p></div>{recordedReference?<button className="tcal-button" type="button" onClick={onOpenSchedule}>View teaching schedule</button>:<button ref={addButton} className="tcal-button tcal-primary" type="button" onClick={()=>setEditing(null)}>Add class session</button>}</header>{recordedReference?<RecordedCalendarSummary calendar={calendar}/>:<><CourseCalendarSettings key={course.id} course={course} calendar={calendar} onSave={update}/><p className="tcal-scope">Week 1 is always the first teaching week. Calendar plans are kept in this tab. No-class days are managed on asTeach Home.</p></>}{overlap&&<p className="tcal-error">Some class times overlap. All sessions are shown so you can review them.</p>}{!recordedReference&&<div className="tcal-series">{calendar.sessions.length?calendar.sessions.map(session=><article key={session.id}><div><strong>{session.title}</strong><span>{teachingDays[session.weekday]} · {session.start}–{session.end} · Weeks {session.weekFrom}–{session.weekTo}{session.location?` · ${session.location}`:''}</span></div><button className="tcal-text-button" type="button" aria-label={`Edit ${session.title}`} onClick={()=>setEditing(session)}>Edit</button><button className="tcal-text-button" type="button" aria-label={`Remove ${session.title}`} onClick={()=>{update({...calendar,sessions:calendar.sessions.filter(item=>item.id!==session.id)});setStatus(`Removed ${session.title} and all its occurrences.`);addButton.current?.focus({preventScroll:true});}}>Remove</button></article>):<p className="tcal-empty">No classes planned yet. Add each lecture, tutorial or other class separately.</p>}</div>}<UndatedClasses items={[{course,calendar}]}/><CalendarGrid items={[{course,calendar}]} relative={!calendar.monday} noClassDays={state.noClassDays}/><p className="tcal-status" role="status">{status}</p>{editing!==undefined&&<SessionDialog fallbackFocus={addButton} initial={editing} totalWeeks={calendar.totalWeeks} onClose={()=>setEditing(undefined)} onSave={session=>{update({...calendar,sessions:editing?calendar.sessions.map(item=>item.id===editing.id?session:item):[...calendar.sessions,session]});setStatus(`${editing?'Updated':'Added'} ${session.title}.`);setEditing(undefined);}}/>}</section>;
}
