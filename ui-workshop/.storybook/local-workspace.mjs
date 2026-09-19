import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {workspaceRoot,stateRoot} from './workspace-paths.mjs';
import {createWorkspaceService as createService} from '../../packages/desktop-host/src/workspace-service.mjs';
export {workspaceRoot};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function createWorkspaceService({base=workspaceRoot,privateBase=stateRoot,...options}={}){return createService({base,privateBase,...options});}

export function createWorkspaceHandler({port=6006,...options}={}){
 const service=createWorkspaceService(options),capability=randomBytes(32).toString('hex'),queues=new Map(),preferencesQueue=Symbol('commit-preferences');
 const response=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});res.end(JSON.stringify(value));};
 const handler=async(req,res)=>{
  const allowed=[`127.0.0.1:${port}`,`localhost:${port}`],origin=`http://${req.headers.host}`;
  if(!allowed.includes(req.headers.host)||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin))return response(res,403,{ok:false,error:{code:'ORIGIN_DENIED',message:'Request origin is not allowed.'}});
  try{
   if(req.method==='GET'){
    const url=new URL(req.url,origin);if([...url.searchParams.keys()].some(k=>k!=='repo')||url.searchParams.getAll('repo').length!==1)fail('INVALID_REQUEST');
    return response(res,200,{capability,...service.bootstrap(url.searchParams.get('repo'))});
   }
   if(req.method!=='POST')return response(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'Use POST.'}});
   if(req.headers.origin!==origin||req.headers['x-asmagicbrain-capability']!==capability||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return response(res,403,{ok:false,error:{code:'CAPABILITY_DENIED',message:'Reload the workspace before saving.'}});
   const chunks=[];let length=0;for await(const part of req){length+=part.length;if(length>7*1024*1024)fail('BODY_TOO_LARGE');chunks.push(Buffer.from(part));}const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   let data;try{data=JSON.parse(body);}catch{fail('INVALID_REQUEST');}if(!exact(data,['repo','operation','args'])||typeof data.repo!=='string'||typeof data.operation!=='string')fail('INVALID_REQUEST');
   const queue=data.operation==='getCommitPreferences'||data.operation==='setCommitPreferences'?preferencesQueue:data.repo;
   const prior=queues.get(queue)||Promise.resolve(),work=prior.catch(()=>{}).then(()=>service.execute(data.repo,data.operation,data.args));queues.set(queue,work);try{return response(res,200,{ok:true,value:await work});}finally{if(queues.get(queue)===work)queues.delete(queue);}
  }catch(error){const code=typeof error.code==='string'?error.code:'LOCAL_OPERATION_FAILED';const createdDirectories=Array.isArray(error.createdDirectories)?error.createdDirectories.filter(v=>typeof v==='string'&&!path.isAbsolute(v)&&!v.split('/').includes('..')):[];response(res,['CONFLICT','INDEX_CHANGED','HEAD_CHANGED','ALREADY_EXISTS'].includes(code)?409:400,{ok:false,error:{code,message:code.replaceAll('_',' ').toLowerCase()+(createdDirectories.length?` (created folders retained: ${createdDirectories.join(', ')})`:''),createdDirectories}});}
 };
 handler.close=()=>service.close();return handler;
}
