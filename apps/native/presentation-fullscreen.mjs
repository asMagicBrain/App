/** Wait for AppKit/Chromium to finish resizing before admitting presentation. */
export function transitionPresentationFullscreen(window,fullscreen,{timeout=10000}={}){
 if(window.isDestroyed())return Promise.reject(new Error('The presentation window is closed.'));
 if(window.isFullScreen()===fullscreen)return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const event=fullscreen?'enter-full-screen':'leave-full-screen';
  const cleanup=()=>{clearTimeout(timer);window.removeListener(event,done);window.removeListener('closed',closed);};
  const done=()=>{cleanup();resolve();};
  const closed=()=>{cleanup();reject(new Error('The presentation window is closed.'));};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Native fullscreen did not finish. Try presentation again.'));},timeout);
  window.once(event,done);window.once('closed',closed);
  try{window.setFullScreen(fullscreen);}catch(error){cleanup();reject(error);}
 });
}
