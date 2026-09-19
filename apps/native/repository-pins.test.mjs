import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createNativeService} from './host-service.mjs';
test('pins persist across quit and stable repository/default rename without changing source',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pins-')),dataRoot=path.join(root,'data');let service=await createNativeService({dataRoot});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 assert.deepEqual(await service.getRepositoryPins(),{defaultRepository:'Workspace',pinnedRepositories:['Workspace']});await service.createRepository({name:'Pinned',requestId:randomUUID()});await service.setRepositoryPinned({repo:'Pinned',pinned:true});await service.renameRepository({repository:'Pinned',name:'Renamed'});await service.renameRepository({repository:'Workspace',name:'Default'});await service.close();service=await createNativeService({dataRoot});
 assert.deepEqual(await service.getRepositoryPins(),{defaultRepository:'Default',pinnedRepositories:['Default','Renamed']});assert.deepEqual(await service.setRepositoryPinned({repo:'Default',pinned:false}),{defaultRepository:'Default',pinnedRepositories:['Default','Renamed']});assert.deepEqual(await service.setRepositoryPinned({repo:'Renamed',pinned:false}),{defaultRepository:'Default',pinnedRepositories:['Default']});
 await assert.rejects(service.setRepositoryPinned({repo:'Renamed',pinned:'yes'}),{code:'INVALID_REQUEST'});await assert.rejects(service.setRepositoryPinned({repo:'absent',pinned:true}),{code:'UNKNOWN_REPOSITORY'});
 assert.deepEqual(fs.readdirSync(path.join(dataRoot,'workspaces/asMagicBrain/Renamed')),['.git']);
});
test('corrupt pin preferences remain preserved and never become an empty successful preference',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pins-corrupt-')),dataRoot=path.join(root,'data');let service=await createNativeService({dataRoot});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 await service.createRepository({name:'Pinned',requestId:randomUUID()});await service.setRepositoryPinned({repo:'Pinned',pinned:true});await service.close();
 const directory=path.join(dataRoot,'state/native/.asmb-repository-pins'),filename=path.join(directory,fs.readdirSync(directory).find(name=>name.endsWith('.json')));const corrupt=Buffer.from('{broken');fs.writeFileSync(filename,corrupt);
 service=await createNativeService({dataRoot});await assert.rejects(service.getRepositoryPins(),{code:'RECOVERY_REQUIRED'});assert.deepEqual(fs.readFileSync(filename),corrupt);assert.equal((await service.catalog()).repositories.length,2);
});
