export const teachingDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const teachingSeasons = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const teachingYears = Array.from({length:152}, (_, index) => 1949 + index);
export const currentTeachingSeason = (date = new Date()) => teachingSeasons[Math.floor(((date.getMonth() + 10) % 12) / 3)];

/** The visible text field is always YYYYMMDD; storage and native date pickers use ISO dates. */
export function teachingCompactDate(value) { return value.replaceAll('-', ''); }
export function teachingISODate(value) {
  if (!value) return '';
  if (!/^\d{8}$/.test(value)) return null;
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  return parseTeachingDate(iso) ? iso : null;
}

/** Calendar dates are civil dates. UTC arithmetic avoids daylight-saving and local-zone shifts. */
export function parseTeachingDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || year > 9997 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function teachingWeekError(from, to) {
  if (![from, to].every(value => /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 53)) return 'Enter whole week numbers from 1 to 53.';
  if (Number(from) > Number(to)) return 'From week must be no later than To week.';
  return '';
}

export function teachingAnchorError(value) {
  if (!value) return '';
  const date = parseTeachingDate(value);
  if (!date) return 'Enter a valid date with a year from 0001 to 9997.';
  return date.getUTCDay() === 1 ? '' : 'Week 1 must start on a Monday.';
}

export function teachingDateAt(monday, week, weekday) {
  const date = parseTeachingDate(monday);
  if (!date || teachingAnchorError(monday) || !Number.isInteger(week) || week < 1 || week > 53 || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + weekday);
  return date.toISOString().slice(0, 10);
}

export function teachingTimeError(start, end) {
  const valid = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!valid(start) || !valid(end)) return 'Enter a start time and an end time.';
  return end > start ? '' : 'End time must be later than start time on the same day.';
}

export function teachingSessionOccurs(session, week, weekday) {
  return session.weekday === weekday && week >= session.weekFrom && week <= session.weekTo;
}

export function teachingPeriodKey(course) {
  return `${course.year}|${course.season.trim().toLowerCase()}`;
}

export function teachingWeekAt(monday, iso) {
  const start = parseTeachingDate(monday), day = parseTeachingDate(iso);
  if (!start || !day || teachingAnchorError(monday)) return null;
  return Math.floor((day.getTime() - start.getTime()) / 604800000) + 1;
}

/** Every week is included, including quiet weeks and different course start dates. */
export function combinedTeachingMondays(calendars) {
  const dated = calendars.filter(item => item.monday && !teachingAnchorError(item.monday) && !teachingWeekError(1,item.totalWeeks));
  if (!dated.length) return [];
  const first = dated.map(item=>item.monday).sort()[0];
  const last = dated.map(item=>teachingDateAt(item.monday,item.totalWeeks,0)).sort().at(-1);
  const result = [], date = parseTeachingDate(first);
  while (date.toISOString().slice(0,10) <= last) {
    result.push(date.toISOString().slice(0,10));
    date.setUTCDate(date.getUTCDate()+7);
  }
  return result;
}

export function teachingSessionsOverlap(a,b) {
  return a.weekday===b.weekday && a.weekFrom<=b.weekTo && b.weekFrom<=a.weekTo && a.start<b.end && b.start<a.end;
}

export function teachingNoClassDayError(date, days, editingId) {
  if (!parseTeachingDate(date) || Number(date.slice(0,4))<1949 || Number(date.slice(0,4))>2100) return 'Enter a valid date from 1949 to 2100 in YYYYMMDD format.';
  return days.some(item=>item.date===date && item.id!==editingId) ? 'This date is already marked as a no-class day. Edit the existing day instead.' : '';
}

export function teachingCourseAnchorError(monday, year) {
  const problem = teachingAnchorError(monday);
  if (problem || !monday) return problem;
  const anchorYear = Number(monday.slice(0,4));
  if (anchorYear<1949 || anchorYear>2100) return 'Choose a date from 1949 to 2100.';
  return Math.abs(anchorYear-Number(year))>1 ? `Choose a Monday in ${Number(year)-1}, ${year} or ${Number(year)+1} for this course term.` : '';
}
