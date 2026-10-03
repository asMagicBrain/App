// Private, durable course pairing. Repository IDs survive rename; imported data cannot redirect it.
const fail=code=>{throw Object.assign(Error(code),{code});};
export function createTeachPairs(store){
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');const value=scan.events.at(-1)?.payload??{schemaVersion:1,pairs:{}};if(value.schemaVersion!==1||!value.pairs||typeof value.pairs!=='object')fail('RECOVERY_REQUIRED');return {scan,value};}
 return {get(id){return structuredClone(load().value.pairs[id]??null);},set(id,pair){let {scan,value}=load();if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,value);store.append(scan,'draft',{schemaVersion:1,pairs:{...value.pairs,[id]:pair}});return structuredClone(pair);}};
}
