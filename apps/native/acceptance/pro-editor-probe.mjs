/** Read-only CDP observation and ordinary input for an explicitly activated
 * unprivileged artifact target. This is a test process, never an app bridge.
 */
export async function createArtifactProbe(page) {
  const browser = page.context().browser();
  // Playwright Electron exposes its persistent context without a client-side
  // Browser in some releases. The ordinary page CDP session also exposes Target.
  const transport = browser ? await browser.newBrowserCDPSession() : await page.context().newCDPSession(page);
  let sequence = 0;
  const pending = new Map();
  const contexts = new Map();
  const requests = [];
  transport.on('Target.receivedMessageFromTarget', ({sessionId, message}) => {
    const event = JSON.parse(message);
    if (event.id) {
      const key = sessionId + ':' + event.id, request = pending.get(key);
      if (request) { clearTimeout(request.timer); pending.delete(key); event.error ? request.reject(new Error(JSON.stringify(event.error))) : request.resolve(event.result); }
    }
    if (event.method === 'Runtime.executionContextCreated') contexts.set(sessionId + ':' + event.params.context.id, event.params.context);
    if (event.method === 'Runtime.executionContextDestroyed') contexts.delete(sessionId + ':' + event.params.executionContextId);
    if (event.method === 'Runtime.executionContextsCleared') for (const key of contexts.keys()) if (key.startsWith(sessionId + ':')) contexts.delete(key);
    if (event.method === 'Network.requestWillBeSent') requests.push({sessionId, url: event.params.request.url, type: event.params.type});
  });
  async function targets() { return (await transport.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page' && info.url.startsWith('asmb-artifact:')); }
  async function attach(targetId) {
    const {sessionId} = await transport.send('Target.attachToTarget', {targetId, flatten: false});
    const send = (method, params = {}) => {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const key = sessionId + ':' + id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error('Artifact CDP timeout: ' + method)); }, 20000);
        pending.set(key, {resolve, reject, timer});
        transport.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(error => {clearTimeout(timer); pending.delete(key); reject(error);});
      });
    };
    await send('Runtime.enable'); await send('Network.enable'); await send('Performance.enable');
    async function evaluate(expression, {contextId} = {}) {
      const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, ...(contextId ? {contextId} : {})});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function click(selector) {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await send('Input.dispatchMouseEvent', {...point,type:'mousePressed',button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent', {...point,type:'mouseReleased',button:'left',clickCount:1});
    }
    async function key(key, code, windowsVirtualKeyCode) {
      for (const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent', {type,key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode});
    }
    return {send, evaluate, click, key, metrics: async () => ({heap:await send('Runtime.getHeapUsage'),performance:await send('Performance.getMetrics'),contexts:[...contexts].filter(([key])=>key.startsWith(sessionId+':')).map(([,value])=>({id:value.id,origin:value.origin,isDefault:value.auxData?.isDefault}))}),
      detach: async () => { await transport.send('Target.detachFromTarget', {sessionId}).catch(()=>{}); for (const key of contexts.keys()) if(key.startsWith(sessionId+':'))contexts.delete(key); }};
  }
  return {targets,attach,requests,dispose:async()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Probe disposed'));}pending.clear();await transport.detach();}};
}
