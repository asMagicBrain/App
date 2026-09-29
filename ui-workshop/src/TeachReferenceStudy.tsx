import React, {useEffect, useState} from 'react';
import {PluginWorkspaceStudy} from './PluginWorkspaceStudy';
import type {TeachStudyCourse} from './teach-plugin-fixture';
import {approvedTeachAssetUrl} from './teach-content.mjs';

type ReferenceDataset={schemaVersion:1;label:string;courses:readonly TeachStudyCourse[]};
const text=(value:unknown,limit=512*1024):value is string=>typeof value==='string'&&value.length<=limit;
const sourcePath=(value:unknown):value is string=>text(value,2048)&&value.length>0&&!value.startsWith('/')&&!/[\\\u0000-\u001f]/.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
function isReferenceDataset(value:unknown):value is ReferenceDataset {
  if(!value||typeof value!=='object')return false;
  const dataset=value as Partial<ReferenceDataset>;
  if(dataset.schemaVersion!==1||!text(dataset.label,160)||!Array.isArray(dataset.courses)||!dataset.courses.length||dataset.courses.length>20)return false;
  const courseIds=new Set<string>();
  return dataset.courses.every(course=>{
    if(!course||course.readOnly!==true||!text(course.id,80)||!/^[\w.-]+$/.test(course.id)||courseIds.has(course.id)||!text(course.code,32)||!text(course.title,160)||!text(course.description,2000)||!text(course.repository,160)||!text(course.year,4)||!text(course.season,80)||!Array.isArray(course.sections)||course.sections.length>100)return false;
    courseIds.add(course.id);
    const reference=course.reference;
    if(!reference||!text(reference.sourceCommit,64)||!text(reference.home?.title,160)||!sourcePath(reference.home?.path)||!text(reference.home?.source)||!['composed','document'].includes(reference.home?.kind)||!Array.isArray(reference.pages)||reference.pages.length>100)return false;
    const ids=new Set(['home']);
    for(const section of [...course.sections,...reference.pages]){
      if(!section||!text(section.id,80)||!/^[\w.-]+$/.test(section.id)||ids.has(section.id)||!text(section.title,160)||!sourcePath(section.path)||!text(section.source))return false;
      ids.add(section.id);
    }
    return !reference.assets||Object.entries(reference.assets).every(([path,url])=>sourcePath(path)&&approvedTeachAssetUrl(url));
  });
}

/** Only an explicitly configured loopback fixture can provide private course text. */
export function TeachReferenceStudy({fixtureUrl='/__asteach-reference/fixture.json'}:{fixtureUrl?:string}) {
  const [dataset,setDataset]=useState<ReferenceDataset|null>(null),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setDataset(null);setFailed(false);
    void(async()=>{
      try{
        const url=new URL(fixtureUrl,window.location.href);
        if(url.origin!==window.location.origin||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/__asteach-reference/fixture.json'||url.search||url.hash||url.username||url.password)throw Error('Unsupported fixture location');
        const response=await fetch(url,{signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
        if(!response.ok)throw Error('Reference unavailable');
        const body=await response.text();
        if(body.length>8*1024*1024)throw Error('Reference too large');
        const parsed:unknown=JSON.parse(body);
        if(!isReferenceDataset(parsed))throw Error('Invalid reference');
        if(!controller.signal.aborted)setDataset(parsed);
      }catch{if(!controller.signal.aborted)setFailed(true);}
    })();
    return()=>controller.abort();
  },[fixtureUrl,attempt]);
  if(dataset)return <PluginWorkspaceStudy initialView="teach" initialCourses={dataset.courses}/>;
  return <section className="pws-reference-state" aria-live="polite"><h1>{failed?'DES5002 reference unavailable':'Loading DES5002 reference…'}</h1><p>{failed?'Enable the isolated local reference fixture to read this course. The original course text is not bundled with Storybook.':'Reading the configured local course copy.'}</p>{failed&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>Retry reference</button>}</section>;
}
