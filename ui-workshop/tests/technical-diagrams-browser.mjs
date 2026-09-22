import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {build} from '../node_modules/vite/dist/node/index.js';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {staticHandler} from '../.storybook/static-server.mjs';

const output = process.env.ASMB_DIAGRAM_OUTPUT, executablePath = process.env.ASMB_BROWSER;
assert(output && executablePath, 'Set ASMB_DIAGRAM_OUTPUT and ASMB_BROWSER.');
const relative = path.relative(testRoot, output);
assert(path.isAbsolute(output) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
await fs.mkdir(path.dirname(output), {recursive: true});
assert.equal(await fs.realpath(path.dirname(output)), path.dirname(output));
await fs.mkdir(output); await fs.mkdir(path.join(output, 'tmp'));
for (const key of ['TMPDIR','TEMP','TMP']) process.env[key] = path.join(output, 'tmp');
const src = fileURLToPath(new URL('../src/', import.meta.url));
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div class="rfe"><main id="preview"></main></div><script type="module" src="/harness.ts"></script></body></html>');
await fs.writeFile(path.join(output, 'harness.ts'), `
import {hydrateTechnicalDiagrams} from ${JSON.stringify(path.join(src, 'technical-diagrams.ts'))};
import {sanitizeDiagramSvg} from ${JSON.stringify(path.join(src, 'technical-diagram-svg.ts'))};
import ${JSON.stringify(path.join(src, 'technical-diagrams.css'))};
import ${JSON.stringify(path.join(src, 'repository-file-editor.css'))};
const root=document.querySelector('#preview');
root.style.cssText='width:100%;min-width:0;max-width:1000px;margin:24px auto;font:16px/1.5 sans-serif;padding:16px;--fw-bg:#fff;--fw-text:#171717;--fw-line:#777;background:var(--fw-bg);color:var(--fw-text)';
let controller=new AbortController();let events=0;root.addEventListener('asmb:preview-layout',()=>events++);
function prepare(sources){controller.abort();controller=new AbortController();root.replaceChildren();for(const source of sources){const slot=document.createElement('figure');slot.dataset.mermaidDiagram='diagram';slot.dataset.sourceLine='10';const code=document.createElement('code');code.textContent=source;slot.append(code);root.append(slot);}const tail=document.createElement('p');tail.id='tail';tail.textContent='This paragraph remains readable.';root.append(tail);}
window.testing={root,sanitizeDiagramSvg,hydrateTechnicalDiagrams,prepare,get events(){return events},async render(sources,theme='light'){prepare(sources);const start=performance.now();await hydrateTechnicalDiagrams(root,{signal:controller.signal,theme});return {elapsed:performance.now()-start,states:[...root.querySelectorAll('[data-mermaid-diagram]')].map(e=>e.dataset.diagramState)}},abort(){controller.abort()}};
`);
await build({configFile:false,root:output,base:'./',logLevel:'warn',build:{outDir:path.join(output,'build'),emptyOutDir:false,target:'es2022',reportCompressedSize:false}});
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
server.on('request',await staticHandler(path.join(output,'build'),port));
const external=[],errors=[],checks=[];let browser;
const fixtures=[
  'flowchart LR\n  S[Sensor capture] --> H[Authenticated hub]\n  H --> M[Monitor display]\n  M -->|Requested setting| H\n  H -->|Acknowledged setting| M',
  'sequenceDiagram\n  participant M as Monitor\n  participant S as Sensor\n  M->>S: Request rate with request ID\n  S-->>M: Applied rate and capture epoch',
  'stateDiagram-v2\n  [*] --> Disconnected\n  Disconnected --> Connected: pair\n  Connected --> Stale: timeout\n  Stale --> Connected: fresh sample',
  'flowchart LR\n  A[Unclosed label --> B',
  'flowchart TD\n  A[Later valid diagram] --> B[Still readable]',
];
try {
  browser=await chromium.launchPersistentContext(path.join(output,'profile'),{executablePath,headless:true,chromiumSandbox:true,viewport:{width:1200,height:1000},args:['--disable-background-networking'],env:{...process.env}});
  await browser.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'){external.push(url.href);return route.abort();}return route.continue();});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>Boolean(window.testing));
  const initial=await page.evaluate(fixtures=>window.testing.render(fixtures),fixtures);
  const statuses=await page.locator('.technical-diagram-status').allTextContents();
  await fs.writeFile(path.join(output,'initial.json'),JSON.stringify({initial,statuses},null,2));
  assert.deepEqual(initial.states,['ready','ready','ready','error','ready']);
  assert.deepEqual(await page.locator('.technical-diagram-source code').allTextContents(),fixtures);
  assert.equal(await page.locator('#tail').textContent(),'This paragraph remains readable.');
  assert.equal(await page.locator('.technical-diagram-measure').count(),0);
  assert.equal(await page.locator('.technical-diagram-viewport svg').count(),4);
  assert(await page.locator('.technical-diagram-viewport svg').first().evaluate(svg=>svg.getBoundingClientRect().width)>300, 'Inherited app icon CSS must not shrink diagrams to 16px.');
  assert.equal(await page.locator('[data-source-line="10"]').count(),5);
  assert(await page.evaluate(()=>window.testing.events)>=5);checks.push({name:'neutral fixtures, local syntax failure, original source, cleanup, source-map events',initial});
  const labelGeometry=await page.evaluate(()=>[...document.querySelectorAll('svg.flowchart .node')].map(node=>{const box=node.querySelector('rect.label-container').getBoundingClientRect(),text=node.querySelector('.label text').getBoundingClientRect();return {label:node.textContent,left:text.left-box.left,right:box.right-text.right}}));
  assert(labelGeometry.every(row=>row.left>=-1 && row.right>=-1));checks.push({name:'flowchart labels fit within their node boundaries',labelGeometry});
  await page.screenshot({path:path.join(output,'light.png'),fullPage:true});
  await fs.writeFile(path.join(output,'initial-svg.txt'), await page.locator('.technical-diagram-viewport').first().innerHTML());
  const svgAudit=await page.evaluate(()=>[...document.querySelectorAll('.technical-diagram-viewport svg')].map(svg=>({text:svg.textContent,forbidden:svg.querySelectorAll('script,style,foreignObject,a,image,use,animate,set').length,attrs:[svg,...svg.querySelectorAll('*')].flatMap(e=>[...e.attributes].filter(a=>/^on|href|style/i.test(a.name)||/url\((?!#)/i.test(a.value)).map(a=>a.name)),markers:[...svg.querySelectorAll('[marker-end]')].map(e=>{const id=e.getAttribute('marker-end').slice(5,-1);return Boolean(svg.querySelector('[id="'+id+'"]'))})})));
  await fs.writeFile(path.join(output,'svg-audit.json'),JSON.stringify(svgAudit,null,2));
  assert(svgAudit.every(row=>row.forbidden===0 && row.attrs.length===0 && row.markers.every(Boolean)));assert(svgAudit[0].text.includes('Sensor capture'));assert(svgAudit[1].text.includes('Applied rate and capture epoch'));assert(svgAudit[2].text.includes('Disconnected'));checks.push({name:'safe SVG labels and internal markers',svgAudit});
  const malicious=await page.evaluate(()=>{
    window.attackExecuted=0;
    const svg=window.testing.sanitizeDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.attackExecuted=1"><style>@import url(https://invalid.example/style);body{display:none}</style><script>window.attackExecuted=1</script><foreignObject><iframe src="https://invalid.example/"/></foreignObject><a href="javascript:alert(1)"><text>bad</text></a><image href="https://invalid.example/pixel"/><use href="file:///tmp/a"/><animate attributeName="href" values="javascript:x"/><path id="safe" d="M0 0L10 10" style="fill:url(https://invalid.example)" onclick="window.attackExecuted=1" marker-end="url(https://invalid.example)"/><text>Safe text</text></svg>');
    document.body.append(svg);return {html:svg.outerHTML,executed:window.attackExecuted};
  });
  assert.equal(malicious.executed,0);assert(!/(?:onload|onclick|https:|javascript:|file:|<style|<script|<foreignObject|<image|<use|<animate|<a\s|style=)/i.test(malicious.html));checks.push({name:'hostile SVG stripped',malicious});
  const rejected=await page.evaluate(()=>window.testing.render(['%%{init: {securityLevel:"loose"}}%%\nflowchart LR\nA-->B','flowchart LR\n click A callback','flowchart LR\n A[<img src=x onerror=alert(1)>]','pie\n"a": 2','flowchart LR\n'+'a'.repeat(8192),'flowchart LR\n'+Array.from({length:49},(_,i)=>`N${i}`).join('\n'),'flowchart LR\n'+Array.from({length:81},()=>`A-->B;`).join(''),'flowchart LR\nA:::fw-window-->B','stateDiagram-v2\nA:::fw-window --> B','sequenceDiagram\n'+'loop outer\n'.repeat(5)+'A->>B: message\n'+'end\n'.repeat(5)]));
  assert(rejected.states.every(state=>state==='error'));checks.push({name:'directives, callbacks, HTML, unsupported type, source/node/edge rejection',rejected});
  const cancelled=await page.evaluate(async()=>{window.testing.prepare(Array(8).fill('flowchart LR\nA-->B'));const root=window.testing.root;const signal=new AbortController();const pending=window.testing.hydrateTechnicalDiagrams(root,{signal:signal.signal});signal.abort();await pending;return root.querySelectorAll('svg').length});
  assert.equal(cancelled,0);checks.push({name:'abort cancels queued work',cancelled});
  const stale=await page.evaluate(async()=>{window.testing.prepare(['flowchart LR\nOld-->Source']);const pending=window.testing.hydrateTechnicalDiagrams(window.testing.root);const current=await window.testing.render(['flowchart LR\nNew-->Source']);await pending;return {current,text:window.testing.root.querySelector('svg').textContent,count:window.testing.root.querySelectorAll('svg').length}});
  assert.equal(stale.count,1);assert(stale.text.includes('New')&&!stale.text.includes('Old'));checks.push({name:'stale generation cannot replace new document',stale});
  const duplicate=await page.evaluate(async()=>{await window.testing.render(Array(17).fill('flowchart LR\nA-->B'));const ids=[...window.testing.root.querySelectorAll('[id]')].map(e=>e.id);return {states:[...window.testing.root.querySelectorAll('[data-diagram-state]')].map(e=>e.dataset.diagramState),unique:new Set(ids).size===ids.length}});
  assert.deepEqual(duplicate.states,[...Array(16).fill('ready'),'error']);assert(duplicate.unique);checks.push({name:'document cap and cached SVG IDs stay unique',duplicate});
  const flood=await page.evaluate(async()=>{await window.testing.render(Array(2000).fill('flowchart LR\nA-->B'));return {controls:document.querySelectorAll('.technical-diagram-controls').length,notices:document.querySelectorAll('.technical-diagram-limit').length,svg:document.querySelectorAll('.technical-diagram-viewport svg').length}});
  assert.deepEqual(flood,{controls:16,notices:1,svg:16});checks.push({name:'thousands of fences do not amplify hydration controls or rendering',flood});
  const performance=await page.evaluate(async()=>{const source='flowchart LR\n'+Array.from({length:40},(_,i)=>`N${i}-->N${(i+1)%40}`).join('\n');const first=await window.testing.render([source]);const cached=await window.testing.render([source]);return {first,cached}});
  assert.deepEqual(performance.first.states,['ready']);assert(performance.first.elapsed<5000);checks.push({name:'bounded 40-node cyclic graph and cache measured; no hard timeout promise',performance});
  const dense=await page.evaluate(()=>window.testing.render(['flowchart LR\n'+Array.from({length:80},(_,i)=>`N${Math.floor(i/7)}-->N${(Math.floor(i/7)+1+i%7)%12}`).join(';')]));
  assert.deepEqual(dense.states,['ready']);assert(dense.elapsed<5000);checks.push({name:'80-edge dense graph stays usable in the measured browser run',dense});
  await page.evaluate(fixtures=>window.testing.render(fixtures.slice(0,3),'dark'),fixtures);
  await page.evaluate(()=>{window.testing.root.style.setProperty('--fw-bg','#1e1e1e');window.testing.root.style.setProperty('--fw-text','#eee');document.body.style.background='#1e1e1e';});
  await page.setViewportSize({width:480,height:1000});await page.locator('.technical-diagram-controls button').filter({hasText:'Enlarge'}).first().click();
  assert(await page.evaluate(()=>[...document.querySelectorAll('.technical-diagram')].every(element=>element.getBoundingClientRect().right<=document.documentElement.clientWidth)), 'Diagram cards stay inside the narrow viewport.');
  assert.equal(await page.locator('.technical-diagram-controls button[aria-pressed="true"]').count(),1);await page.screenshot({path:path.join(output,'dark-narrow-enlarged.png'),fullPage:true});
  await page.evaluate(()=>document.body.style.zoom='2');const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth}));assert(overflow.width<=overflow.viewport+2);checks.push({name:'dark/narrow/200 percent zoom has contained horizontal overflow',overflow});await page.screenshot({path:path.join(output,'dark-narrow-200percent.png'),fullPage:true});
  await browser.grantPermissions(['clipboard-read','clipboard-write'],{origin:`http://127.0.0.1:${port}`});await page.getByRole('button',{name:'Copy source'}).first().click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),fixtures[0]);checks.push({name:'source copy preserves original source'});
  await page.reload();await page.waitForFunction(()=>Boolean(window.testing));const restart=await page.evaluate(fixtures=>window.testing.render(fixtures.slice(0,3)),fixtures);assert.deepEqual(restart.states,['ready','ready','ready']);checks.push({name:'fresh page renders all three types from local bundled chunks',restart});
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({checks,external,errors,browser:browser.browser()?.version()},null,2));
  console.log(JSON.stringify({passed:checks.length,output}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
