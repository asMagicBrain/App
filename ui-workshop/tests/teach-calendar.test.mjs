import assert from 'node:assert/strict';
import {test} from 'node:test';
import {combinedTeachingMondays,currentTeachingSeason,parseTeachingDate,teachingAnchorError,teachingCompactDate,teachingCourseAnchorError,teachingDateAt,teachingISODate,teachingNoClassDayError,teachingPeriodKey,teachingSeasons,teachingSessionOccurs,teachingSessionsOverlap,teachingTimeError,teachingWeekAt,teachingWeekError,teachingYears} from '../src/teach-calendar.mjs';

test('week ranges accept only ordered inclusive integer weeks 1 through 53',()=>{
  for(const [from,to] of [[1,1],['1','53'],[8,16]])assert.equal(teachingWeekError(from,to),'');
  for(const [from,to] of [[0,1],[1,54],[1.5,3],[5,4],['',4],['1e1',12]])assert.notEqual(teachingWeekError(from,to),'');
});
test('civil dates stay on Monday through Sunday across DST, leap day, and year boundaries',()=>{
  assert.equal(teachingAnchorError(''),'');
  assert.equal(teachingAnchorError('2026-03-02'),'');
  assert.notEqual(teachingAnchorError('2026-03-03'),'');
  assert.equal(parseTeachingDate('2025-02-29'),null);
  assert.equal(parseTeachingDate('2026-04-31'),null);
  assert.equal(teachingDateAt('2026-03-02',2,0),'2026-03-09');
  assert.equal(teachingDateAt('2026-03-02',2,6),'2026-03-15');
  assert.equal(teachingDateAt('2024-02-26',1,3),'2024-02-29');
  assert.equal(teachingDateAt('2026-12-28',2,0),'2027-01-04');
  assert.equal(teachingDateAt('0001-01-01',1,0),'0001-01-01');
  assert.equal(teachingDateAt('9997-12-29',53,6),'9999-01-03');
  assert.notEqual(teachingAnchorError('9998-12-28'),'');
  assert.equal(teachingDateAt('',1,0),null);
  assert.equal(teachingDateAt('2026-03-03',1,0),null);
});
test('sessions use same-day times and inclusive recurrence endpoints',()=>{
  assert.equal(teachingTimeError('09:00','10:30'),'');
  for(const [start,end] of [['','10:00'],['24:00','25:00'],['10:00','10:00'],['23:00','01:00']])assert.notEqual(teachingTimeError(start,end),'');
  const session={weekday:2,weekFrom:2,weekTo:4};
  assert.equal(teachingSessionOccurs(session,1,2),false);
  assert.equal(teachingSessionOccurs(session,2,2),true);
  assert.equal(teachingSessionOccurs(session,4,2),true);
  assert.equal(teachingSessionOccurs(session,5,2),false);
  assert.equal(teachingSessionOccurs(session,2,1),false);
});
test('calendar periods group courses in the same year and term only',()=>{
  assert.equal(teachingPeriodKey({code:'DES101',year:'2026',season:'Autumn'}),teachingPeriodKey({code:'DES202',year:'2026',season:' Autumn '}));
  assert.notEqual(teachingPeriodKey({year:'2026',season:'Autumn'}),teachingPeriodKey({year:'2025',season:'Autumn'}));
  assert.notEqual(teachingPeriodKey({year:'2026',season:'Autumn'}),teachingPeriodKey({year:'2026',season:'Spring'}));
});
test('year and season choices are bounded and default season follows the current civil month',()=>{
  assert.equal(teachingYears.length,152);assert.equal(teachingYears[0],1949);assert.equal(teachingYears.at(-1),2100);
  assert.deepEqual(teachingSeasons,['Spring','Summer','Autumn','Winter']);
  for(const [month,season] of [[0,'Winter'],[2,'Spring'],[5,'Summer'],[8,'Autumn'],[11,'Winter']]) assert.equal(currentTeachingSeason(new Date(2026,month,15)),season);
});
test('compact dates round trip without locale ambiguity and reject impossible dates',()=>{
  assert.equal(teachingISODate('20260921'),'2026-09-21');assert.equal(teachingCompactDate('2026-09-21'),'20260921');
  assert.equal(teachingISODate(''),'');
  for(const value of ['21092026','20260229','20260431','2026-09-21','2026092'])assert.equal(teachingISODate(value),null);
  assert.equal(teachingCourseAnchorError('2026-09-21','2026'),'');
  assert.equal(teachingCourseAnchorError('2025-12-29','2026'),'');
  assert.notEqual(teachingCourseAnchorError('1949-01-03','2026'),'');
  assert.notEqual(teachingCourseAnchorError('2026-09-22','2026'),'');
});
test('combined calendars retain the full union of different course week ranges and quiet weeks',()=>{
  const dates=combinedTeachingMondays([{monday:'2026-09-07',totalWeeks:2},{monday:'2026-09-28',totalWeeks:3},{monday:'',totalWeeks:53}]);
  assert.deepEqual(dates,['2026-09-07','2026-09-14','2026-09-21','2026-09-28','2026-10-05','2026-10-12']);
  assert.equal(teachingWeekAt('2026-09-07','2026-09-28'),4);
  assert.equal(teachingWeekAt('2026-09-28','2026-09-28'),1);
  assert.equal(teachingWeekAt('2026-09-28','2026-09-21'),0);
  assert.deepEqual(combinedTeachingMondays([{monday:'',totalWeeks:14}]),[]);
  const overYear=combinedTeachingMondays([{monday:'2026-12-28',totalWeeks:3}]);
  assert.deepEqual(overYear,['2026-12-28','2027-01-04','2027-01-11']);
});
test('overlap requires shared weekday, shared teaching weeks and intersecting times',()=>{
  const lecture={weekday:0,weekFrom:1,weekTo:14,start:'09:00',end:'10:00'};
  assert.equal(teachingSessionsOverlap(lecture,{...lecture,start:'09:30',end:'10:30'}),true);
  for(const other of [{...lecture,start:'10:00',end:'11:00'},{...lecture,weekday:1},{...lecture,weekFrom:15,weekTo:20}])assert.equal(teachingSessionsOverlap(lecture,other),false);
});
test('no-class dates allow an empty description, reject duplicates, and allow editing the same date',()=>{
  const days=[{id:'closure',date:'2026-09-21',description:''}];
  assert.equal(teachingNoClassDayError('2026-09-22',days), '');
  assert.notEqual(teachingNoClassDayError('2026-09-21',days),'');
  assert.equal(teachingNoClassDayError('2026-09-21',days,'closure'),'');
  for(const date of ['','2026-02-29','1948-12-31','2101-01-01'])assert.notEqual(teachingNoClassDayError(date,days),'');
  assert.deepEqual(days,[{id:'closure',date:'2026-09-21',description:''}]);
});
