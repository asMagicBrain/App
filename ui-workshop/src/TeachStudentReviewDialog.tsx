import React, {useMemo, useState} from 'react';
import {CourseDialog} from './TeachCoursesStudy';
import {renderTeachSource} from './teach-content.mjs';
import {composeTeachStudentSource, inspectTeachStudentDependencies, splitTeachStudentSections} from './teach-document.mjs';

export type TeachStudentEdition = {
  number: number;
  source: string;
  instructorSource: string;
  includedSectionIds: readonly string[];
};

type Props = {
  source: string;
  currentSource: string;
  path: string;
  assets?: Readonly<Record<string, string>>;
  previous?: TeachStudentEdition;
  hasDraft: boolean;
  reference: boolean;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(edition: Omit<TeachStudentEdition, 'number'>): void;
};

/** Review captures saved text. Confirming creates a separate session value. */
export function TeachStudentReviewDialog({source, currentSource, path, assets, previous, hasDraft, reference, returnFocusRef, onCancel, onConfirm}: Props) {
  const sections = useMemo(() => splitTeachStudentSections(source), [source]);
  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  const eligible = sections.filter(section => !(section.recognized && section.empty));
  const proposed = useMemo(() => composeTeachStudentSource(sections, [...included]), [sections, included]);
  const proposedHtml = useMemo(() => renderTeachSource(proposed, path, assets).html, [proposed, path, assets]);
  const previousHtml = useMemo(() => previous ? renderTeachSource(previous.source, path, assets).html : '', [previous, path, assets]);
  const dependencies = useMemo(() => inspectTeachStudentDependencies(proposed, path, assets), [proposed, path, assets]);
  const stale = currentSource !== source;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stale || !proposed.trim()) return;
    onConfirm({source: proposed, instructorSource: source, includedSectionIds: eligible.filter(section => included.has(section.id)).map(section => section.id)});
  };
  return <CourseDialog title="Review student copy" onClose={onCancel} returnFocusRef={returnFocusRef}>
    <form className="teach-review-form" data-teach-area="T9" onSubmit={submit} onClick={event => {if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();}}>
      <p>Choose the saved Instructor content to include. Review the complete preview before {previous ? 'updating' : 'creating'} the Student version.</p>
      <p className="teach-review-note">This creates a separate copy for this session. It does not publish or export the course.{reference && ' The original reference remains read-only.'}</p>
      {hasDraft && <p className="teach-review-note">Unsaved Instructor changes are excluded.</p>}
      {stale && <p className="teach-review-error" role="alert">Saved Instructor text changed during this review. Cancel and review the latest saved text.</p>}
      <div className="teach-review-layout">
        <fieldset className="teach-review-sections"><legend>Include in Student version</legend>
          {eligible.length ? eligible.map(section => <label key={section.id}><input type="checkbox" checked={included.has(section.id)} onChange={event => {
            const checked = event.currentTarget.checked;
            setIncluded(previousIds => {const next = new Set(previousIds); if (checked) next.add(section.id); else next.delete(section.id); return next;});
          }}/><span>{section.title}</span></label>) : <p>No saved course content yet.</p>}
          {sections.some(section => section.recognized && section.empty) && <p>Empty standard sections are omitted.</p>}
        </fieldset>
        <div className={`teach-review-comparison${previous ? ' has-previous' : ''}`}>
          {previous && <section className="teach-review-copy"><h3>Current Student version · {previous.number}</h3><div className="teach-markdown" tabIndex={0} role="region" aria-label="Current student version preview" dangerouslySetInnerHTML={{__html: previousHtml}}/></section>}
          <section className="teach-review-copy"><h3>{previous ? 'Proposed Student version' : 'Student version preview'}</h3><div className="teach-review-preview" aria-label="Student copy review preview" tabIndex={0} onClick={event => {if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();}}>
            {proposed.trim() ? <article className="teach-markdown" dangerouslySetInnerHTML={{__html: proposedHtml}}/> : <p className="teach-review-empty">Select the sections you want students to receive.</p>}
          </div></section>
        </div>
      </div>
      <details className="teach-review-source"><summary>Review selected source</summary>{proposed ? <pre tabIndex={0} role="region" aria-label="Selected student source"><code>{proposed}</code></pre> : <p>Select sections to review their exact Markdown source.</p>}</details>
      <section className="teach-review-dependencies" aria-label="Student links and images"><h3>Links and images</h3>{dependencies.length ? <ul>{dependencies.map((dependency, index) => <li key={`${dependency.kind}-${dependency.target}-${index}`}><code>{dependency.target}</code><span>{dependency.status}</span></li>)}</ul> : <p>No linked images or destinations in the selected content.</p>}<p>Only admitted local reference images appear in this preview. No files are copied, destinations verified, or publication permissions granted.</p></section>
      <footer><span>{eligible.filter(section => included.has(section.id)).length} of {eligible.length} sections included</span><button type="button" className="pws-button" onClick={onCancel}>Cancel review</button><button type="submit" className="pws-button tcs-primary" disabled={stale || !proposed.trim()}>{previous ? 'Update student version' : 'Create student version'}</button></footer>
    </form>
  </CourseDialog>;
}
