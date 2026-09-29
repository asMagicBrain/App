/** Synthetic qualification packages. Creating these files never executes them.
 * Original tester HTML is copied byte-for-byte from an explicitly supplied
 * reproduction directory; this module does not download or launch content.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fallback = '# Static fallback\n\nThis offline synthetic artifact is safe to read without running its scripts. Use Source to inspect the approved HTML.\n';
const html = (title, body, script) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}<script>${script}</script></body></html>\n`;

export async function writeArtifact(directory, {id, title, entry = 'index.html', poster, files}) {
  await fs.mkdir(directory, {recursive: true});
  const assets = [];
  for (const [name, value] of Object.entries({...files, 'fallback.md': fallback})) {
    assert.ok(!name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.'));
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await fs.mkdir(path.dirname(path.join(directory, name)), {recursive: true});
    await fs.writeFile(path.join(directory, name), bytes);
    assets.push({path: name, sha256: hash(bytes), bytes: bytes.length,
      role: name === entry ? 'entry' : name === 'fallback.md' ? 'fallback' : /\.m?js$/.test(name) ? 'script' : /\.css$/.test(name) ? 'style' : 'data'});
  }
  const manifest = {schemaVersion: 1, id, title, entryPath: entry, fallbackPath: 'fallback.md', network: 'none', assets};
  if (poster) manifest.posterPath = poster;
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'view.artifact.json'), bytes);
  return {id, title, manifestPath: path.join(directory, 'view.artifact.json'), sha256: hash(bytes), assets};
}

/** Controlled endpoints belong to the acceptance process, never a public host. */
export function hostileFixture({httpPort, udpPort}) {
  assert.ok(Number.isSafeInteger(httpPort) && httpPort > 0 && httpPort < 65536);
  assert.ok(Number.isSafeInteger(udpPort) && udpPort > 0 && udpPort < 65536);
  return html('Adversarial offline artifact', '<pre id="results" aria-live="polite">Starting</pre><button id="permission">Request permission</button><button id="popup">Open popup</button><a id="download" download="denied.txt" href="data:text/plain,synthetic">Download dummy data</a>', `
  const result = {process: typeof process, require: typeof require, bridge: typeof window.asMagicBrain,
    electron: typeof window.electron, rtc: typeof RTCPeerConnection, webkitRtc: typeof webkitRTCPeerConnection,
    worker: 'not attempted', requests: {}, violations: [], popup: 'not attempted', parent: 'not attempted'};
  const show = () => { document.getElementById('results').textContent = JSON.stringify(result); };
  window.addEventListener('securitypolicyviolation', e => { result.violations.push({directive:e.effectiveDirective, blocked:e.blockedURI}); show(); });
  try { result.parent = {same: parent === window, bridge: typeof parent.asMagicBrain, process: typeof parent.process}; }
  catch(e) { result.parent = e.name; }
  const attempt = (name, operation) => Promise.resolve().then(operation).then(() => {result.requests[name]='ALLOWED'; show();}, e => {result.requests[name]=e.name; show();});
  attempt('http', () => fetch('http://127.0.0.1:${httpPort}/fetch'));
  attempt('file', () => fetch('file:///tmp/asmb-synthetic-secret'));
  attempt('app', () => fetch('app://asmagicbrain/index.html'));
  attempt('unknown-local', () => fetch('./unlisted.txt'));
  try { const w = new WebSocket('ws://127.0.0.1:${httpPort}/socket'); w.onopen=()=>{result.requests.ws='ALLOWED';show();w.close();};w.onerror=()=>{result.requests.ws='denied';show();}; } catch(e) { result.requests.ws=e.name; }
  try { const image = new Image(); image.onload=()=>{result.requests.image='ALLOWED';show();};image.onerror=()=>{result.requests.image='denied';show();}; image.src='http://127.0.0.1:${httpPort}/image';document.body.append(image); } catch(e) { result.requests.image=e.name; }
  try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage("ALLOWED")'],{type:'text/javascript'}))); result.worker='created';w.onmessage=e=>{result.worker=e.data;show();w.terminate();};w.onerror=()=>{result.worker='denied';show();}; } catch(e) { result.worker=e.name; }
  try { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]}); p.createDataChannel('dummy');p.createOffer().then(d=>p.setLocalDescription(d));result.rtcCreated=true;setTimeout(()=>p.close(),600); } catch(e) { result.rtcCreated=e.name; }
  const frame = document.createElement('iframe'); frame.src='about:blank';document.body.append(frame);
  setTimeout(()=>{try{result.frameRTC=typeof frame.contentWindow.RTCPeerConnection;
    if(typeof frame.contentWindow.RTCPeerConnection==='function'){const p=new frame.contentWindow.RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});p.createDataChannel('dummy');p.createOffer().then(d=>p.setLocalDescription(d));result.frameRTCCreated=true;setTimeout(()=>p.close(),600);}
  }catch(e){result.frameRTC=e.name;}show();},100);
  document.getElementById('permission').onclick=()=>attempt('geolocation',()=>new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{timeout:400})));
  document.getElementById('popup').onclick=()=>{try{result.popup=window.open('http://127.0.0.1:${httpPort}/popup')?'ALLOWED':'denied';}catch(e){result.popup=e.name;}show();};
  show(); setTimeout(()=>{result.finished=true;show();},1000);
  `);
}

