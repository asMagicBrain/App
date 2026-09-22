import type {TeachStudyCourse} from './teach-plugin-fixture';
import {teachingDateAt,teachingSeasons} from './teach-calendar.mjs';

export const teachCourseKey = (code:string) => code.trim().toLowerCase();
export const teachTermLabel = (term:TeachStudyCourse) => `${term.year} ${term.season}`;
export type TeachCourseGroup = {course:TeachStudyCourse;terms:TeachStudyCourse[]};
export type TeachTermCalendars = Readonly<Record<string,{monday:string;totalWeeks:number}|undefined>>;

const compareText = (a:string,b:string) => a<b?-1:a>b?1:0;
const termYear = (term:TeachStudyCourse) => /^\d{4}$/.test(term.year)?Number(term.year):-1;
const termSeason = (term:TeachStudyCourse) => teachingSeasons.findIndex((season:string)=>season.toLowerCase()===term.season.trim().toLowerCase());
const compareTerms = (a:TeachStudyCourse,b:TeachStudyCourse) => termYear(b)-termYear(a)||termSeason(b)-termSeason(a)||compareText(a.id,b.id);

/** Newest recorded period first, with a stable identity tie-break and no input mutation. */
export function sortTeachTerms(terms:readonly TeachStudyCourse[]):TeachStudyCourse[] {
  return [...terms].sort(compareTerms);
}

function activeTermStart(term:TeachStudyCourse,calendars:TeachTermCalendars,now:Date):string|undefined {
  const calendar=calendars[term.id];
  if(!calendar||!Number.isFinite(now.getTime()))return undefined;
  const end=teachingDateAt(calendar.monday,calendar.totalWeeks,6);
  // Read today's local civil date; toISOString() would shift the day in some zones.
  const today=`${String(now.getFullYear()).padStart(4,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return end&&calendar.monday<=today&&today<=end?calendar.monday:undefined;
}

export function isTeachTermActive(term:TeachStudyCourse,calendars:TeachTermCalendars={},now:Date=new Date()):boolean {
  return activeTermStart(term,calendars,now)!==undefined;
}

/** Prefer an active dated term; otherwise use the latest recorded year/season. */
export function selectCurrentTeachTerm(terms:readonly TeachStudyCourse[],calendars:TeachTermCalendars={},now:Date=new Date()):TeachStudyCourse|undefined {
  let latest:TeachStudyCourse|undefined,active:TeachStudyCourse|undefined,activeStart='';
  for(const term of terms){
    if(!latest||compareTerms(term,latest)<0)latest=term;
    const start=activeTermStart(term,calendars,now);
    if(start&&(!active||start>activeStart||(start===activeStart&&compareTerms(term,active)<0))){active=term;activeStart=start;}
  }
  return active??latest;
}

/** Group presentation only; each offering keeps its original session identity. */
export function groupTeachCourses(courses:readonly TeachStudyCourse[]):TeachCourseGroup[] {
  const groups=new Map<string,TeachCourseGroup>();
  for(const course of courses){
    const key=teachCourseKey(course.code);
    const group=groups.get(key);
    if(group)group.terms.push(course);
    else groups.set(key,{course,terms:[course]});
  }
  return [...groups.values()];
}
