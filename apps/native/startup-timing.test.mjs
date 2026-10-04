import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStartupTiming} from './startup-timing.mjs';
test('startup diagnostics are opt-in, bounded labels, and emitted once', () => {
  const lines = [];
  createStartupTiming({emit: line => lines.push(line)})('main-entered');
  assert.equal(lines.length, 0);
  const mark = createStartupTiming({enabled: true, elapsed: () => 123.456, emit: line => lines.push(line)});
  mark('main-entered'); mark('main-entered');
  assert.deepEqual(lines, ['ASMB_STARTUP {"stage":"main-entered","elapsedMs":123.46}']);
  assert.throws(() => mark('/private/course'), /Invalid/);
});
