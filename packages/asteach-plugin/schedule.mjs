import {teachingAnchorError,teachingDateAt,teachingDays,teachingSessionOccurs,teachingWeekError} from './calendar.mjs';

// User-entered locations and closure notes remain literal table-cell text.
const cellText=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_[\]{}()!|~]/g,'\\$&').replace(/[\r\n]+/g,' ');
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const padded=value=>String(value).padStart(2,'0');
export function teachingScheduleError(calendar){
 if(!calendar.monday||teachingAnchorError(calendar.monday))return 'Set and save Week 1 Monday before generating the schedule.';
 if(teachingWeekError(1,calendar.totalWeeks))return 'Set and save the total number of weeks first.';
 if(!calendar.sessions.length)return 'Add a class session before generating the schedule.';
 return '';
}
export function teachingScheduleBundle(calendar,noClassDays=[],linkPrefix=null){
 const problem=teachingScheduleError(calendar);if(problem)throw Error(problem);
 const sessions=calendar.sessions.map((session,index)=>({...session,index,key:JSON.stringify([session.weekday,session.start,session.end,session.location.trim()])})).sort((a,b)=>a.weekday-b.weekday||a.start.localeCompare(b.start)||a.end.localeCompare(b.end)||a.location.localeCompare(b.location)||a.index-b.index);
 const columns=[...new Map(sessions.map(session=>[session.key,session])).values()];
 const closures=new Map(noClassDays.map(day=>[day.date,`No Class.${day.description.trim()?' '+day.description.trim():''}`]));
 const rows=[['Wk',...columns.map(s=>`${teachingDays[s.weekday].slice(0,3)} ${s.start.replace(':','')}-${s.end.replace(':','')}${s.location.trim()?` ${cellText(s.location.trim())}`:''}`),'Notes']];
 rows.push(rows[0].map(()=>'---'));
 let number=0;const pages=[];
 for(let week=1;week<=calendar.totalWeeks;week++){
  const cells=new Map(columns.map(column=>[column.key,[]]));
  for(const session of sessions){
   if(!teachingSessionOccurs(session,week,session.weekday))continue;
   const date=teachingDateAt(calendar.monday,week,session.weekday);
   const label=`${months[Number(date.slice(5,7))-1]} ${date.slice(8)}`;
   const classNumber=padded(++number),name=`Class${classNumber}.md`,content=closures.has(date)?cellText(closures.get(date)):'ClassContent';
   pages.push({name,date,start:session.start,end:session.end,location:session.location.trim(),text:`# Class ${classNumber}\n\n${label} · ${session.start}–${session.end}\n\n${content}\n`});
   const rendered=linkPrefix===null?content:`[${content}](${linkPrefix}${name})`;
   cells.get(session.key).push(`${label}: Class ${classNumber}<br>${rendered}`);
  }
  rows.push([padded(week),...columns.map(column=>cells.get(column.key).join('<br><br>')),'']);
 }
 return {markdown:rows.map(row=>`| ${row.join(' | ')} |`).join('\n')+'\n\n',pages};
}

export const generateTeachingSchedule=(calendar,noClassDays=[])=>teachingScheduleBundle(calendar,noClassDays).markdown;
