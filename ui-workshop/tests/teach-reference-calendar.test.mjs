import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {referenceTeachCalendarState} from '../src/teach-reference-calendar.mjs';

const course = (source, overrides = {}) => ({
  id: 'des5002-synthetic-reference', code: 'DES5002', year: '2026', readOnly: true,
  reference: {sourceCommit: 'synthetic-pinned-commit'},
  sections: [{id: 'teaching-schedule', path: 'synthetic/schedule.md', source}],
  ...overrides,
});
const calendar = (source, overrides) => referenceTeachCalendarState([course(source, overrides)]).terms['des5002-synthetic-reference'];

test('only an explicit read-only DES5002 reference schedule supplies recorded classes', () => {
  const source = '**Class 01: Seminar |** Wed Sep 09, 1400–1550';
  for (const overrides of [{readOnly: false}, {reference: undefined}, {code: 'DES101'}, {sections: [{id: 'important-deadlines', source}]}, {sections: []}]) {
    assert.deepEqual(referenceTeachCalendarState([course(source, overrides)]), {terms: {}, noClassDays: []});
  }
  assert.deepEqual(referenceTeachCalendarState(null), {terms: {}, noClassDays: []});
  assert.deepEqual(referenceTeachCalendarState(Array.from({length: 21}, () => course(source))), {terms: {}, noClassDays: []});
  const duplicate = course(source);
  duplicate.sections.push({...duplicate.sections[0]});
  assert.deepEqual(referenceTeachCalendarState([duplicate]), {terms: {}, noClassDays: []});
  assert.equal(calendar('x'.repeat(512 * 1024 + 1)), undefined);
});

test('both link/bold layouts and ClassNN titles produce plain labels and explicit civil dates', () => {
  const source = [
    '## Teaching Schedule', '',
    '**[Class 01: Seminar](https://example.invalid/lecture(test).pdf)** **|** Wed Sep 09, 1400–1550', '',
    '[**Class02: Lab**](javascript:alert(1)) **|** Fri Sep 11, 09:05-10:45', '',
    '**Class03** |** Wed Sep 16, 2026, 0800—0950',
  ].join('\n');
  const result = calendar(source);
  assert.deepEqual(result.recordedClasses.map(({title, date, start, end, status, sourceLine}) => ({title, date, start, end, status, sourceLine})), [
    {title: 'Class 01: Seminar', date: '2026-09-09', start: '14:00', end: '15:50', status: 'scheduled', sourceLine: 3},
    {title: 'Class02: Lab', date: '2026-09-11', start: '09:05', end: '10:45', status: 'scheduled', sourceLine: 5},
    {title: 'Class03', date: '2026-09-16', start: '08:00', end: '09:50', status: 'scheduled', sourceLine: 7},
  ]);
  assert.equal(result.monday, '2026-09-07');
  assert.equal(result.totalWeeks, 2);
  assert.deepEqual(result.sessions, []);
  assert.equal(result.sourcePath, 'synthetic/schedule.md');
  assert.equal(result.sourceCommit, 'synthetic-pinned-commit');
  assert.ok(!JSON.stringify(result).includes('javascript:'));
  assert.ok(!JSON.stringify(result).includes('https://'));
});

test('TBC dates stay unplaced, while explicitly moved dates with unknown times remain visible', () => {
  const result = calendar([
    '**Class 01: Studio |** **Change to Sun, date and time TBC**',
    '* _Team formation_', '* _Assignment submission_', '',
    '**Class 02: Lab |** **Change to Sat Oct 10, time TBC**',
    '**Class 03: Review |** Fri Oct 09, 1400–1550',
  ].join('\n'));
  assert.deepEqual(result.recordedClasses.map(({date, start, end, status}) => ({date, start, end, status})), [
    {date: '', start: '', end: '', status: 'unconfirmed'},
    {date: '2026-10-10', start: '', end: '', status: 'rescheduled'},
    {date: '2026-10-09', start: '14:00', end: '15:50', status: 'scheduled'},
  ]);
  assert.match(result.recordedClasses[0].notes, /^Change to Sun, date and time TBC\n/);
  assert.match(result.recordedClasses[0].notes, /Team formation\nAssignment submission$/);
  assert.equal(result.recordedClasses[1].notes, 'Change to Sat Oct 10, time TBC');
  assert.equal(result.monday, '2026-10-05');
  assert.equal(result.totalWeeks, 1);
});

