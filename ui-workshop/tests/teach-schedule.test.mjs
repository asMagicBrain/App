import test from 'node:test';
import assert from 'node:assert/strict';
import {generateTeachingSchedule} from '../src/teach-schedule.mjs';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
const session=(weekday,start,end,location,rest={})=>({weekday,start,end,location,weekFrom:1,weekTo:2,...rest});
const calendar={monday:'2026-10-19',totalWeeks:2,sessions:[session(4,'09:00','10:50','L12'),session(1,'09:00','10:20','CR6'),session(2,'10:30','11:50','CR6')]};
test('chronological columns and class numbers include no-class dates',()=>{
 const result=generateTeachingSchedule(calendar,[{date:'2026-10-21',description:'Holiday'}]);
 assert.match(result,/\| Wk \| Tue 0900-1020 CR6 \| Wed 1030-1150 CR6 \| Fri 0900-1050 L12 \| Notes \|/);
 assert.match(result,/\| 01 \| Oct 20: Class 01<br>ClassContent \| Oct 21: Class 02<br>No Class\. Holiday \| Oct 23: Class 03<br>ClassContent \|  \|/);
 assert.match(result,/\| 02 \| Oct 27: Class 04<br>ClassContent/);
 assert.equal((renderSourcePreview(result).html.match(/<br>/g)||[]).length,6);
});
test('full term, empty weeks, grouped slots and year rollover',()=>{
 const result=generateTeachingSchedule({monday:'2026-12-28',totalWeeks:3,sessions:[session(4,'09:00','10:00','R',{weekFrom:1,weekTo:1}),session(4,'09:00','10:00','R',{weekFrom:3,weekTo:3})]});
 assert.match(result,/Jan 01: Class 01/);assert.match(result,/\| 02 \|  \|  \|/);assert.match(result,/Jan 15: Class 02/);assert.equal(result.split('\n')[0],'| Wk | Fri 0900-1000 R | Notes |');
});
test('literal notes and rooms cannot change table structure or execute HTML',()=>{
 const result=generateTeachingSchedule({...calendar,sessions:[session(1,'09:00','10:00','R|X')]},[{date:'2026-10-20',description:'<img src=x onerror=alert(1)> | **off**\nnext'}]);
 const html=renderSourcePreview(result).html;assert.doesNotMatch(html,/<img|<strong>/);assert.equal((html.match(/<td>/g)||[]).length,6);assert.match(html,/&lt;img/);
});
test('requires saved date and sessions',()=>{
 assert.throws(()=>generateTeachingSchedule({...calendar,monday:''}),/Monday/);assert.throws(()=>generateTeachingSchedule({...calendar,sessions:[]}),/class session/);
});
test('only unescaped attribute-free br inside table cells is rendered',()=>{
 const html=renderSourcePreview('| A |\n| --- |\n| one<br>two<BR />three<br class="x">four |\n\nOutside<br>text').html;
 assert.equal((html.match(/<br>/g)||[]).length,2);assert.match(html,/&lt;br class=/);assert.match(html,/Outside&lt;br&gt;text/);
 for(const cell of ['`<br>`','\\<br>','&lt;br&gt;'])assert.doesNotMatch(renderSourcePreview('| A |\n| --- |\n| '+cell+' |').html,/<br>/);
});
