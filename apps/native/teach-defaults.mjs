import {emptyDefaults,validateDefaults} from '../../packages/asteach-plugin/settings.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function createTeachDefaults(store){
 function read(){let scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');if(!scan.events.length)scan=store.append(scan,'draft',{revision:0,value:emptyDefaults()});for(const event of scan.events){if(event.payload.revision!==event.sequence-1)fail('RECOVERY_REQUIRED');validateDefaults(event.payload.value);}return {scan,current:scan.events.at(-1).payload};}
 return {get:()=>structuredClone(read().current),set(expectedRevision,value){value=validateDefaults(value);let {scan,current}=read();if(current.revision!==expectedRevision)fail('CONFLICT');if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,current);const next={revision:current.revision+1,value};store.append(scan,'draft',next);return structuredClone(next);}};
}
