import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createNodeFilesystem} from '../../source-foundation/src/adapters/node-filesystem.mjs';
import {prepareFileTransaction} from '../../source-foundation/src/operations/requests.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('async fixed-worker binary writes, deletes, replay and locking keep event loop available',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-async-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),recovery=path.join(root,'recovery');fs.mkdirSync(source);fs.mkdirSync(recovery);fs.writeFileSync(path.join(source,'old.md'),'old');
 const options={repositoryRoot:source,recoveryRoot:recovery,spaceRoot:'.',spaceId:randomUUID()},adapter=createNodeFilesystem(options),bytes=Buffer.alloc(2*1024*1024,71);
 const plan=prepareFileTransaction({schemaVersion:3,requestId:randomUUID(),target:{kind:'source',spaceId:options.spaceId},expected:{files:[{path:'image.png',hash:null},{path:'old.md',hash:hash('old')}]},input:{directories:[],assets:[],files:[{path:'image.png',bytes},{path:'old.md',bytes:null}]}});
 let ticks=0;const timer=setInterval(()=>ticks++,1);const pending=adapter.applyAsync(plan);assert.throws(()=>adapter.inspectMany(['old.md']).length&&adapter.apply(plan),{code:'BUSY'});
 const result=await pending;clearInterval(timer);assert.equal(result.status,'completed');assert.ok(ticks>0);assert.deepEqual(fs.readFileSync(path.join(source,'image.png')),bytes);assert.equal(fs.existsSync(path.join(source,'old.md')),false);
 assert.equal((await createNodeFilesystem(options).applyAsync(plan)).replay,true);
});