export async function createProEditorFixtures({output, reproductionDirectory, httpPort, udpPort}) {
  await fs.mkdir(output, {recursive: true});
  const original = name => fs.readFile(path.join(reproductionDirectory, 'interactive', name));
  const results = [];
  for (const kind of ['slider', 'frames', 'webgl']) {
    const files = {[kind + '.html']: await original(kind + '.html')};
    if (kind === 'frames') files['poster.png'] = await original('poster.png');
    results.push(await writeArtifact(path.join(output, kind), {id: 'qualification.' + kind, title: 'Offline ' + kind, entry: kind + '.html', poster: kind === 'frames' ? 'poster.png' : undefined, files}));
  }
  results.push(await writeArtifact(path.join(output, 'hostile'), {id: 'qualification.hostile', title: 'Denied capabilities', files: {'index.html': hostileFixture({httpPort, udpPort})}}));
  results.push(await writeArtifact(path.join(output, 'busy'), {id:'qualification.busy',title:'Host-controlled stop',files:{'index.html':html('Host-controlled stop','<button id="busy">Start busy loop</button><p>Use the application Stop button to dispose this deliberately busy synthetic renderer.</p>',"document.getElementById('busy').onclick=()=>setTimeout(()=>{for(;;){}},75);")}}));
  results.push(await writeArtifact(path.join(output, 'delayed'), {id:'qualification.delayed',title:'Loading cancellation',files:{'index.html':html('Loading cancellation','<p>This synthetic fixture delays its initial load for two seconds.</p>',"const deadline=performance.now()+2000;while(performance.now()<deadline){}")}}));
  results.push(await writeArtifact(path.join(output, 'modules'), {id: 'qualification.modules', title: 'Local module and texture probe', files: {
    'index.html': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Module and texture</title><h1>Local module and texture</h1><canvas id="scene" width="200" height="200"></canvas><output id="result">Not started</output><script type="module" src="./scene.mjs"></script></html>\n',
    'scene.mjs': `import {paint} from './texture.mjs'; const status=document.getElementById('result'); paint(document.getElementById('scene'), new URL('./texture.png',import.meta.url)).then(()=>status.value='Local module and texture ready', e=>status.value='Unavailable: '+e.name);\n`,
    'texture.mjs': `export async function paint(canvas,url){const image=new Image();image.crossOrigin='anonymous';image.src=url;await image.decode();const gl=canvas.getContext('webgl2');if(!gl)throw Error('WebGL2 unavailable');
      const shader=(kind,source)=>{const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('Shader compile failed');return s;};
      const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\\nin vec2 position;out vec2 uv;void main(){uv=(position+1.0)/2.0;gl_Position=vec4(position,0.0,1.0);}'));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision mediump float;in vec2 uv;uniform sampler2D picture;out vec4 color;void main(){color=texture(picture,uv);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Program link failed');gl.useProgram(program);
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const attribute=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
      const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.uniform1i(gl.getUniformLocation(program,'picture'),0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);if(gl.getError()!==gl.NO_ERROR)throw Error('Texture rendering rejected');}\n`,
    'texture.png': await original('poster.png'),
  }}));
  const source = '# Pro Editor qualification\n\nRaw source Ω remains authoritative.\n\nInline math $x^2=1$.\n\n$$\nE=mc^2\n$$\n\n```mermaid\nflowchart LR\nA[Source]-->B[Preview]\n```\n\n'
    + results.map(item => `[${item.title}](${item.id.slice('qualification.'.length)}/view.artifact.json)`).join('\n\n') + '\n';
  await fs.writeFile(path.join(output, 'README.md'), source);
  await fs.writeFile(path.join(output, 'untouched.md'), '# Unselected file\n\nPreserve these bytes. Ω\n');
  await fs.writeFile(path.join(output, 'fixture-manifest.json'), JSON.stringify({schema:1, originals:'Exact bytes from reviewed reproduction supplied by test runner', packages: results.map(({manifestPath,...item})=>({...item,manifestPath:path.relative(output,manifestPath)}))}, null, 2)+'\n');
  return {source, packages: results};
}
