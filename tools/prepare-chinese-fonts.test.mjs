import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isPublicSourcePath} from './public-source-policy.mjs';
import {selectedFontMembers,checkChineseFonts,streamPinnedArchive} from './prepare-chinese-fonts.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function zip(name,bytes){const n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(0,8);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(n.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(n.length,28);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+bytes.length,16);return Buffer.concat([local,n,bytes,central,n,end]);}
test('pinned archive yields only the exact unmodified required font',async()=>{const expected=await fs.readFile(new URL('../apps/desktop/ui/fonts/MiSans-Regular.woff2',import.meta.url));const bytes=zip('official/Regular.woff2',expected),archive={bytes:bytes.length,sha256:hash(bytes),members:{'MiSans-Regular.woff2':'official/Regular.woff2'}};assert.deepEqual(selectedFontMembers(bytes,archive).get('MiSans-Regular.woff2'),expected);assert.throws(()=>selectedFontMembers(Buffer.concat([bytes,Buffer.from('changed')]),archive),/provenance/);assert.throws(()=>selectedFontMembers(bytes,{...archive,members:{'MiSans-Regular.woff2':'missing'}}),/Missing/);});
test('a correctly hashed archive cannot replace the pinned font bytes',()=>{const bytes=zip('font',Buffer.from('wrong font'));assert.throws(()=>selectedFontMembers(bytes,{bytes:bytes.length,sha256:hash(bytes),members:{'MiSans-Regular.woff2':'font'}}),/provenance/);});
test('all acquired fonts and licence match the official member pins',checkChineseFonts);

test('public source admits font recipe and licence, not standalone binaries',()=>{assert.equal(isPublicSourcePath('apps/desktop/ui/fonts/MiSans-Regular.woff2'),false);assert.equal(isPublicSourcePath('apps/desktop/ui/fonts/MiSansTC-Regular.woff2'),false);assert.equal(isPublicSourcePath('apps/desktop/ui/fonts/provenance.json'),true);assert.equal(isPublicSourcePath('tools/prepare-chinese-fonts.mjs'),true);});
test('interrupted font ranges retry without writing duplicate bytes',async()=>{
 const bytes=Buffer.from('pinned archive'),archive={url:'https://example.invalid/font',bytes:bytes.length,sha256:hash(bytes)},writes=[],requests=[];let interrupted=false;
 await streamPinnedArchive(archive,chunk=>writes.push(chunk),{chunkBytes:4,fetcher:async(_url,options)=>{requests.push(options.headers.Range);const [start,end]=options.headers.Range.slice(6).split('-').map(Number);if(start===4&&!interrupted){interrupted=true;throw Error('socket closed');}return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});}});
 assert.deepEqual(Buffer.concat(writes),bytes);assert.equal(requests.filter(value=>value==='bytes=4-7').length,2);
});
test('font range bounds and full archive digest remain mandatory',async()=>{
 const bytes=Buffer.from('test'),archive={url:'https://example.invalid/font',bytes:4,sha256:hash(bytes)};
 await assert.rejects(streamPinnedArchive(archive,()=>assert.fail('invalid range written'),{fetcher:async()=>new Response(bytes,{status:200})}),/range response/);
 await assert.rejects(streamPinnedArchive({...archive,sha256:'0'.repeat(64)},()=>{},{fetcher:async()=>new Response(bytes,{status:206,headers:{'content-range':'bytes 0-3/4'}})}),/download changed/);
 await assert.rejects(streamPinnedArchive(archive,()=>{},{chunkBytes:0}),/bounds/);
});