test('cancellations and struck original dates stay local, and explicit make-up days use their actual date', () => {
  const source = [
    '~~**Class 01: Canceled: Holiday |** Fri Oct 02~~',
    '**Class 02: Cancelled: Weather |** Fri Oct 09, 1400–1550',
    '**Class 03: Lab |** ~~Fri Oct 09, 1400–1550~~ **Change to Sat Oct 10, 1000–1150**',
    '**Class 04: Workshop |** **Sat Oct 17, 1400–1550 (make-up class)**',
    '**Class 05: Cancelled |** ~~Fri Oct 23, 1400–1550~~',
  ].join('\n');
  const state = referenceTeachCalendarState([course(source)]), result = state.terms['des5002-synthetic-reference'];
  assert.deepEqual(state.noClassDays, []);
  assert.deepEqual(result.recordedClasses.map(({date, status}) => [date, status]), [
    ['2026-10-02', 'cancelled'], ['2026-10-09', 'cancelled'], ['2026-10-10', 'rescheduled'], ['2026-10-17', 'rescheduled'], ['2026-10-23', 'cancelled'],
  ]);
  assert.equal(result.recordedClasses[2].start, '10:00');
  assert.equal(result.recordedClasses[2].notes, 'Fri Oct 09, 1400–1550 Change to Sat Oct 10, 1000–1150');
});

test('invalid dates, mismatching weekdays/years and unsupported times remain explicitly unresolved', () => {
  const suffixes = [
    'Mon Feb 29, 1400–1550', 'Tue Apr 31, 1400–1550', 'Wed Unknown 09, 1400–1550',
    'Thursday Sep 09, 1400–1550', 'Wed Sep 09, 2025, 1400–1550', 'Wed Sep 09, 2500–2600',
    'Wed Sep 09, 1550–1400', 'Wed Sep 09, 09:99–10:50', 'Sep 09, 1400–1550',
    'Wed Sep 09 or Fri Sep 11, 1400–1550', 'Wed Sep 09, 2pm–4pm',
  ];
  for (const suffix of suffixes) {
    const result = calendar(`**Class01: Review |** ${suffix}`);
    assert.deepEqual(result.recordedClasses.map(({date, start, end, status}) => ({date, start, end, status})), [{date: '', start: '', end: '', status: 'unconfirmed'}], suffix);
    assert.match(result.recordedClasses[0].notes, /Unresolved:/, suffix);
    assert.equal(result.monday, '', suffix);
    assert.equal(result.totalWeeks, 0, suffix);
  }
  for (const year of ['2026x', '1948', '2101']) assert.equal(calendar('**Class01 |** Wed Sep 09', {year}).recordedClasses[0].date, '');
  assert.equal(calendar('**Class01 |** Thursday February 29, 2024, 1400–1550', {year: '2024'}).recordedClasses[0].date, '2024-02-29');
});

test('missing times are retained without defaults and the calendar includes quiet weeks', () => {
  const result = calendar('**Class01 |** Tue Sep 06\n\n**Class02 |** Tue Oct 11\n\n**Class03 |** Tue Dec 27', {year: '2022'});
  assert.equal(result.monday, '2022-09-05');
  assert.equal(result.totalWeeks, 17);
  for (const entry of result.recordedClasses) {
    assert.equal(entry.start, '');
    assert.equal(entry.end, '');
    assert.equal(entry.status, 'scheduled');
  }
});

