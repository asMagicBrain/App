import React, {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {EditorState} from '@codemirror/state';
import {EditorView, drawSelection, keymap, lineNumbers} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {syntaxHighlighting} from '@codemirror/language';
import {markdown} from '@codemirror/lang-markdown';
import {sourceHighlightStyle} from '../../apps/desktop/ui/cm6-theme.mjs';
import {localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {DocumentOutline} from './DocumentOutline';
import {PanelResizeHandle} from './PanelResizeHandle';
import {buildDocumentOutline, type DocumentOutlineEntry} from './outline-model';
import {teachStudyCourse, type TeachStudyCourse} from './teach-plugin-fixture';
import type {TeachCourseSummary} from './TeachCoursesStudy';
import {TeachStudentReviewDialog, type TeachStudentEdition} from './TeachStudentReviewDialog';
import {composeTeachStudentSource, createTeachInstructorDocument, splitTeachStudentSections} from './teach-document.mjs';
import {teachDisplaySource, renderTeachSource} from './teach-content.mjs';
import {useTeachSplitScroll} from './useTeachSplitScroll';
import {TeachCourseCalendarStudy,type TeachCalendarState} from './TeachCalendarStudy';
import './teach-plugin-study.css';

export type TeachPageNavigationRequest = {sequence:number;sectionId:string};
export type TeachPluginStudyProps = {
  course?: TeachStudyCourse;
  active?: boolean;
  calendarState:TeachCalendarState;
  onCalendarChange:React.Dispatch<React.SetStateAction<TeachCalendarState>>;
  navigationRequest?: TeachPageNavigationRequest;
  onNavigationGuardChange?(guard:(()=>boolean)|null):void;
  onBackToCourses?(): void;
  onSessionChange?(summary: TeachCourseSummary): void;
  sidebarOpen: boolean;
  onSidebarOpenChange(open: boolean): void;
  outlineOpen: boolean;
  onOutlineOpenChange(open: boolean): void;
};
type DocumentSession = {saved: string; draft: string; reset: number};
type EditorCache = Map<string, {reset: number; state: EditorState}>;
function TeachIcon({name}: {name: 'book' | 'close' | 'back'}) {
  const paths = {book: 'M8 3C6 1.5 3 1.5 1 2v11c2-.5 5-.5 7 1m0-11c2-1.5 5-1.5 7-1v11c-2-.5-5-.5-7 1V3', close: 'm4 4 8 8M12 4l-8 8', back: 'm6 3-5 5 5 5M1 8h14'};
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

function TeachSourceEditor({id, title, session, cache, editor, entries, active, readOnly = false, onActiveHeading, onChange, onSave}: {
  id: string; title: string; session: DocumentSession; cache: React.RefObject<EditorCache>;
  active: boolean;
  readOnly?: boolean;
  editor: React.RefObject<EditorView | null>; entries: readonly DocumentOutlineEntry[]; onActiveHeading(id: string | undefined): void; onChange(id: string, text: string): void; onSave(id: string, text: string): void;
}) {
  const mount = useRef<HTMLDivElement>(null), callbacks = useRef({onChange, onSave, entries, onActiveHeading, active});
  const scheduleMeasure = useRef<() => void>(() => {});
  callbacks.current = {onChange, onSave, entries, onActiveHeading, active};
  useLayoutEffect(() => {
    if (!mount.current) return;
    const previous = cache.current.get(id);
    const state = previous?.reset === session.reset ? previous.state : EditorState.create({doc: session.draft, extensions: [
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      lineNumbers(), drawSelection(), history(), markdown(), syntaxHighlighting(sourceHighlightStyle), EditorView.lineWrapping,
      keymap.of([{key: 'Mod-s', run: view => {if (!view.composing) callbacks.current.onSave(id, view.state.doc.toString()); return true;}}, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.contentAttributes.of({'aria-label': `${title}${readOnly ? ' reference' : ''} source`, 'aria-readonly': String(readOnly), tabindex: '0', spellcheck: 'false'}),
      EditorView.updateListener.of(update => {if (update.docChanged) callbacks.current.onChange(id, update.state.doc.toString());}),
    ]});
    const view = new EditorView({parent: mount.current, state}); editor.current = view;
    let frame = 0;
    const schedule = () => {if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (!callbacks.current.active || !view.dom.getClientRects().length || view.dom.closest('[hidden]')) return;
      const top = view.scrollDOM.getBoundingClientRect().top + 24;
      const from = view.lineBlockAtHeight(Math.max(0, top - view.documentTop)).from;
      let current: string | undefined = callbacks.current.entries[0]?.id;
      for (const entry of callbacks.current.entries) {if (entry.from > from) break; current = entry.id;}
      if (view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight && view.scrollDOM.scrollTop >= view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight - 2) current = callbacks.current.entries.at(-1)?.id;
      callbacks.current.onActiveHeading(current);
    });};
    scheduleMeasure.current = schedule;
    view.scrollDOM.addEventListener('scroll', schedule, {passive: true});
    const resize = new ResizeObserver(schedule); resize.observe(view.dom); schedule();
    return () => {cancelAnimationFrame(frame); resize.disconnect(); view.scrollDOM.removeEventListener('scroll', schedule); scheduleMeasure.current = () => {}; cache.current.set(id, {reset: session.reset, state: view.state}); if (editor.current === view) editor.current = null; view.destroy();};
  }, [id, session.reset, readOnly]);
  useLayoutEffect(() => {if (active) scheduleMeasure.current();}, [entries, active]);
  return <div className="teach-source" ref={mount}/>;
}

const emptyReferenceAssets: Readonly<Record<string, string>> = {};
const normalizedHeading = (title: string) => title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** One saved/draft document and independent reviewed versions per mounted term. */
export function TeachPluginStudy({course = teachStudyCourse, calendarState, onCalendarChange, active = true, navigationRequest, onNavigationGuardChange, onBackToCourses, onSessionChange, sidebarOpen, onSidebarOpenChange, outlineOpen, onOutlineOpenChange}: TeachPluginStudyProps) {
  const [document] = useState(() => createTeachInstructorDocument(course));
  const [session, setSession] = useState<DocumentSession>(() => ({saved: document.source, draft: document.source, reset: 0}));
  const [selected, setSelected] = useState('home'), [mode, setMode] = useState<'preview' | 'edit' | 'split'>('preview');
  const [referenceMode, setReferenceMode] = useState<'preview' | 'source' | 'split'>('preview');
  const [studentMode, setStudentMode] = useState<'preview' | 'source'>('preview');
  const [editions, setEditions] = useState<TeachStudentEdition[]>([]);
  const [studentVersion, setStudentVersion] = useState<number>();
  const [reviewSource, setReviewSource] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(248), [outlineWidth, setOutlineWidth] = useState(232);
  const [notice, setNotice] = useState(course.readOnly ? 'Read-only reference. Original files remain unchanged.' : 'One Instructor document for this course term.');
  const [activeHeading, setActiveHeading] = useState<string>();
  const [pendingJump, setPendingJump] = useState<{title?: string; fragment?: string} | null>(null);
  const root = useRef<HTMLDivElement>(null), reading = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const cache = useRef<EditorCache>(new Map());
  const identity = useId();
  const activeRef = useRef(active), sessionChange = useRef(onSessionChange);
  const lastNavigationRequest = useRef(0);
  activeRef.current = active; sessionChange.current = onSessionChange;
  const calendarSelected = selected === 'calendar', studentSelected = selected === 'student';
  const referencePage = course.reference?.pages.find(item => item.id === selected);
  const instructorSelected = !calendarSelected && !studentSelected && !referencePage;
  const sectionTitle = calendarSelected ? 'Course calendar' : studentSelected ? 'Student page' : referencePage?.title ?? 'Instructor page';
  const latestEdition = editions.at(-1);
  const edition = editions.find(item => item.number === studentVersion) ?? latestEdition;
  const dirty = session.draft !== session.saved, dirtyCount = dirty ? 1 : 0;
  const savedSections = useMemo(() => splitTeachStudentSections(session.saved), [session.saved]);
  const readySectionIds = [...savedSections.filter(item => !item.empty).map(item => item.id), ...(course.reference?.pages.filter(item => teachDisplaySource(item.source).trim()).map(item => item.id) ?? [])];
  const readySectionKey = readySectionIds.join('\0');
  const candidateSource = useMemo(() => composeTeachStudentSource(savedSections, savedSections.map(item => item.id)), [savedSections]);
  const rawSource = studentSelected ? edition?.source ?? candidateSource : referencePage?.source ?? session.saved;
  const sourcePath = referencePage?.path ?? document.path;
  const assets = course.reference?.assets ?? (course.readOnly ? emptyReferenceAssets : undefined);
  const split = !calendarSelected && !studentSelected && (course.readOnly ? referenceMode === 'split' : instructorSelected && mode === 'split');
  const editing = instructorSelected && !course.readOnly && mode !== 'preview';
  const sourceVisible = editing || (Boolean(course.readOnly) && split);
  const previewSource = split && !course.readOnly ? session.draft : rawSource;
  const previewResult = useMemo(() => renderTeachSource(previewSource, sourcePath, assets, {sourceMap: split}), [previewSource, sourcePath, assets, split]);
  const sourceView = studentSelected ? studentMode === 'source' : Boolean(course.readOnly && referenceMode === 'source');
  const entries = useMemo<DocumentOutlineEntry[]>(() => {
    if (calendarSelected || sourceView) return [];
    if (sourceVisible) {
      const source = course.readOnly ? rawSource : session.draft, displayed = teachDisplaySource(source), offset = source.length - displayed.length;
      return buildDocumentOutline(displayed).map(entry => ({...entry, from: entry.from + offset, to: entry.to + offset, id: `${identity}-${entry.id}`}));
    }
    return previewResult.headings.map((heading, index) => ({id: `${identity}-${heading.id}`, title: heading.title, level: heading.level as DocumentOutlineEntry['level'], line: index + 1, from: 0, to: 0}));
  }, [calendarSelected, sourceView, sourceVisible, course.readOnly, rawSource, session.draft, previewResult, identity]);
  useTeachSplitScroll({enabled: active && split, editor, reading, contentKey: previewSource, resetKey: `${selected}:${session.reset}`});
  const preview = previewResult.html.replace(/id="source-heading-(\d+)"/g, `id="${identity}-source-heading-$1"`);

  useEffect(() => {sessionChange.current?.({sectionId: selected, sectionTitle, dirtyCount, readySectionIds});}, [selected, sectionTitle, dirtyCount, readySectionKey]);
  useLayoutEffect(() => {
    onNavigationGuardChange?.(() => {
      if (!editor.current?.composing) return true;
      setNotice('Finish text composition before navigating away.'); return false;
    });
    return () => onNavigationGuardChange?.(null);
  }, [onNavigationGuardChange]);
  useEffect(() => {if (!active) setReviewSource(null);}, [active]);
  const updateDraft = useCallback((_id: string, text: string) => setSession(previous => ({...previous, draft: text})), []);
  const save = useCallback((_id: string, text: string) => {
    if (course.readOnly || editor.current?.composing) return;
    setSession(previous => ({...previous, saved: text, draft: text}));
    setNotice('Instructor page saved in this session.');
  }, [course.readOnly]);
  const navigate = (id: string) => {
    if (editor.current?.composing) {setNotice('Finish text composition before switching pages.'); return;}
    const alias = course.sections.find(item => item.id === id);
    setSelected(alias ? 'home' : id);
    setMode('preview'); setReferenceMode('preview'); setActiveHeading(undefined);
    setPendingJump(alias ? {title: alias.title} : null);
    setNotice(id === 'calendar' ? (course.readOnly ? 'Class dates from the teaching schedule.' : 'Calendar changes stay in this tab.') : id === 'student' ? 'Student versions are independent copies kept in this session.' : course.readOnly ? 'Read-only reference. Original files remain unchanged.' : 'One Instructor document for this course term.');
    if (root.current && root.current.clientWidth <= 620) onSidebarOpenChange(false);
  };
  useLayoutEffect(() => {
    if (!navigationRequest || lastNavigationRequest.current === navigationRequest.sequence) return;
    lastNavigationRequest.current = navigationRequest.sequence;
    const id = navigationRequest.sectionId;
    if (active && (['home', 'student', 'calendar'].includes(id) || course.sections.some(item => item.id === id) || course.reference?.pages.some(item => item.id === id))) navigate(id);
  }, [navigationRequest, active]);
  const switchMode = (next: 'preview' | 'edit' | 'split') => {
    if (editor.current?.composing) {setNotice('Finish text composition before switching modes.'); return;}
    if (!course.readOnly) setMode(next);
  };
  const backToCourses = () => {
    if (editor.current?.composing) {setNotice('Finish text composition before leaving this course.'); return;}
    onBackToCourses?.();
  };
  const cancel = () => {
    if (editor.current?.composing) {setNotice('Finish text composition before cancelling changes.'); return;}
    setSession(previous => ({...previous, draft: previous.saved, reset: previous.reset + 1}));
    setNotice('Unsaved Instructor changes were discarded. Student versions are unchanged.');
  };
  const closeSidebar = () => {
    onSidebarOpenChange(false);
    root.current?.closest('.fw-window')?.querySelector<HTMLButtonElement>('[aria-label="Toggle file sidebar"]')?.focus({preventScroll: true});
  };
  const closeOutline = () => {
    onOutlineOpenChange(false);
    root.current?.closest('.fw-window')?.querySelector<HTMLButtonElement>('[aria-label="Toggle document outline"]')?.focus({preventScroll: true});
  };
  const returnToDocument = () => {
    if (calendarSelected) root.current?.querySelector<HTMLElement>('.teach-calendar-page')?.focus({preventScroll: true});
    else if (sourceVisible) editor.current?.focus();
    else reading.current?.focus({preventScroll: true});
  };
  const selectHeading = (entry: DocumentOutlineEntry) => {
    setActiveHeading(entry.id);
    if (sourceVisible && editor.current) {
      const from = Math.min(entry.from, editor.current.state.doc.length);
      editor.current.dispatch({selection: {anchor: from}, effects: EditorView.scrollIntoView(from, {y: 'start', yMargin: 16})}); editor.current.focus();
    } else {
      const target = reading.current?.querySelector<HTMLElement>(`[id="${entry.id}"]`);
      if (target && reading.current) reading.current.scrollTop += target.getBoundingClientRect().top - reading.current.getBoundingClientRect().top - 20;
      reading.current?.focus({preventScroll: true});
    }
  };
  const followPreviewLink = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    const destination = localLink(anchor.dataset.localLink ?? '', sourcePath);
    if (destination?.fragment && destination.path === sourcePath) {
      const heading = [...(reading.current?.querySelectorAll<HTMLElement>('[data-heading-anchor]') ?? [])].find(item => item.dataset.headingAnchor === destination.fragment);
      if (heading && reading.current) {reading.current.scrollTop += heading.getBoundingClientRect().top - reading.current.getBoundingClientRect().top - 20; reading.current.focus({preventScroll: true}); return;}
    }
    if (studentSelected) {setNotice('This link is not included as a destination in this session-only Student version.'); return;}
    const target = destination && [...course.sections, ...(course.reference?.pages ?? [])].find(item => item.path === destination.path);
    if (!target) {setNotice('This link is unavailable in this course.'); return;}
    navigate(target.id);
    if (destination?.fragment) setPendingJump({fragment: destination.fragment});
  };
  const trackReading = () => {
    if (!activeRef.current || !reading.current || reading.current.hidden) return;
    const top = reading.current.getBoundingClientRect().top + 28;
    let current = entries[0]?.id;
    for (const entry of entries) {const heading = reading.current.querySelector<HTMLElement>(`[id="${entry.id}"]`); if (heading && heading.getBoundingClientRect().top <= top) current = entry.id;}
    setActiveHeading(current);
  };
  useLayoutEffect(() => {
    if (!activeRef.current) return;
    if (reading.current && !split) reading.current.scrollTop = 0;
    if (sourceVisible) {editor.current?.requestMeasure(); editor.current?.focus();}
    else if (calendarSelected) root.current?.querySelector<HTMLElement>('.teach-calendar-page')?.focus({preventScroll: true});
    else reading.current?.focus({preventScroll: true});
  }, [selected, mode, referenceMode, studentVersion]);
  useLayoutEffect(() => {
    if (!pendingJump || !reading.current || editing) return;
    const entry = pendingJump.title ? entries.find(item => normalizedHeading(item.title) === normalizedHeading(pendingJump.title!)) : undefined;
    const target = entry ? reading.current.querySelector<HTMLElement>(`[id="${entry.id}"]`) : [...reading.current.querySelectorAll<HTMLElement>('[data-heading-anchor]')].find(item => item.dataset.headingAnchor === pendingJump.fragment);
    if (target) {reading.current.scrollTop += target.getBoundingClientRect().top - reading.current.getBoundingClientRect().top - 20; setActiveHeading(entry?.id ?? target.id); reading.current.focus({preventScroll: true});}
    else setNotice('This heading is not present in the saved Instructor document.');
    setPendingJump(null);
  }, [pendingJump, entries, editing]);
  useLayoutEffect(() => {if (active) editor.current?.requestMeasure();}, [active, sidebarOpen, outlineOpen, sidebarWidth, outlineWidth, mode, referenceMode]);

  return <div className="teach-study" data-teach-study data-course-id={course.id} data-read-only={course.readOnly || undefined} ref={root}>
    <div className="teach-workspace">
      {sidebarOpen && <aside className="teach-sidebar" aria-label="Course pages" style={{'--panel-resize-width': `${sidebarWidth}px`} as React.CSSProperties}>
        <header><div><strong>{course.code}</strong><span>{course.title}</span></div><button type="button" className="teach-icon" aria-label="Close course pages" onClick={closeSidebar}><TeachIcon name="close"/></button></header>
        <nav aria-label="Course navigation">
          <p className="teach-nav-label">Course pages</p>
          {[['home', 'Instructor page'], ['student', 'Student page'], ['calendar', 'Course calendar']].map(([id, title]) => <button key={id} type="button" className="teach-section-link teach-page-link" aria-current={selected === id ? 'page' : undefined} onClick={() => navigate(id)}><TeachIcon name="book"/><span>{title}</span>{id === 'home' && dirty && <span className="teach-dirty" aria-label="Unsaved changes">●</span>}</button>)}
          {Boolean(course.reference?.pages.length) && <><p className="teach-nav-label teach-reference-label">Reference pages</p>{course.reference!.pages.map(item => <button key={item.id} type="button" className="teach-section-link teach-page-link" aria-current={selected === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><TeachIcon name="book"/><span>{item.title}</span></button>)}</>}
        </nav>
        <div className="teach-unavailable" data-unavailable><span>Course tools</span><div><button type="button" disabled title="Not available in this Storybook study">Copy previous term</button></div></div>
        <PanelResizeHandle width={sidebarWidth} defaultWidth={248} minWidth={190} maxWidth={360} collapseWidth={145} label="Resize course pages" onResize={setSidebarWidth} onCollapse={closeSidebar}/>
      </aside>}
      <section className="teach-main" aria-label="Course document">
        <header className="teach-context">
          {onBackToCourses && <button type="button" className="teach-back-courses" onClick={backToCourses}><TeachIcon name="back"/>Back to Courses</button>}
          <div className="teach-breadcrumb"><span>asTeach</span><span aria-hidden="true">/</span><span className="teach-course-context" title={`${course.code} · ${course.title}`}>{course.code} · {course.title}</span><span aria-hidden="true">/</span><strong>{sectionTitle}</strong></div>
          <span className="teach-reusable-context">{course.year} {course.season}</span>
        </header>
        {calendarSelected && <div className="teach-calendar-page" tabIndex={-1} aria-label="Course calendar" data-teach-area="T7"><TeachCourseCalendarStudy course={course} state={calendarState} onChange={onCalendarChange} onOpenSchedule={() => navigate('teaching-schedule')}/></div>}<div className={`teach-document-frame${studentSelected ? ' teach-student-page' : ''}`} hidden={calendarSelected} data-teach-area={studentSelected ? 'T8' : undefined}>
          <div className="teach-toolbar">
            {studentSelected ? <><div className="teach-modes" aria-label="Student page mode"><button type="button" aria-pressed={studentMode === 'preview'} onClick={() => setStudentMode('preview')}>Preview</button><button type="button" aria-pressed={studentMode === 'source'} disabled={!edition} onClick={() => setStudentMode('source')}>Source</button></div><button className="teach-primary-action" type="button" ref={reviewTrigger} onClick={() => setReviewSource(session.saved)}>{latestEdition ? 'Review update' : 'Review student copy'}</button></> : course.readOnly ? <><div className="teach-modes" aria-label="Reference mode"><button type="button" aria-pressed={referenceMode === 'preview'} onClick={() => setReferenceMode('preview')}>Preview</button><button type="button" aria-pressed={referenceMode === 'source'} onClick={() => setReferenceMode('source')}>Source</button><button type="button" aria-pressed={referenceMode === 'split'} onClick={() => setReferenceMode('split')}>Split</button></div><span>Read-only reference</span></> : <><div className="teach-modes" aria-label="Instructor page mode"><button type="button" aria-pressed={mode === 'preview'} onClick={() => switchMode('preview')}>Preview</button><button type="button" aria-pressed={mode === 'edit'} onClick={() => switchMode('edit')}>Edit</button><button type="button" aria-pressed={mode === 'split'} onClick={() => switchMode('split')}>Split</button></div><div className="teach-save-actions"><span>{dirty ? 'Unsaved changes' : 'Saved version'}</span><button type="button" disabled={!dirty} onClick={cancel}>Cancel</button><button type="button" className="teach-save" disabled={!dirty} onClick={() => save('home', editor.current?.state.doc.toString() ?? session.draft)}>Save</button></div></>}
          </div>
          {studentSelected && edition && <div className="teach-student-summary"><label>Student version <select aria-label="Student version" value={edition.number} onChange={event => {setStudentVersion(Number(event.currentTarget.value)); setActiveHeading(undefined);}}>{editions.map(item => <option key={item.number} value={item.number}>Version {item.number}{item.number === latestEdition?.number ? ' · Latest' : ''}</option>)}</select></label><span>Independent copy · Session only</span>{latestEdition?.instructorSource !== session.saved && <p>Saved Instructor content has changed. Review an update to include it.</p>}</div>}
          {studentSelected && !edition && <div className="teach-student-summary"><strong>Unreviewed preview</strong><span>No Student version yet · Saved Instructor text</span><p>Review this content and choose what to include before creating a Student version.{dirty && ' Unsaved Instructor changes are excluded.'}</p></div>}
          <div className="teach-document-body" data-split={split || undefined}>
          <div className="teach-editor-pane" hidden={!sourceVisible}>{split && <div className="teach-pane-label">{course.readOnly ? 'Read-only source' : 'Markdown source'}</div>}<TeachSourceEditor id={course.readOnly ? referencePage?.id ?? 'home' : 'home'} title={course.readOnly ? sectionTitle : 'Instructor page'} session={course.readOnly ? {saved: rawSource, draft: rawSource, reset: 0} : session} cache={cache} editor={editor} entries={entries} active={active && sourceVisible} readOnly={Boolean(course.readOnly)} onActiveHeading={setActiveHeading} onChange={updateDraft} onSave={save}/></div>
          <div className="teach-preview-pane" hidden={editing && !split}>
          {split && <div className="teach-pane-label teach-preview-label" title={`${sourcePath} · Synchronized scrolling${course.reference ? ` · Source ${course.reference.sourceCommit.slice(0, 12)}` : ''}`}><span className="teach-pane-title">{course.readOnly ? 'Read-only preview' : 'Live draft preview'}</span><span className="teach-pane-path">{sourcePath}</span></div>}
          <div className="teach-reading" ref={reading} hidden={editing && !split} tabIndex={0} aria-label={`${sectionTitle}${split && !course.readOnly ? ' draft' : ''} preview`} onScroll={trackReading} onClick={followPreviewLink}>
            <>
              {!split && <div className="teach-origin">{studentSelected ? (edition ? `Student version ${edition.number}` : 'Unreviewed preview · Saved Instructor text') : sourcePath}{!studentSelected && dirty && !split && <span>Preview uses saved text</span>}{course.reference && !studentSelected && <span>Source {course.reference.sourceCommit.slice(0, 12)}</span>}</div>}
              {course.readOnly && !sourceView && /<table\b/i.test(rawSource) && <p className="teach-reference-note">Original GitBook tables are shown as preserved source.</p>}
              {sourceView ? <><pre className="teach-reference-source" aria-label={studentSelected ? 'Student version source' : `${sectionTitle} original source`}><code>{rawSource}</code></pre>{instructorSelected && course.reference?.home.kind === 'composed' && <details className="teach-original-sources"><summary>Original reference files</summary><h3>{course.reference.home.path}</h3><pre aria-label="Original Instructor reference source"><code>{course.reference.home.source}</code></pre>{course.sections.map(section => <section key={section.id}><h3>{section.path}</h3><pre aria-label={`${section.title} original source`}><code>{section.source}</code></pre></section>)}</details>}</> : preview ? <article className="teach-markdown" dangerouslySetInnerHTML={{__html: preview}}/> : <article className="teach-markdown teach-empty-section"><h1>{sectionTitle}</h1><p>{studentSelected ? 'Save Instructor content to prepare a Student version.' : course.readOnly ? 'No content in the preserved source.' : 'Select Edit to begin writing.'}</p></article>}
            </>
          </div>
          </div>
          </div>
          {studentSelected && <div className="teach-student-outputs" data-unavailable><span>Student output</span>{['Export', 'GitHub', 'GitBook'].map(label => <button type="button" key={label} disabled title="Not available in this Storybook study">{label}</button>)}</div>}
        </div>
      </section>
      {outlineOpen && <aside className="teach-outline" style={{'--panel-resize-width': `${outlineWidth}px`} as React.CSSProperties}>
        <DocumentOutline entries={entries} headingsOnly activeId={activeHeading} documentName={sectionTitle} onSelect={selectHeading} onReturnToDocument={returnToDocument} headerAction={<button type="button" className="teach-icon" aria-label="Close asTeach outline" onClick={closeOutline}><TeachIcon name="close"/></button>}/>
        <PanelResizeHandle width={outlineWidth} defaultWidth={232} minWidth={180} maxWidth={360} collapseWidth={135} label="Resize asTeach outline" side="right" edge="start" onResize={setOutlineWidth} onCollapse={closeOutline}/>
      </aside>}
    </div>
    <footer className="teach-status"><span role="status">{notice}</span><span>{calendarSelected ? (course.readOnly ? 'Read-only course schedule' : 'Calendar · Session only') : studentSelected ? `${editions.length} Student version${editions.length === 1 ? '' : 's'} · Session only` : course.readOnly ? 'Read-only reference' : `${dirty ? 'Unsaved Instructor changes' : 'No unsaved changes'} · Session only`}</span></footer>
    {reviewSource !== null && active && <TeachStudentReviewDialog source={reviewSource} currentSource={session.saved} path={document.path} assets={assets} previous={latestEdition} hasDraft={dirty} reference={Boolean(course.readOnly)} returnFocusRef={reviewTrigger} onCancel={() => {setReviewSource(null); setNotice('Review cancelled. Instructor drafts and Student versions are unchanged.');}} onConfirm={value => {
      if (value.instructorSource !== session.saved) return;
      const next = {...value, number: editions.length + 1};
      setEditions(previous => [...previous, next]); setStudentVersion(next.number); setStudentMode('preview'); setReviewSource(null);
      setNotice(`Student version ${next.number} created in this session. The Instructor page is unchanged.`);
    }}/>}
  </div>;
}
