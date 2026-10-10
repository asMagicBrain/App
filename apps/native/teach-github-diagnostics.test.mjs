import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeachGitHubProvider} from './teach-github-provider.mjs';
import {safeGitHubDiagnostic} from './teach-github-diagnostics.mjs';
for(const [status,code,outcome] of [[403,'GITHUB_PERMISSION_REQUIRED','rejected'],[422,'GITHUB_GRANT_REJECTED','rejected'],[404,'GITHUB_REPOSITORY_UNAVAILABLE','rejected'],[500,'GITHUB_UNAVAILABLE','unknown']])test(`grant HTTP ${status} retains only safe diagnostics`,async()=>{
 const p=createTeachGitHubProvider({getCredential:async()=>({token:'synthetic-secret'}),fetch:async(_url,options)=>options.method==='PUT'?new Response(JSON.stringify({message:'private@example.test synthetic-secret',errors:[{secret:'untrusted'}]}),{status,headers:{'x-github-request-id':'ABCD:1234'}}):new Response(JSON.stringify({id:1,login:'teacher'}))});
 const s=await p.session();await assert.rejects(s.grant({owner:'school',repository:'course',login:'assistant',permission:'write',ownerType:'Organization'}),error=>{assert.equal(error.code,code);assert.equal(error.diagnostic.httpStatus,status);assert.equal(error.diagnostic.requestId,'ABCD:1234');assert.equal(error.diagnostic.outcome,outcome);assert.ok(!JSON.stringify(error.diagnostic).includes('synthetic-secret'));assert.ok(!JSON.stringify(error.diagnostic).includes('private@'));return true;});
});
test('transport timeout is inconclusive and never exposes thrown credentials',async()=>{
 const p=createTeachGitHubProvider({getCredential:async()=>({token:'synthetic-secret'}),fetch:async(_url,options)=>{if(options.method==='PUT')throw Error('synthetic-secret private@example.test');return new Response(JSON.stringify({id:1,login:'teacher'}));}});const s=await p.session();await assert.rejects(s.grant({owner:'school',repository:'course',login:'assistant',permission:'write',ownerType:'Organization'}),e=>{assert.equal(e.code,'GITHUB_OUTCOME_UNKNOWN');assert.equal(e.diagnostic.outcome,'unknown');assert.equal(e.diagnostic.httpStatus,undefined);assert.ok(!e.publicMessage.includes('synthetic-secret'));return true;});
});
test('only known API messages and bounded request IDs survive diagnostic sanitization',()=>{
 const d=safeGitHubDiagnostic({code:'GITHUB_PERMISSION_REQUIRED',diagnostic:{outcome:'rejected',httpStatus:403,requestId:'token with spaces',apiMessage:'Resource not accessible by integration',raw:'private'}});assert.equal(d.apiMessage,'Resource not accessible by integration');assert.equal(d.requestId,undefined);assert.equal(d.raw,undefined);
});

test('GitHub seat_limit validation is actionable without disclosing arbitrary validation text',async()=>{
 const p=createTeachGitHubProvider({getCredential:async()=>({token:'synthetic-secret'}),fetch:async(_url,options)=>options.method==='PUT'?new Response(JSON.stringify({message:'Validation Failed',errors:[{resource:'Repository',field:'seat_limit',code:'custom',message:'seat_limit private@example.test synthetic-secret'}]}),{status:422,headers:{'x-github-request-id':'ABCD:1234'}}):new Response(JSON.stringify({id:1,login:'teacher'}))});const session=await p.session();await assert.rejects(session.grant({owner:'school',repository:'course',login:'assistant',permission:'write',ownerType:'Organization'}),e=>{assert.equal(e.code,'GITHUB_SEAT_LIMIT');assert.equal(e.diagnostic.reason,'seat_limit');assert.equal(e.diagnostic.outcome,'rejected');assert.equal(e.diagnostic.httpStatus,422);assert.ok(!JSON.stringify(e.diagnostic).includes('private@'));assert.match(e.publicMessage,/organization has no available/);return true;});
});
