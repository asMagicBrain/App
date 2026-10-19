import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactNativeKeyCode} from './pro-editor-probe.mjs';
test('native selection uses Mac physical keys while retaining Windows DOM virtual codes',()=>{assert.equal(artifactNativeKeyCode('ArrowDown',40,'darwin'),125);assert.equal(artifactNativeKeyCode('Home',36,'darwin'),115);assert.equal(artifactNativeKeyCode('Enter',13,'darwin'),36);assert.equal(artifactNativeKeyCode('ArrowDown',40,'linux'),40);assert.equal(artifactNativeKeyCode('Home',36,'win32'),36);});
