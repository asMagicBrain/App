import {randomUUID,createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(Error(code),{code});};
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validLogin=v=>typeof v==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v)&&!v.includes('--');
/** Volatile consent, durable per-recipient uncertainty in the existing grant managers.
 * Review reads only. Apply re-resolves exact reviewed identities and stops at the first failure. */
export function createTeachAccessBatch({context,review,apply,cancel}){
 const plans=new Map();let paused=false;const ready=()=>{if(paused)fail('GITHUB_BUSY');};
 return {
  pause(){paused=true;plans.clear();},resume(){paused=false;},
  async review(input){ready();if(!Array.isArray(input.logins)||!input.logins.length||input.logins.length>100||!input.logins.every(validLogin)||new Set(input.logins.map(v=>v.toLowerCase())).size!==input.logins.length||!['read','write'].includes(input.permission))fail('INVALID_REQUEST');
   for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);if(plans.size>=8)fail('BUSY');
   const local=fingerprint(await context(input)),rows=[];
   for(const login of input.logins){const r=await review({...input,login});await cancel(input,r.planId);rows.push({...r,planId:undefined});}
   if(fingerprint(await context(input))!==local)fail('CONFLICT');ready();
   if(rows.some(r=>r.account.id!==rows[0].account.id||r.remote.id!==rows[0].remote.id))fail('GITHUB_ACCOUNT_CHANGED');
   const planId=randomUUID();plans.set(planId,{input:structuredClone(input),local,rows,expires:Date.now()+300000});return {planId,rows,permission:input.permission};
  },
  cancel(planId){plans.delete(planId);return {cancelled:true};},
  async apply(planId){ready();const p=plans.get(planId);plans.delete(planId);if(!p||p.expires<Date.now())fail('STALE_PLAN');if(fingerprint(await context(p.input))!==p.local)fail('CONFLICT');const results=[];
   for(const [index,original] of p.rows.entries()){
    let fresh;
    try{ready();if(fingerprint(await context(p.input))!==p.local)fail('CONFLICT');fresh=await review({...p.input,login:original.user.login});
     if(fresh.account.id!==original.account.id)fail('GITHUB_ACCOUNT_CHANGED');if(fresh.user.id!==original.user.id)fail('GITHUB_USER_CHANGED');if(fresh.remote.id!==original.remote.id||fresh.remote.ownerId!==original.remote.ownerId||fresh.remote.visibility!==original.remote.visibility)fail('GITHUB_REPOSITORY_CHANGED');if(original.action==='none'&&fresh.action!=='none')fail('GITHUB_ACCESS_CHANGED');
     const result=await apply(p.input,fresh.planId);fresh=null;results.push({login:original.user.login,status:result.status,changed:result.changed});
    }catch(error){if(fresh)await cancel(p.input,fresh.planId).catch(()=>{});results.push({login:original.user.login,error:error.code??'GITHUB_REQUEST_FAILED',status:'Stopped; recheck before retrying'});results.push(...p.rows.slice(index+1).map(r=>({login:r.user.login,status:'Not attempted'})));return {complete:false,results};}
   }
   return {complete:true,results};
  }
 };
}
