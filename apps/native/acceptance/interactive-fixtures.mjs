import fs from 'node:fs/promises';
import path from 'node:path';
import {buildArtifactManifest} from '../../../tools/create-artifact-manifest.mjs';

const examples={
 saturation:{title:'Actuator saturation',label:'Requested effort',min:-2,max:2,value:.5,step:.05,formula:'Math.max(-1,Math.min(1,v))',explanation:'Illustrative clip at ±1 N m. This is a mathematical example, not a motor calibration.'},
 sampling:{title:'Sampling',label:'Sample interval (ms)',min:4,max:40,value:16,step:1,formula:'1000/v',explanation:'Sample frequency = 1000 / interval in ms. Blue points sample a constructed sine wave; they are not measured motor data.'},
 coordinates:{title:'Coordinate transformation',label:'Frame rotation (degrees)',min:0,max:180,value:30,step:1,formula:'Math.cos(v*Math.PI/180)',explanation:'A unit vector rotated in a planar frame: x = cos(angle), y = sin(angle). This does not estimate a physical frame.'},
 sensitivity:{title:'Parameter sensitivity',label:'Damping coefficient',min:.1,max:2,value:.5,step:.05,formula:'Math.exp(-v)',explanation:'Constructed response exp(−damping × time). Change damping while retaining the same initial condition.'},
};
export async function createInteractiveFixtures(root){
 await fs.mkdir(path.join(root,'examples'),{recursive:true});await fs.mkdir(path.join(root,'fonts'),{recursive:true});
 await fs.copyFile(new URL('../../desktop/ui/fonts/MiSans-Regular.woff2',import.meta.url),path.join(root,'fonts/MiSans-Regular.woff2'));
 await fs.copyFile(new URL('../../desktop/ui/fonts/MiSans-LICENSE.txt',import.meta.url),path.join(root,'fonts/MiSans-LICENSE.txt'));
 let markdown='# Offline teaching examples\n\nDeveloper-owned mathematical illustrations. Activate each example explicitly.\n';
 for(const [name,e] of Object.entries(examples)){
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e.title}</title><style>@font-face{font-family:MiSans;src:url('../fonts/MiSans-Regular.woff2')}*{box-sizing:border-box}body{margin:0;padding:24px;font:20px/1.5 MiSans,sans-serif;color:#1f2328;background:white}h1{font-size:1.4em}input{width:min(100%,600px)}svg{display:block;width:100%;max-height:42vh}svg text{font:20px MiSans,sans-serif;fill:#1f2328}button{font:inherit}button:focus-visible,input:focus-visible{outline:3px solid #0969da}p{max-width:65ch}</style><h1>${e.title}</h1><p>${e.explanation}</p><label>${e.label}<br><input id="control" type="range" min="${e.min}" max="${e.max}" step="${e.step}" value="${e.value}"></label><p id="result" aria-live="polite"></p><svg viewBox="0 0 900 300" role="img" aria-label="Live ${e.title.toLowerCase()} plot"><path d="M50 20V250H850" fill="none" stroke="#59636e"/><g id="samples"></g><line id="vector" x1="450" y1="150" x2="450" y2="150" stroke="#d55e00" stroke-width="4"/><path id="curve" fill="none" stroke="#0969da" stroke-width="4"/><text x="55" y="285">Constructed input / time</text></svg><script>const control=document.querySelector('#control');function draw(){const v=+control.value,y=${e.formula};document.querySelector('#result').textContent='Input '+v.toFixed(3)+' → output '+y.toFixed(4);let points=[];for(let i=0;i<=100;i++){let t=i/100;let value=${name==='saturation'?'Math.max(-1,Math.min(1,v*(2*t-1)))':name==='sampling'?'Math.sin(t*2*Math.PI)':name==='coordinates'?'Math.sin(t*v*Math.PI/180)':'Math.exp(-v*t*4)'};points.push((i?'L':'M')+(50+800*t)+','+(150-90*value));}document.querySelector('#curve').setAttribute('d',points.join(' '));${name==='sampling'?"document.querySelector('#samples').innerHTML=Array.from({length:Math.floor(1000/v)+1},(_,i)=>{const t=i*v/1000;return '<circle cx=\"'+(50+800*t)+'\" cy=\"'+(150-90*Math.sin(t*2*Math.PI))+'\" r=\"4\" fill=\"#d55e00\"/>'}).join('');":name==='coordinates'?"const vector=document.querySelector('#vector');vector.setAttribute('x2',450+120*Math.cos(v*Math.PI/180));vector.setAttribute('y2',150-120*Math.sin(v*Math.PI/180));":''}}control.addEventListener('input',draw);draw();</script></html>`;
  await fs.writeFile(path.join(root,'examples',name+'.html'),html);await fs.writeFile(path.join(root,'examples',name+'.md'),e.explanation);
  const manifest=buildArtifactManifest({root,id:'teaching.'+name,title:e.title,entry:'examples/'+name+'.html',fallback:'examples/'+name+'.md',assets:['fonts/MiSans-Regular.woff2','fonts/MiSans-LICENSE.txt']});
  await fs.writeFile(path.join(root,name+'.artifact.json'),JSON.stringify(manifest,null,2));
  markdown+=`\n## ${e.title}\n\n\`\`\`asmb-interactive\n${JSON.stringify({path:name+'.artifact.json',caption:e.title,fallback:e.explanation})}\n\`\`\`\n`;
 }
 await fs.writeFile(path.join(root,'README.md'),markdown);
 return Object.keys(examples);
}
