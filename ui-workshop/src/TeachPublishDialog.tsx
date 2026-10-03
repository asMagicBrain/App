import React,{useMemo,useState} from 'react';
import {CourseDialog} from './TeachCoursesStudy';
import type {TeachStudyCourse} from './teach-plugin-fixture';
import type {TeachStudentEdition} from './TeachStudentReviewDialog';
import {createTeachPublicationPlan,teachPublicationDestinations,teachStudentRepositoryName} from './teach-publication.mjs';
import './teach-publish-dialog.css';

type Destination='export'|'github'|'gitbook';
type Props={course:TeachStudyCourse;edition:TeachStudentEdition;initialDestination:Destination;returnFocusRef:React.RefObject<HTMLElement|null>;onClose():void;onPrepared(message:string):void};

/** Storybook-only publication planner. It never downloads, writes, pushes or synchronizes. */
export function TeachPublishDialog({course,edition,initialDestination,returnFocusRef,onClose,onPrepared}:Props){
  const [destination,setDestination]=useState<Destination>(initialDestination),[format,setFormat]=useState<'single'|'multiple'>('multiple');
  const [repository,setRepository]=useState(()=>teachStudentRepositoryName(course.code)),[prepared,setPrepared]=useState(false);
  const plan=useMemo(()=>createTeachPublicationPlan({course,edition,destination,format,repository}),[course,edition,destination,format,repository]);
  const change=()=>setPrepared(false);
  const prepare=(event:React.FormEvent)=>{event.preventDefault();if(!plan.ready)return;setPrepared(true);onPrepared(`${teachPublicationDestinations.find(item=>item.id===destination)?.label} preview prepared. No files or remote services were changed.`);};
  return <CourseDialog title="Prepare student output" onClose={onClose} returnFocusRef={returnFocusRef}>
    <form className="teach-publish" onSubmit={prepare} data-teach-area="T10">
      <p>Build output from Student version {edition.number}. The reviewed version remains unchanged.</p>
      <p className="teach-publish-boundary">Storybook preview only · No files, repositories or online sites are created.</p>
      <fieldset className="teach-publish-destinations"><legend>Destination</legend>{teachPublicationDestinations.map(item=><label key={item.id} className={destination===item.id?'is-selected':undefined}><input type="radio" name="destination" value={item.id} checked={destination===item.id} onChange={()=>{setDestination(item.id as Destination);change();}}/><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</fieldset>
      <div className="teach-publish-settings">
        <label>Page organization<select value={format} onChange={event=>{setFormat(event.currentTarget.value as 'single'|'multiple');change();}}><option value="multiple">Multiple pages</option><option value="single">One page</option></select><small>The Instructor editor remains one continuous document.</small></label>
        <label>Student repository name<input value={repository} aria-invalid={plan.errors.some(error=>error.startsWith('Enter a repository'))||undefined} onChange={event=>{setRepository(event.currentTarget.value);change();}}/><small>Course Code remains “{course.code}”; only the output-safe name changes.</small></label>
      </div>
      {plan.errors.length>0&&<div className="teach-publish-errors" role="alert"><strong>Output is not ready</strong><ul>{plan.errors.map(error=><li key={error}>{error}</li>)}</ul></div>}
      <div className="teach-publish-review">
        <section aria-labelledby="teach-publish-pages"><h3 id="teach-publish-pages">Student pages <span>{plan.pages.length}</span></h3>{plan.pages.length?<ol>{plan.pages.map(page=><li key={page.path}><span>{page.title}</span><code>{page.path}</code></li>)}</ol>:<p>No reviewed Student content is available.</p>}</section>
        <section aria-labelledby="teach-publish-files"><h3 id="teach-publish-files">Output files <span>{plan.files.length}</span></h3><div className="teach-publish-target"><span>Proposed destination</span><code>{plan.target}</code></div><ul>{plan.files.map(file=><li key={file.path}><code>{file.path}</code><span>{file.description}</span></li>)}</ul></section>
      </div>
      <section className="teach-publish-checks" aria-label="Publication checks"><h3>Before native publication</h3><ul>{plan.warnings.map(item=><li key={item}>{item}</li>)}</ul>{destination==='github'&&<p><button type="button" disabled>Choose GitHub repository…</button> Reviewed GitHub push is outside this Storybook batch.</p>}{destination==='gitbook'&&<p><button type="button" disabled>Connect GitBook…</button> The compatible files can be exported without a GitBook account.</p>}</section>
      {prepared&&<div className="teach-publish-prepared" role="status"><strong>Preview prepared</strong><p>{plan.files.length} planned files · {plan.pages.length} Student page{plan.pages.length===1?'':'s'} · no external changes.</p></div>}
      <footer><span>Student version {edition.number} · {plan.sectionCount} reviewed section{plan.sectionCount===1?'':'s'}</span><button type="button" className="pws-button" onClick={onClose}>Cancel</button><button type="submit" className="pws-button tcs-primary" disabled={!plan.ready}>Prepare preview</button></footer>
    </form>
  </CourseDialog>;
}
