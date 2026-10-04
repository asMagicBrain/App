import test from 'node:test';import assert from 'node:assert/strict';
import {artifactImage} from './artifact-image.mjs';
test('bounded JPEG header inspection distinguishes format, dimensions and malformed segments',()=>{
 const jpeg=Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,0,20,0,30,1,1,17,0,255,217]);
 assert.deepEqual(artifactImage(jpeg),{mime:'image/jpeg',width:30,height:20});
 for(const bytes of [Buffer.alloc(0),Buffer.from('<script>'),jpeg.subarray(0,12),Buffer.from([255,216,255,224,255,255])])assert.equal(artifactImage(bytes),null);
});