test('class order, deterministic IDs and source bytes survive derivation; fenced examples and deadline dates are ignored', () => {
  const source = [
    '```markdown', '**Class99 |** Tue Sep 01, 1400–1550', '```', '',
    '**Class01 |** Fri Sep 11, 1400–1550', '* _Submission: Mon Sep 14, 2330._', '',
    '**Class02 |** Wed Sep 09, 1400–1550', '',
    '## Important Deadlines', '* Final deadline: Sat Dec 12.',
  ].join('\r\n');
  const input = [course(source)], bytes = JSON.stringify(input);
  Object.freeze(input[0].sections[0]);Object.freeze(input[0].sections);Object.freeze(input[0]);Object.freeze(input);
  const a = referenceTeachCalendarState(input), b = referenceTeachCalendarState(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), bytes);
  const result = a.terms[input[0].id];
  assert.deepEqual(result.recordedClasses.map(entry => [entry.date, entry.sourceLine]), [['2026-09-11', 5], ['2026-09-09', 8]]);
  assert.notEqual(result.recordedClasses[0].id, result.recordedClasses[1].id);
  assert.equal(result.recordedClasses[0].notes, 'Fri Sep 11, 1400–1550\nSubmission: Mon Sep 14, 2330.');
  assert.ok(!result.recordedClasses[1].notes.includes('deadline'));
  assert.equal(result.totalWeeks, 1);
});

test('all classes can remain unresolved without inventing a term anchor', () => {
  const result = calendar('**Class01: Seminar |** TBC\n\n**Class02: Workshop**');
  assert.equal(result.recordedClasses.length, 2);
  assert.ok(result.recordedClasses.every(entry => entry.status === 'unconfirmed' && entry.date === ''));
  assert.deepEqual({monday: result.monday, totalWeeks: result.totalWeeks}, {monday: '', totalWeeks: 0});
});

test('the configured private reference has four faithful independent recorded schedules', {skip: !process.env.ASMB_TEACH_REFERENCE_ROOT}, async () => {
  const fixturePath = path.join(process.env.ASMB_TEACH_REFERENCE_ROOT, 'fixture.json');
  const before = await readFile(fixturePath), fixture = JSON.parse(before.toString('utf8'));
  const input = JSON.stringify(fixture), state = referenceTeachCalendarState(fixture.courses);
  const expectations = [
    ['2026', '2026-09-07', 16, 24, 2, 1, 1],
    ['2025', '2025-09-08', 16, 23, 1, 1, 0],
    ['2024', '2024-02-19', 16, 24, 1, 1, 0],
    ['2022', '2022-09-05', 17, 24, 1, 0, 0],
  ];
  assert.equal(Object.keys(state.terms).length, 4);
  assert.deepEqual(state.noClassDays, []);
  for (const [year, monday, totalWeeks, count, cancelled, rescheduled, unconfirmed] of expectations) {
    const offering = fixture.courses.find(item => item.year === year), result = state.terms[offering.id];
    assert.equal(result.monday, monday);
    assert.equal(result.totalWeeks, totalWeeks);
    assert.equal(result.recordedClasses.length, count);
    assert.equal(result.recordedClasses.filter(entry => entry.status === 'cancelled').length, cancelled);
    assert.equal(result.recordedClasses.filter(entry => entry.status === 'rescheduled').length, rescheduled);
    assert.equal(result.recordedClasses.filter(entry => entry.status === 'unconfirmed').length, unconfirmed);
    assert.deepEqual(result.sessions, []);
    assert.equal(result.sourceCommit, offering.reference.sourceCommit);
    assert.equal(result.sourcePath, offering.sections.find(section => section.id === 'teaching-schedule').path);
    if (year === '2022') assert.ok(result.recordedClasses.every(entry => entry.start === '' && entry.end === ''));
  }
  const current = state.terms[fixture.courses.find(item => item.year === '2026').id];
  assert.equal(current.recordedClasses[4].date, '');
  assert.equal(current.recordedClasses[6].date, '2026-10-10');
  assert.equal(current.recordedClasses[6].start, '');
  assert.equal(current.recordedClasses[7].date, '2026-10-09');
  assert.equal(JSON.stringify(fixture), input);
  assert.deepEqual(await readFile(fixturePath), before);
});
