import {createHash} from 'node:crypto';
import {safePath} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha=v=>typeof v==='string'&&/^[0-9a-f]{40}$/.test(v);
const part=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
export function validateSubmissionManifest(v,milestone){
 if(!exact(v,['schemaVersion','milestone','files','artifacts'])||v.schemaVersion!==1||v.milestone!==milestone||!Array.isArray(v.files)||!v.files.length||v.files.length>128||!Array.isArray(v.artifacts)||v.artifacts.length>8)fail('SUBMISSION_MANIFEST');
 const paths=new Set();for(const f of v.files){if(!exact(f,['path','sha256','size'])||typeof f.path!=='string'||!safePath(f.path)||f.path==='submission.json'||f.path.toLowerCase().startsWith('.git/')||paths.has(f.path.toLowerCase())||!digest(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0||f.size>4*1024*1024)fail('SUBMISSION_MANIFEST');paths.add(f.path.toLowerCase());}
 const assets=new Set();for(const a of v.artifacts){if(!exact(a,['assetId','sha256','size','name'])||!Number.isSafeInteger(a.assetId)||a.assetId<=0||assets.has(a.assetId)||!digest(a.sha256)||!Number.isSafeInteger(a.size)||a.size<0||a.size>64*1024*1024||typeof a.name!=='string'||!safePath(a.name)||a.name.includes('/'))fail('SUBMISSION_MANIFEST');assets.add(a.assetId);}
 if(v.files.reduce((n,f)=>n+f.size,0)+v.artifacts.reduce((n,f)=>n+f.size,0)>240*1024*1024)fail('SUBMISSION_LIMIT');return v;
}
// Fixed GitHub endpoints only. Imported Python, weights and archives remain inert.
export async function readGitHubSubmission({request,binary,owner,repository,milestone,sequence}){
 if(!part(owner)||!part(repository)||! /^[a-z][a-z0-9-]{0,31}$/.test(milestone)||!Number.isInteger(sequence)||sequence<1||sequence>9999)fail('INVALID_REQUEST');
 const base=`/repos/${owner}/${repository}`,tag=`asmb-submit/${milestone}/${sequence}`;
 const release=await request(`${base}/releases/tags/${encodeURIComponent(tag)}`);
 if(!release)fail('SUBMISSION_MISSING');const r=release.data;
 if(!Number.isSafeInteger(r.id)||r.draft!==false||r.tag_name!==tag||!date(r.published_at)||!Number.isSafeInteger(r.author?.id)||!part(r.author?.login)||!Array.isArray(r.assets))fail('SUBMISSION_INVALID_RELEASE');
 const ref=await request(`${base}/git/ref/tags/${tag}`);let object=ref?.data?.object;
 for(let i=0;object?.type==='tag'&&i<4;i++){if(!sha(object.sha))fail('SUBMISSION_INVALID_RELEASE');object=(await request(`${base}/git/tags/${object.sha}`))?.data?.object;}
 if(object?.type!=='commit'||!sha(object.sha))fail('SUBMISSION_INVALID_RELEASE');const commit=object.sha;
 const commitRow=await request(`${base}/git/commits/${commit}`);if(!sha(commitRow?.data?.tree?.sha))fail('SUBMISSION_INVALID_RELEASE');const tree=await request(`${base}/git/trees/${commitRow.data.tree.sha}?recursive=1`);if(!tree||tree.data.truncated!==false||!Array.isArray(tree.data.tree))fail('SUBMISSION_LIMIT');
 const regular=p=>{const entry=tree.data.tree.find(v=>v.path===p);if(!entry||entry.type!=='blob'||!['100644','100755'].includes(entry.mode)||!sha(entry.sha))fail('SUBMISSION_MANIFEST');return entry;};
 const content=async p=>{const entry=regular(p);const bytes=await binary(`${base}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`,4*1024*1024,'application/vnd.github.raw+json');const blob=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');if(blob!==entry.sha)fail('SUBMISSION_HASH_MISMATCH');return bytes;};
 const manifestBytes=await content('submission.json');if(manifestBytes.length>65536)fail('SUBMISSION_MANIFEST');let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{fail('SUBMISSION_MANIFEST');}validateSubmissionManifest(manifest,milestone);
 const files=[{path:'submission.json',bytes:manifestBytes}],validated=[];
 for(const f of manifest.files){const bytes=await content(f.path);if(bytes.length!==f.size||hash(bytes)!==f.sha256)fail('SUBMISSION_HASH_MISMATCH');files.push({path:'tracked/'+f.path,bytes});validated.push({...f});}
 for(const a of manifest.artifacts){const asset=r.assets.find(v=>v.id===a.assetId);if(!asset||asset.name!==a.name||asset.size!==a.size||asset.state!=='uploaded'||asset.digest&&asset.digest!==`sha256:${a.sha256}`)fail('SUBMISSION_ARTIFACT');const bytes=await binary(`${base}/releases/assets/${a.assetId}`,64*1024*1024,'application/octet-stream',true);if(bytes.length!==a.size||hash(bytes)!==a.sha256)fail('SUBMISSION_HASH_MISMATCH');files.push({path:`artifacts/${a.assetId}/${a.name}`,bytes});}
 const again=await request(`${base}/releases/tags/${encodeURIComponent(tag)}`),againRef=await request(`${base}/git/ref/tags/${tag}`);
 if(again?.data?.id!==r.id||again.data.published_at!==r.published_at||JSON.stringify(again.data.assets)!==JSON.stringify(r.assets)||againRef?.data?.object?.sha!==ref?.data?.object?.sha)fail('SUBMISSION_CHANGED');
 if(!date(again.serverDate))fail('SUBMISSION_SERVER_TIME');
 return {tag,releaseId:r.id,commit,submitter:{id:r.author.id,login:r.author.login},publishedAt:r.published_at,observedAt:new Date(again.serverDate).toISOString(),manifestHash:hash(manifestBytes),manifest,files,validated};
}
