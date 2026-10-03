import React,{useMemo} from 'react';
import {FocusedWriting} from './FocusedWriting';
import {TeachPipelineSettings,type PipelineCall} from './TeachPipelineSettings';
// Explicit session-only adapter: these fixtures never access native repositories.
export function TeachPipelineStudy(){
 const call=useMemo<PipelineCall>(()=>{
  let migrated=false,revision=0,assistant:string|null=null;const ids={instructors:'1'.repeat(64),assistants:'2'.repeat(64),students:'3'.repeat(64)};
  const files=[{path:'2026-autumn/student.md',text:'# Robotics\n\n[Run the example](run.py)\n'},{path:'2026-autumn/run.py',text:'import mujoco\nmodel = mujoco.MjModel.from_xml_path("model.xml")\n'},{path:'2026-autumn/model.xml',text:'<mujoco><worldbody><body><geom type="box" size=".1 .1 .1"/></body></worldbody></mujoco>\n'},{path:'2026-autumn/LICENSE',text:'Synthetic fixture for local workflow review.\n'}];
  const roles=()=>Object.entries(ids).map(([role,id])=>({role,repositoryId:role==='assistants'?assistant:id,name:role==='assistants'&&!assistant?null:`TEST101_${role==='instructors'?'asTeach':role==='assistants'?'Assistants':'Students'}`,available:role!=='assistants'||Boolean(assistant),intendedVisibility:role==='students'?'public':'private',sourceUrl:remoteRecords[role]?.remote.url??null}));
  const remoteRecords:Record<string,any>={};let remoteReview:any=null;
  const settings=()=>({github:{roles:remoteRecords,pending:null},migrated,revision,roles:roles(),repositories:Object.entries(ids).map(([role,stableId])=>({stableId,name:`TEST101_${role==='instructors'?'asTeach':role==='assistants'?'Assistants':'Students'}`}))});
  let projects:any[]=[],projectReview:any=null;
  let selected:any[],destination='',source='',pendingAssistant:string|null=null;
  return async input=>{
   if(input.operation==='projectSettings')return {projects,pending:null};
   if(input.operation==='reviewProjectCreation'){projectReview={planId:'project-local',teams:Array.from({length:Number(input.count)},(_,i)=>({id:crypto.randomUUID(),label:`Team${String(i+1).padStart(2,'0')}`,localName:`TEST101_2026autumn_Team${String(i+1).padStart(2,'0')}`,term:'2026-autumn'})),status:'Synthetic local repositories only; no files or GitHub requests.'};return projectReview;}
   if(input.operation==='applyProjectCreation'){if(projects.length)return {created:0};projects=projectReview.teams.map((p:any)=>({...p,name:p.localName,available:true,revision:1,policy:{members:[],milestones:[]},github:{roles:{},pending:null},staff:{pending:null},submissions:{receipts:[],checks:[]}}));return {created:projects.length};}
   if(input.operation==='saveProjectPolicy'){const p=projects.find(p=>p.id===input.projectId);p.policy=input.policy;p.revision++;return {saved:true};}
   if(String(input.operation).includes('ProjectGitHub')||String(input.operation).includes('ProjectAccess')||input.operation==='reviewSubmission')throw Error('This session-only study does not simulate remote permission or submission verification. Use the native test build.');
   if(input.operation==='reviewGitHubSetup'){if(!migrated)throw Error('Review local bindings first.');remoteReview={...input,planId:'remote-review',branch:'main',account:{id:1,login:'teacher'},remote:null,changes:['Session-only empty repository setup'],warnings:['No GitHub requests are made in this Storybook study.']};return remoteReview;}
   if(input.operation==='applyGitHubSetup'){remoteRecords[remoteReview.role]={bindingId:ids[remoteReview.role as keyof typeof ids],branch:'main',remote:{id:101+Object.keys(ids).indexOf(remoteReview.role),owner:remoteReview.owner,name:remoteReview.repository,url:`https://github.com/${remoteReview.owner}/${remoteReview.repository}.git`,visibility:remoteReview.visibility,verifiedAt:Date.now(),account:{login:'teacher'},permissions:{read:true,write:true,admin:true},collaborators:[{login:'teacher',role:'admin'}],invitations:[],accessComplete:true,inheritanceWarning:'Synthetic personal-owner example.'}};return {connected:true};}
   if(input.operation==='verifyGitHubAccess')return {remote:remoteRecords[String(input.role)]?.remote};
   if(input.operation==='saveGitBookMapping'){if(!remoteRecords.students)throw Error('Verify Student setup first.');remoteRecords.students.mapping={url:input.url,root:input.root,branch:'main',syncVerified:false};return {saved:true};}
   if(input.operation==='pipelineSettings')return settings();
   if(input.operation==='reviewRepositoryGraph'){pendingAssistant=input.assistantId as string|null;return {planId:'migration',before:settings(),after:{...settings(),roles:roles().map(r=>r.role==='assistants'?{...r,name:pendingAssistant?'TEST101_Assistants':null}:r)},preserves:['Repository files and Git history','Drafts, calendars and deadlines','Existing names and course identity']};}
   if(input.operation==='applyRepositoryGraph'){assistant=pendingAssistant;migrated=true;revision++;return settings();}
   if(input.operation==='pipelineFiles'){source=roles().find(r=>r.role===input.fromRole)?.name??'';destination=roles().find(r=>r.role===input.toRole)?.name??'';if(!source||!destination)throw Error('Bind the selected role first.');return {source,destination,sourceCommit:null,entries:files.map(f=>({path:f.path,type:'file'}))};}
   if(input.operation==='reviewPromotion'){selected=files.filter(f=>(input.paths as string[]).includes(f.path));if((selected.some(f=>f.path.endsWith('student.md'))&&!selected.some(f=>f.path.endsWith('run.py')))||(selected.some(f=>f.path.endsWith('run.py'))&&!selected.some(f=>f.path.endsWith('model.xml'))))throw Object.assign(Error('PROMOTION_DEPENDENCY'),{code:'PROMOTION_DEPENDENCY'});return {planId:'copy',warnings:['Session-only example. No repository files, permissions or GitHub content are changed.'],files:await Promise.all(selected.map(async f=>({path:f.path,bytes:new TextEncoder().encode(f.text).length,preview:f.text,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(f.text)))).map(v=>v.toString(16).padStart(2,'0')).join('')}))),comparison:{rows:selected.map(f=>({path:f.path,action:'add'})),warnings:[]}};}
   if(input.operation==='applyPromotion')return {files:selected.length};
   return {cancelled:true};
  };
 },[]);
 return <FocusedWriting repositoryHeader repositoryCode initialTheme="light-default" workspaceStudy={{active:true,rail:null,onExit:()=>{},headerContext:<nav className="pws-breadcrumb" aria-label="asTeach breadcrumb">asTeach / Courses / TEST101 / 2026 Autumn / Course settings</nav>,headerContextReplacesOwner:true,content:<><p className="teach-pipeline">Session-only settings study. Opening repositories is available in the native app.</p><TeachPipelineSettings repo="TEST101_asTeach" year={2026} season="autumn" call={call}/></>}}/>;
}
