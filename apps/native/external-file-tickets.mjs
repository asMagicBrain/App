import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
/** Private main-process registry. Only the preload File conversion or native
 * picker supplies paths; public import requests carry an opaque one-use ticket. */
export function createExternalFileTickets({prepare,importFiles,now=Date.now}){
 const tickets=new Map(),epochs=new Map();let preparing=0;
 const epoch=owner=>epochs.get(owner)??0;
 function expire(){for(const [key,value]of tickets)if(!value.active&&value.expiresAt<=now())tickets.delete(key);}
 async function register(owner,paths){
  expire();if(tickets.size+preparing>=8)fail('IMPORT_BUSY');
  if(!Array.isArray(paths)||!paths.length||paths.length>256||paths.some(value=>typeof value!=='string'||!value||value.length>4096))fail('INVALID_EXTERNAL_FILES');
  const generation=epoch(owner);preparing++;
  try{
   const sources=await prepare([...paths]);if(epoch(owner)!==generation)fail('IMPORT_CANCELLED');
   const ticket=randomUUID(),expiresAt=now()+5*60*1000;
   tickets.set(ticket,{owner,sources,expiresAt,active:false,controller:null});
   return {ticket,expiresAt,entries:sources.map(item=>({name:path.basename(item.path),kind:item.kind}))};
  }finally{preparing--;}
 }
 async function consume(owner,request){
  expire();if(!exact(request,['repo','destination','ticket'])||typeof request.repo!=='string'||typeof request.destination!=='string'||typeof request.ticket!=='string')fail('INVALID_REQUEST');
  const value=tickets.get(request.ticket);if(!value||value.owner!==owner||value.active)fail('IMPORT_TICKET_EXPIRED');
  value.active=true;value.controller=new AbortController();
  try{return await importFiles({repo:request.repo,destination:request.destination,sources:value.sources},{signal:value.controller.signal});}
  finally{tickets.delete(request.ticket);}
 }
 function cancel(owner,request){
  if(!exact(request,['ticket'])||typeof request.ticket!=='string')fail('INVALID_REQUEST');
  const value=tickets.get(request.ticket);if(!value||value.owner!==owner)return;
  if(value.active)value.controller.abort();else tickets.delete(request.ticket);
 }
 function releaseOwner(owner){epochs.set(owner,epoch(owner)+1);for(const [ticket,value]of tickets)if(value.owner===owner){if(value.active)value.controller.abort();else tickets.delete(ticket);}}
 return Object.freeze({register,consume,cancel,releaseOwner});
}
