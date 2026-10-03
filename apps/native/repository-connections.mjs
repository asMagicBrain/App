import {canonicalGitHubUrl} from '../../packages/desktop-host/src/local-git/github-clone.mjs';
const fail=()=>{throw Object.assign(Error('RECOVERY_REQUIRED'),{code:'RECOVERY_REQUIRED'});};
export function validConnectionBranch(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.split('/').some(part=>part.startsWith('.')||part.endsWith('.')||part.endsWith('.lock'));}
// Host-private records follow the repository's stable state key through rename.
// This never adopts destinations from a repository's editable .git/config.
export function createRepositoryConnections(store){
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail();const value=scan.events.at(-1)?.payload??{schemaVersion:1,connections:{}};if(value.schemaVersion!==1||!value.connections||typeof value.connections!=='object'||Array.isArray(value.connections))fail();for(const connection of Object.values(value.connections)){if(!connection||!/^\d+:\d+$/.test(connection.identity)||!validConnectionBranch(connection.branch))fail();try{if(canonicalGitHubUrl(connection.sourceUrl)!==connection.sourceUrl)fail();}catch{fail();}}return {scan,value};}
 return {get(key){const {value}=load();return Object.hasOwn(value.connections,key)?structuredClone(value.connections[key]):null;},set(key,connection){let {scan,value}=load();if(Object.hasOwn(value.connections,key))throw Object.assign(Error('GITHUB_ALREADY_CONNECTED'),{code:'GITHUB_ALREADY_CONNECTED'});if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,value);store.append(scan,'draft',{schemaVersion:1,connections:{...value.connections,[key]:connection}});}};
}
