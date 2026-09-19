import {createPrivateStore} from '../../packages/desktop-host/src/private-store.mjs';
const fail=()=>{throw Object.assign(new Error('Repository pins need recovery.'),{code:'PINS_RECOVERY_REQUIRED'});};
/** Separate durable preferences; stable native state keys survive repository rename. */
export function createRepositoryPins({privateRoot,bindingHash}){
 const store=createPrivateStore({privateRoot,bindingHash});let scan=store.ensureDurable(store.scan());
 const valid=value=>value&&Object.keys(value).length===2&&value.schemaVersion===1&&Array.isArray(value.keys)&&value.keys.length<=1000&&value.keys.every(v=>typeof v==='string'&&v.length>0&&v.length<=255)&&new Set(value.keys).size===value.keys.length;
 if(scan.blocked||scan.events.some(event=>!valid(event.payload)))fail();
 let record=scan.events.at(-1)?.payload??{schemaVersion:1,keys:[]};
 const check=()=>{const live=store.ensureDurable(store.scan());if(live.blocked||live.sequence!==scan.sequence||live.previous!==scan.previous)fail();};
 return Object.freeze({
  get(bindings,defaultRepository){check();return {defaultRepository,pinnedRepositories:[defaultRepository,...bindings.filter(v=>v.name!==defaultRepository&&record.keys.includes(v.stateKey)).map(v=>v.name)]};},
  set(bindings,defaultRepository,repo,pinned){check();const binding=bindings.find(v=>v.name===repo);if(!binding)throw Object.assign(new Error('Unknown repository.'),{code:'UNKNOWN_REPOSITORY'});if(repo===defaultRepository)return this.get(bindings,defaultRepository);
   const keys=record.keys.filter(key=>key!==binding.stateKey);if(pinned)keys.push(binding.stateKey);
   if(JSON.stringify(keys)!==JSON.stringify(record.keys)){if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,record);const next={schemaVersion:1,keys};scan=store.append(scan,'draft',next);if(scan.blocked)fail();record=next;}
   return this.get(bindings,defaultRepository);
  },
 });
}
