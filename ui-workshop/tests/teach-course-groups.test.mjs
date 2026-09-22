import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupTeachCourses,isTeachTermActive,selectCurrentTeachTerm,sortTeachTerms} from '../src/teach-course-groups.ts';

const term=(id,year,season='Autumn',code='DES5002')=>Object.freeze({id,year,season,code,title:'Course',repository:'Course_asTeach',description:'',sections:Object.freeze([])});
const localDate=(year,month,day,hour=12,minute=0)=>new Date(year,month-1,day,hour,minute);
const now=localDate(2026,9,21);

test('grouping preserves slash identities, original offering references, and input order',()=>{
  const first=term('old','2025','Autumn','ROB7103/8103'),second=term('current','2026','Autumn',' rob7103/8103 '),separate=term('underscore','2026','Autumn','ROB7103_8103');
  const courses=Object.freeze([first,separate,second]),groups=groupTeachCourses(courses);
  assert.deepEqual(groups,[{course:first,terms:[first,second]},{course:separate,terms:[separate]}]);
  assert.equal(groups[0].terms[1],second);
  assert.deepEqual(courses,[first,separate,second]);
});

test('an active known calendar wins over a newer future offering and shuffled input',()=>{
  const past=term('past','2022'),current=term('current','2026'),future=term('future','2027');
  const calendars=Object.freeze({current:Object.freeze({monday:'2026-09-07',totalWeeks:16}),future:Object.freeze({monday:'2027-09-06',totalWeeks:16})});
  for(const terms of [[past,current,future],[future,past,current],[current,future,past]]){
    assert.equal(selectCurrentTeachTerm(Object.freeze(terms),calendars,now),current);
  }
  assert.equal(isTeachTermActive(current,calendars,now),true);
  assert.equal(isTeachTermActive(future,calendars,now),false);
});

test('overlapping active terms prefer the latest start, then period and stable identity',()=>{
  const earlier=term('earlier','2027'),later=term('later','2026'),tie=term('a-tie','2026');
  const calendars={earlier:{monday:'2026-09-07',totalWeeks:16},later:{monday:'2026-09-14',totalWeeks:16},'a-tie':{monday:'2026-09-14',totalWeeks:16}};
  assert.equal(selectCurrentTeachTerm([earlier,later],calendars,now),later);
  assert.equal(selectCurrentTeachTerm([later,earlier,tie],calendars,now),tie);
  assert.equal(selectCurrentTeachTerm([tie,earlier,later],calendars,now),tie);
  const newer=term('newer','2027');
  assert.equal(selectCurrentTeachTerm([later,newer],{...calendars,newer:calendars.later},now),newer);
});

test('latest recorded period is the fallback for past, future, and undated offerings',()=>{
  const old=term('old','2022'),newer=term('newer','2025'),current=term('current','2026'),future=term('future','2027');
  assert.equal(selectCurrentTeachTerm([newer,old],{},now),newer);
  assert.equal(selectCurrentTeachTerm([old,current,newer],undefined,now),current);
  assert.equal(selectCurrentTeachTerm([future,current],{},now),future);
  assert.equal(selectCurrentTeachTerm([current,future],{},localDate(2028,1,1)),future);
  assert.equal(isTeachTermActive(current,{},now),false);
});

test('season ordering uses recorded Spring, Summer, Autumn, Winter without month inference',()=>{
  const spring=term('spring','2026','Spring'),summer=term('summer','2026','Summer'),autumn=term('autumn','2026','Autumn'),winter=term('winter','2026','Winter');
  const terms=Object.freeze([summer,winter,spring,autumn]);
  assert.deepEqual(sortTeachTerms(terms),[winter,autumn,summer,spring]);
  assert.deepEqual(terms,[summer,winter,spring,autumn]);
  assert.equal(selectCurrentTeachTerm(terms,{},localDate(2026,3,1)),winter);
});

test('missing or invalid dates cannot make a term current',()=>{
  const older=term('older','2025'),latest=term('latest','2026');
  for(const calendar of [undefined,{monday:'',totalWeeks:16},{monday:'2026-09-22',totalWeeks:16},{monday:'2026-02-30',totalWeeks:16},{monday:'2026-09-07',totalWeeks:0},{monday:'2026-09-07',totalWeeks:54},{monday:'2026-09-07',totalWeeks:1.5}]){
    assert.equal(isTeachTermActive(older,{older:calendar},now),false);
    assert.equal(selectCurrentTeachTerm([older,latest],{older:calendar},now),latest);
  }
});

test('calendar boundaries include the complete local Monday and final Sunday',()=>{
  const current=term('current','2026'),calendars={current:{monday:'2026-09-21',totalWeeks:1}};
  assert.equal(isTeachTermActive(current,calendars,localDate(2026,9,20,23,59)),false);
  assert.equal(isTeachTermActive(current,calendars,localDate(2026,9,21,0,0)),true);
  assert.equal(isTeachTermActive(current,calendars,localDate(2026,9,27,23,59)),true);
  assert.equal(isTeachTermActive(current,calendars,localDate(2026,9,28,0,0)),false);
});

test('active spans cross daylight-saving and year boundaries without a day shift',()=>{
  const current=term('current','2026');
  assert.equal(isTeachTermActive(current,{current:{monday:'2026-03-02',totalWeeks:2}},localDate(2026,3,15,23,59)),true);
  assert.equal(isTeachTermActive(current,{current:{monday:'2026-03-02',totalWeeks:2}},localDate(2026,3,16,0,0)),false);
  const calendars={current:{monday:'2026-12-28',totalWeeks:2}};
  assert.equal(isTeachTermActive(current,calendars,localDate(2027,1,10,23,59)),true);
  assert.equal(isTeachTermActive(current,calendars,localDate(2027,1,11,0,0)),false);
});

test('empty inputs and duplicate-period ties are deterministic and nonmutating',()=>{
  assert.equal(selectCurrentTeachTerm([],{},now),undefined);
  assert.deepEqual(sortTeachTerms([]),[]);
  const a=term('a','2026'),z=term('z','2026'),terms=Object.freeze([z,a]);
  assert.equal(selectCurrentTeachTerm(terms,{},now),a);
  assert.equal(selectCurrentTeachTerm([a,z],{},now),a);
  assert.deepEqual(sortTeachTerms(terms),[a,z]);
  assert.deepEqual(terms,[z,a]);
});
