/** Stage 2 exact-runtime host/IPC qualification. Migration UI belongs to Stage 3. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDriver,nativeTarget,testRoot} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'teach-workflow-'));
const data=path.join(output,'data'),driver=await createDriver({...nativeTarget(data),output,workspacePath:data});
const plugin=process.env.ASMB_TEACH_PACKAGE;assert.ok(plugin,'ASMB_TEACH_PACKAGE required');let page,running=false,failure;
const bridge=(method,input)=>page.evaluate(async({method,input})=>{const result=await window.asMagicBrain[method](input);if(!result.ok)throw Error(result.error.code??result.error.message);return result.value;},{method,input});
const call=input=>bridge('nativeTeachRequest',input);
try{
 page=await driver.launch();running=true;
 await driver.app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},plugin);
 await page.getByRole('button',{name:'Manage plugins',exact:true}).click();await page.getByRole('button',{name:'Install plugin…',exact:true}).click();await page.getByRole('button',{name:'Install plugin',exact:true}).click();await page.getByRole('switch',{name:'Enable asTeach',exact:true}).click();
 const request={operation:'create',requestId:randomUUID(),code:'QUAL101',name:'阶段二中文课程',year:2026,season:'autumn',structureVersion:2},course=await call(request),repo=course.repo;
 let descriptor=await call({operation:'workspaceDescriptor',repo}),student=descriptor.roles.find(r=>r.role==='students').name;const studentId=descriptor.roles[2].repositoryId;
 assert.equal(descriptor.workflow.mode,'direct-students');assert.equal(descriptor.roles[1].available,false);assert.equal(descriptor.roles[2].homePath,'2026-autumn/student.md');
 const tree=await bridge('request',{repo,operation:'discover',args:{}});assert.ok(!tree.entries.some(e=>e.path.startsWith('2026-autumn/students')));
 const home=await bridge('request',{repo:student,operation:'open',args:{path:'2026-autumn/student.md'}});await bridge('request',{repo:student,operation:'save',args:{path:home.path,baseHash:home.sourceHash,text:'# 学生课程\n\nAuthor-owned.\n'}});
 const saved=await fs.readFile(path.join(data,'workspaces/asMagicBrain',student,home.path));
 await bridge('renameRepository',{repository:student,name:'QUAL101_Students_renamed'});
 await driver.closeNormally();running=false;page=await driver.launch();running=true;
 descriptor=await call({operation:'workspaceDescriptor',repo});assert.equal(descriptor.roles[2].repositoryId,studentId);assert.equal(descriptor.roles[2].name,'QUAL101_Students_renamed');assert.deepEqual(await fs.readFile(path.join(data,'workspaces/asMagicBrain','QUAL101_Students_renamed',home.path)),saved);
 // Fresh-course rollback must refuse later author edits. Migration never writes course files.
 await assert.rejects(call({operation:'recoverDirectStudents',repo,direction:'rollback'}),/CONFLICT/);
 const legacy='LEG101',id=randomUUID();await bridge('createRepository',{name:legacy,requestId:randomUUID()});await bridge('request',{repo:legacy,operation:'create',args:{path:'2026-autumn/instructor.md',text:'# Legacy instructor\n'}});
 await call({operation:'adopt',repo:legacy,course:{schemaVersion:1,courseId:id,code:'LEG101',name:'Legacy',terms:[{year:2026,season:'autumn',source:{kind:'document',paths:['2026-autumn/instructor.md']}}]}});
 const graph=await call({operation:'reviewRepositoryGraph',repo:legacy,assistantId:null});await call({operation:'applyRepositoryGraph',planId:graph.planId});
 const select={operation:'reviewDirectStudents',repo:legacy,homes:{'2026-autumn':'2026-autumn/student.md'}},review=await call(select);assert.equal((await call({operation:'workspaceDescriptor',repo:legacy})).workflow.mode,'legacy-preparation');await call({operation:'applyDirectStudents',planId:review.planId});
 await driver.closeNormally();running=false;page=await driver.launch();running=true;assert.equal((await call({operation:'workspaceDescriptor',repo:legacy})).workflow.mode,'direct-students');assert.equal((await call(select)).alreadyApplied,true);await call({operation:'recoverDirectStudents',repo:legacy,direction:'rollback'});assert.equal((await call({operation:'workspaceDescriptor',repo:legacy})).workflow.mode,'legacy-preparation');
 assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await driver.closeNormally();running=false;driver.record('fresh-pair-migration-rename-restart-rollback',{localOnly:true,uiReview:false});
}catch(error){failure=error;console.error(error);}finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,scope:'Stage 2 host/IPC; synthetic profiles; no remote providers or migration UI',failure:failure?.stack??null});}
console.log(output);if(failure)process.exitCode=1;
