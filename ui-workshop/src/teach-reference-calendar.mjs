import {parseTeachingDate, teachingTimeError} from './teach-calendar.mjs';

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const namedIndex = (names, value) => names.findIndex(name => name.toLowerCase() === value.toLowerCase() || name.slice(0, 3).toLowerCase() === value.toLowerCase());

/** Link destinations are discarded, never fetched or interpreted as HTML. */
function linkLabels(value) {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '[') {
      const labelEnd = value.indexOf('](', index + 1);
      if (labelEnd !== -1) {
        let depth = 1, end = labelEnd + 2;
        for (; end < value.length && depth; end++) {
          if (value[end] === '\\') end++;
          else if (value[end] === '(') depth++;
          else if (value[end] === ')') depth--;
        }
        if (!depth) {
          result += value.slice(index + 1, labelEnd);
          index = end - 1;
          continue;
        }
      }
      // A malformed link stays literal; do not repeatedly rescan its remainder.
      return result + value.slice(index);
    }
    result += value[index];
  }
  return result;
}

function readable(value) {
  return linkLabels(value).replace(/\*\*|__|~~/g, '').replace(/(^|\s)[*_]|[*_](?=\s|$)/g, '$1').trim();
}

function unresolved(reason) {
  return {date: '', start: '', end: '', problem: reason};
}

/** Deliberately limited to the pinned schedule's explicit weekday/month/day notation. */
function recordedDate(value, year) {
  const text = readable(value).replace(/^(?:change(?:d)?\s+to|rescheduled?\s+to)\s+/i, '');
  if (/^(?:(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?),?\s+)?(?:date(?:\s+and\s+time)?\s+)?TBC$/i.test(text)) return unresolved('Date not confirmed in source.');
  const match = /^([A-Za-z]+),?\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4})(?=,|\s|$))?(.*)$/.exec(text);
  if (!match) return unresolved('Schedule format not supported.');
  const [, weekday, month, day, explicitYear, tail] = match;
  const monthIndex = namedIndex(monthNames, month), dayIndex = namedIndex(dayNames, weekday);
  if (!/^\d{4}$/.test(String(year)) || Number(year) < 1949 || Number(year) > 2100 || (explicitYear && explicitYear !== String(year))) return unresolved('Schedule year does not match the course year.');
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = parseTeachingDate(iso);
  if (monthIndex < 0 || dayIndex < 0 || !date) return unresolved('Invalid calendar date or weekday.');
  if (date.getUTCDay() !== dayIndex) return unresolved('Weekday does not match the calendar date.');
  const timeText = tail.trim().replace(/^,\s*/, '').replace(/\s*\(make[- ]up class\)\s*$/i, '').trim();
  if (!timeText || /^time\s+TBC$/i.test(timeText)) return {date: iso, start: '', end: '', problem: ''};
  const times = /^(\d{2}):?(\d{2})\s*[–—-]\s*(\d{2}):?(\d{2})$/.exec(timeText);
  if (!times) return unresolved('Class time format not supported.');
  const start = `${times[1]}:${times[2]}`, end = `${times[3]}:${times[4]}`;
  if (teachingTimeError(start, end)) return unresolved('Invalid class time range.');
  return {date: iso, start, end, problem: ''};
}

function parseClass(line, sourceLine, course) {
  const labels = linkLabels(line), divider = labels.indexOf('|');
  const title = readable(divider < 0 ? labels : labels.slice(0, divider));
  if (!/^Class\s*\d+\b/i.test(title)) return null;
  const suffix = divider < 0 ? '' : labels.slice(divider + 1).trim();
  const whollyStruck = /^\s*~~.*~~\s*$/.test(labels);
  const strikeRemoved = suffix.replace(/~~[^~]*~~/g, '');
  const changedStrike = strikeRemoved !== suffix && Boolean(readable(strikeRemoved));
  const struckOnly = strikeRemoved !== suffix && !readable(strikeRemoved);
  const activeSuffix = whollyStruck || struckOnly ? suffix : strikeRemoved;
  const parsed = recordedDate(activeSuffix, course.year);
  const cancelled = whollyStruck || struckOnly || /\bcancelled\b|\bcanceled\b/i.test(`${title} ${readable(suffix)}`);
  const moved = changedStrike || /\bchange(?:d)?\s+to\b|\brescheduled?\b|\bmake[- ]up\s+class\b/i.test(readable(suffix));
  const status = parsed.problem ? 'unconfirmed' : cancelled ? 'cancelled' : moved ? 'rescheduled' : 'scheduled';
  return {
    id: `${course.id}-recorded-${sourceLine}`,
    title,
    date: parsed.date,
    start: parsed.start,
    end: parsed.end,
    status,
    notes: [readable(suffix), parsed.problem ? `Unresolved: ${parsed.problem}` : ''].filter(Boolean).join('\n'),
    sourceLine,
  };
}

function scheduleClasses(source, course) {
  const classes = [];
  let lastClass = null, fence = '';
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      lastClass = null;
      continue;
    }
    if (fence) continue;
    const entry = parseClass(line, index + 1, course);
    if (entry) {
      classes.push(entry);
      lastClass = entry;
    } else if (lastClass && /^\s*[-*+]\s+/.test(line)) {
      lastClass.notes += `\n${readable(line.replace(/^\s*[-*+]\s+/, ''))}`;
    } else if (line.trim()) lastClass = null;
  }
  return classes;
}

function calendarSpan(classes) {
  const dates = classes.map(entry => entry.date).filter(Boolean).sort();
  if (!dates.length) return {monday: '', totalWeeks: 0};
  const monday = parseTeachingDate(dates[0]);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return {monday: monday.toISOString().slice(0, 10), totalWeeks: Math.floor((parseTeachingDate(dates.at(-1)).getTime() - monday.getTime()) / 604800000) + 1};
}

/**
 * A read-only view of admitted DES5002 reference sections, not an import feature.
 * Source remains immutable; original line numbers refer to the section excerpt.
 * Recorded cancellations belong to their class and never become global closures.
 */
export function referenceTeachCalendarState(courses) {
  const entries = [];
  if (!Array.isArray(courses) || courses.length > 20) return {terms: {}, noClassDays: []};
  for (const course of courses) {
    if (!course || course.code !== 'DES5002' || course.readOnly !== true || !course.reference || typeof course.id !== 'string' || course.id.length > 80 || !Array.isArray(course.sections) || course.sections.length > 100) continue;
    const sections = course.sections.filter(section => section?.id === 'teaching-schedule');
    if (sections.length !== 1) continue;
    const section = sections[0];
    if (typeof section.source !== 'string' || section.source.length > 512 * 1024 || typeof section.path !== 'string' || typeof course.reference.sourceCommit !== 'string') continue;
    const recordedClasses = scheduleClasses(section.source, course);
    entries.push([course.id, {...calendarSpan(recordedClasses), sessions: [], recordedClasses, sourcePath: section.path, sourceCommit: course.reference.sourceCommit}]);
  }
  return {terms: Object.fromEntries(entries), noClassDays: []};
}
