import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleArtifactFrame} from './artifact-frame.mjs';
function clocks(){let frame,timer;const cancelled=[];return{options:{requestFrame:fn=>{frame=fn;return 1;},cancelFrame:id=>cancelled.push(['frame',id]),setTimer:fn=>{timer=fn;return 2;},clearTimer:id=>cancelled.push(['timer',id])},frame:()=>frame(),timer:()=>timer(),cancelled};}
test('withheld native frames fall back once and a late frame cannot repeat the operation',()=>{const c=clocks();let calls=0;scheduleArtifactFrame(()=>calls++,c.options);c.timer();c.frame();assert.equal(calls,1);assert.deepEqual(c.cancelled,[['frame',1],['timer',2]]);});
test('normal frames settle before the fallback without duplicate geometry work',()=>{const c=clocks();let calls=0;scheduleArtifactFrame(()=>calls++,c.options);c.frame();c.timer();assert.equal(calls,1);});
test('unmounted views cancel both schedules and cannot request native geometry later',()=>{const c=clocks();let calls=0;const cancel=scheduleArtifactFrame(()=>calls++,c.options);cancel();c.frame();c.timer();assert.equal(calls,0);});
