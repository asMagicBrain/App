import React, {useEffect, useMemo, useRef, useState} from 'react';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
import {hydrateTechnicalDiagrams} from './technical-diagrams';
import DocumentPresentation,{visiblePresentationPosition,restorePresentationPosition} from './DocumentPresentation';
import '../../apps/desktop/ui/fonts/cjk-fonts.css';
import 'katex/dist/katex.min.css';

const course = `# Robotics — Student course

Course overview and reading materials.

## Introduction

A model describes what we can predict within a stated experiment.

Open [Class 01](classes/Class01.md) to continue teaching from the class page.

## Design to data

Record the experiment, measurements and conditions.

| Measurement | Unit | Notes |
| --- | --- | --- |
| Position | rad | Preserve the original observations. |
| Torque | N·m | State how it was estimated. |

### Data contract

This deeper heading stays in the same presentation section.

## Data to model

$$\\tau = I\\alpha + b\\omega$$

Compare predictions with a separate validation experiment.

## Discussion

What does the model explain? What remains untested?
`;
const classPage = `# Class 01 — Introduction

## Learning objective

Describe the claim, experiment and evidence required for a useful model.

## Experiment

1. Inspect the proposed setup.
2. List measurements and assumptions.
3. Define a comparison with held-out observations.

## Discuss

Explain one limitation and one next experiment.
`;

/** Shared built-in view, with synthetic course content and reading-position return. */
export function PresentationStudy(){
 const [page,setPage]=useState<'course'|'class'>('course'),[active,setActive]=useState(false);
 const saved=useRef({line:1,offset:0}),reading=useRef<HTMLDivElement>(null);
 const html=useMemo(()=>renderSourcePreview(page==='course'?course:classPage,page==='course'?'2026-autumn/student.md':'2026-autumn/classes/Class01.md',{technical:true,sourceMap:true}).html,[page]);
 useEffect(()=>{if(!active&&reading.current)restorePresentationPosition(reading.current,saved.current);},[active,page]);
 return <main style={{height:'100dvh',display:'flex',flexDirection:'column',fontFamily:'-apple-system,sans-serif'}}><header style={{padding:'12px 24px',borderBottom:'1px solid #d0d7de'}}>Student {page==='course'?'course':'Class 01'} <button style={{float:'right'}} onClick={()=>{if(reading.current)saved.current=visiblePresentationPosition(reading.current);setActive(true);}}>Present</button></header><div ref={reading} style={{overflow:'auto',padding:32,flex:1}} dangerouslySetInnerHTML={{__html:html}}/>{active&&<DocumentPresentation html={html} path={page==='course'?'student.md':'classes/Class01.md'} initialPosition={saved.current} onExit={position=>{saved.current=position;setActive(false);}} onNavigate={async(link,back)=>{if(back)setPage('course');else if(link==='classes/Class01.md')setPage('class');else return false;return true;}}/>}</main>;
}
