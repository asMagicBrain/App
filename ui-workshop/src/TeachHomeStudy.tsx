import React, {useLayoutEffect, useRef, useState} from 'react';
import type {TeachStudyCourse} from './teach-plugin-fixture';
import {NewCourseDialog,AddCourseDialog,NewCourseButton} from './TeachCoursesStudy';
import {TeachTeacherProfileDialog} from './TeachTeacherProfileDialog';
import {TeachCalendarStudy, type TeachCalendarState} from './TeachCalendarStudy';
import {type TeachTeacherProfile} from './teach-teacher-profile';
import './teach-home-study.css';

export type TeachRecentDocument={courseId:string;sectionId:string;sectionTitle:string};
type Props={
  courses:readonly TeachStudyCourse[];
  recent:readonly TeachRecentDocument[];
  teacherProfile:TeachTeacherProfile;
  readOnly?:boolean;
  calendarState:TeachCalendarState;
  onCalendarChange:React.Dispatch<React.SetStateAction<TeachCalendarState>>;
  onSaveProfile(profile:TeachTeacherProfile):void;
  onOpenDocument(document:TeachRecentDocument):boolean|void;
  onOpenTerm(id:string):boolean|void;
  onCreate(course:TeachStudyCourse):void;
  onReturnToRepository():void;
};

function OfficeDetail({label,placeholder}:{label:string;placeholder:string}) {
  const [saved,setSaved]=useState(''),[draft,setDraft]=useState(''),[editing,setEditing]=useState(false);
  const input=useRef<HTMLInputElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const action=label.toLowerCase();
  useLayoutEffect(()=>{if(editing){input.current?.focus();input.current?.select();}},[editing]);
  const save=()=>{setSaved(draft.trim());setDraft(draft.trim());setEditing(false);toggle.current?.focus({preventScroll:true});};
  const cancel=()=>{setDraft(saved);setEditing(false);toggle.current?.focus({preventScroll:true});};
  return <div className={`ths-office-field${editing?' is-editing':''}`}><label><span>{label}</span><input ref={input} aria-label={label} placeholder={placeholder} value={editing?draft:saved} readOnly={!editing} maxLength={160} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(!editing)return;if(event.key==='Enter'){event.preventDefault();save();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}}}/></label><button ref={toggle} type="button" className="ths-office-edit" aria-label={`${editing?'Save':'Edit'} ${action}`} title={editing?`Save ${action} (Enter); cancel with Escape`:`Edit ${action}`} onClick={()=>{if(editing)save();else{setDraft(saved);setEditing(true);}}}><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{editing?<path d="m3 8 3 3 7-7"/>:<><path d="m10 3 3 3-7 7-4 1 1-4Z"/><path d="m9 4 3 3"/></>}</svg></button></div>;
}

export function TeachHomeStudy({courses,teacherProfile,readOnly=false,calendarState,onCalendarChange,onSaveProfile,onOpenTerm,onCreate,onReturnToRepository}:Props) {
  const [dialog,setDialog]=useState<'profile'|'new'|'add'|null>(null);
  const created=(course:TeachStudyCourse)=>{setDialog(null);onCreate(course);};
  return <section className="ths-home" aria-labelledby="ths-heading" data-plugin-view="home">
    <div className="ths-content">
      <header className="ths-heading" data-teach-area="TH1"><div className="ths-title"><span className="tcs-eyebrow">asTeach</span><h1 id="ths-heading" tabIndex={-1}>Home</h1><p>Your teaching calendar and courses.</p></div><div className="ths-actions"><div className="ths-office-details" aria-label="Office details" data-teach-area="TH1.1"><OfficeDetail label="Office hours" placeholder=""/><OfficeDetail label="Weekdays" placeholder=""/><OfficeDetail label="Office location" placeholder=""/></div><button type="button" className="pws-button" onClick={()=>setDialog('profile')}>Edit teacher details</button>{!readOnly&&<button type="button" className="pws-button" onClick={()=>setDialog('add')}>Add existing course</button>}<NewCourseButton onClick={()=>setDialog('new')}/></div></header>
      <TeachCalendarStudy courses={courses} state={calendarState} onChange={onCalendarChange} onOpenTerm={onOpenTerm}/>
      <footer className="tcs-footer"><span>{readOnly?'Reference courses are read-only. New courses and Home settings stay in this tab.':'Storybook preview · Changes stay in this tab.'}</span><button type="button" onClick={onReturnToRepository}>Return to repository</button></footer>
    </div>
    {dialog==='profile'&&<TeachTeacherProfileDialog profile={teacherProfile} onSave={onSaveProfile} onClose={()=>setDialog(null)}/>}
    {dialog==='new'&&<NewCourseDialog courses={courses} teacherProfile={teacherProfile} onClose={()=>setDialog(null)} onCreate={created}/>}
    {!readOnly&&dialog==='add'&&<AddCourseDialog courses={courses} onClose={()=>setDialog(null)} onCreate={created}/>}
  </section>;
}
