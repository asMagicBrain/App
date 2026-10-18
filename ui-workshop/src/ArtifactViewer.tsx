import {scheduleArtifactFrame} from './artifact-frame.mjs';
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {getNativeBridge, nativeOperation} from './native-bridge.mjs';
import type {ArtifactReview, ArtifactRuntimeState, ArtifactStopCause} from './native-types';
import './artifact-viewer.css';

const artifactMessages: Record<string,string> = {
  ARTIFACT_SCRIPT_ERROR: 'The example reported a script or resource error. Inspect its source and declared assets before running again.',
  ARTIFACT_MISSING_ASSET: 'A declared file is missing.',
  ARTIFACT_UNAVAILABLE: 'The repository is not ready for interactive admission. Check its registration and recovery status.',
  ARTIFACT_INVALID_FILE: 'Use a regular local file, not a link.',
  ARTIFACT_INVALID_POSTER: 'The poster must be a valid PNG or JPEG within the supported dimensions.',
  ARTIFACT_REVIEW_STALE: 'These files changed after review. Close this view and review them again.',
  ARTIFACT_REVIEW_REQUIRED: 'Review the current files before running this view.',
  ARTIFACT_HASH_MISMATCH: 'A file differs from its manifest. Update the manifest before reviewing it again.',
  ARTIFACT_PHYSICAL_CHANGE: 'A file or folder changed while it was being checked. Review it again.',
  ARTIFACT_LIMIT: 'This example exceeds the supported file or size limits.',
  ARTIFACT_INVALID_MANIFEST: 'This interactive manifest is unsupported or incomplete.',
  ARTIFACT_CANCELLED: 'Opening was cancelled. Review the example again to continue.',
  ARTIFACT_INVALID_BOUNDS: 'Enlarge the window to run this view.',
  ARTIFACT_NOT_VISIBLE: 'Scroll the example into view, then run it again.',
  ARTIFACT_GEOMETRY_TIMEOUT: 'The view stopped while the window changed. Run it again when the window is ready.',
  ARTIFACT_GEOMETRY_FAILED: 'The view could not be positioned safely. Its source is still available.',
};
function artifactError(reason: unknown) {
  const error=reason as {code?:string;message?:string};
  const message=artifactMessages[error.code??''] ?? 'This view could not run. Your files remain unchanged; its source is still available.';
  const detail=error.message && error.message !== error.code && error.message !== message ? ` ${error.message}` : '';
  return error.code ? `${message} [${error.code}]${detail}` : error.message ?? message;
}

/** Host-owned review UI. Repository HTML never enters this renderer's DOM. */
export function ArtifactViewer({repository, path, disabled = false, inline = false, caption = '', fallback = ''}: {repository: string; path: string; disabled?: boolean; inline?:boolean;caption?:string;fallback?:string}) {
  const bridge = getNativeBridge();
  const [open,setOpen]=useState(false),[review,setReview]=useState<ArtifactReview|null>(null),[runtime,setRuntime]=useState<ArtifactRuntimeState|null>(null);
  const [posterUrl,setPosterUrl]=useState<string|null>(null);
  useEffect(()=>{if(!review?.poster){setPosterUrl(null);return;}const url=URL.createObjectURL(new Blob([review.poster.data],{type:review.poster.mime}));setPosterUrl(url);return()=>URL.revokeObjectURL(url);},[review]);
  const [expanded,setExpanded]=useState(false);const focusSequence=useRef(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[source,setSource]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),surface=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const sequence=useRef(0),run=useRef<string|null>(null),mounted=useRef(true),openRef=useRef(false),reviewIdRef=useRef<string|null>(null);
  const running=runtime?.state==='running'||runtime?.state==='loading';
  const release=useCallback(async(runId: string|null,reviewId?: string|null,cause:ArtifactStopCause='user-stop')=>{
    if(bridge?.stopArtifact&&(reviewId||runId)) return nativeOperation(()=>bridge.stopArtifact(reviewId?{reviewId,cause}:{runId:runId!,cause}));
  },[bridge]);
  const current=(own: number)=>mounted.current&&own===sequence.current;
  const focusAfterLayout=useCallback((focus:()=>void)=>{const own=sequence.current;scheduleArtifactFrame(()=>{if(mounted.current&&sequence.current===own&&trigger.current?.isConnected&&!trigger.current.closest('[hidden],[inert]'))focus();});},[]);
  const stop=useCallback(async(nextSource?: boolean,cause:ArtifactStopCause=nextSource===undefined?'user-stop':nextSource?'source-switch':'fallback-switch')=>{
    const own=++sequence.current,runId=run.current;run.current=null;setBusy(true);
    try{const value=await release(runId,reviewIdRef.current,cause);if(mounted.current&&own===sequence.current){setRuntime(value??{state:'stopped'});if(nextSource!==undefined)setSource(nextSource);}}
    catch(reason){if(mounted.current&&own===sequence.current)setError(artifactError(reason));}
    finally{if(mounted.current&&own===sequence.current)setBusy(false);}
  },[release]);
  const close=useCallback(()=>{
    sequence.current++;openRef.current=false;const runId=run.current,reviewId=reviewIdRef.current;run.current=null;reviewIdRef.current=null;
    setOpen(false);setExpanded(false);setBusy(false);setRuntime(null);setReview(null);setSource(false);setError('');
    void release(runId,reviewId,'view-close').catch(()=>{});
    if(!trigger.current?.closest('[hidden],[inert]'))trigger.current?.focus();
  },[release]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++;const runId=run.current,reviewId=reviewIdRef.current;run.current=null;reviewIdRef.current=null;void release(runId,reviewId,'view-unmount').catch(()=>{});};},[release]);
  useLayoutEffect(()=>{const node=dialog.current;if(!node)return;node.close();if(open){if(!inline||expanded)node.showModal();else node.show();}},[open,inline,expanded]);
  useLayoutEffect(()=>{if(inline&&!expanded&&(runtime?.focusReturn??0)>0){const lesson=trigger.current?.closest<HTMLElement>('.document-presentation-content');(lesson??trigger.current)?.focus({preventScroll:true});}},[inline,expanded,runtime?.focusReturn]);
  // A retained editor can be hidden by an ancestor; only its own active view is disposed.
  useEffect(()=>{const element=trigger.current?.closest('.fw-window');if(!element)return;const observer=new MutationObserver(()=>{if(openRef.current&&trigger.current?.closest('[hidden],[inert]'))close();});observer.observe(element,{attributes:true,subtree:true,attributeFilter:['hidden','inert']});return()=>observer.disconnect();},[close]);
  useEffect(()=>{if(disabled&&open)close();},[disabled,open,close]);
  const bounds=()=>{const rect=surface.current?.getBoundingClientRect();if(!rect||rect.width<120||rect.height<80)throw Object.assign(new Error('ARTIFACT_INVALID_BOUNDS'),{code:'ARTIFACT_INVALID_BOUNDS'});const top=Math.max(40,rect.top),bottom=Math.min(window.innerHeight,rect.bottom);if(bottom-top<80)throw Object.assign(new Error('ARTIFACT_NOT_VISIBLE'),{code:'ARTIFACT_NOT_VISIBLE'});return{x:Math.round(Math.max(0,rect.left)),y:Math.round(top),width:Math.floor(Math.min(window.innerWidth,rect.right)-Math.max(0,rect.left)),height:Math.floor(bottom-top)};};
  const prepare=async()=>{
    if(!bridge?.reviewArtifact)return;const own=++sequence.current;openRef.current=true;
    setBusy(true);setError('');setSource(false);setRuntime(null);setReview(null);setOpen(true);focusSequence.current=0;
    try{const result=await nativeOperation(()=>bridge.reviewArtifact({repo:repository,path,ref:''}));if(current(own)){reviewIdRef.current=result.reviewId;setReview(result);}}
    catch(reason){if(current(own))setError(artifactError(reason));}finally{if(current(own))setBusy(false);}
  };
  const start=async(reset=false)=>{
    if(!bridge||!review)return;const own=++sequence.current;setBusy(true);setError('');setSource(false);
    try{if(inline&&!expanded){surface.current?.scrollIntoView({block:'center',behavior:'instant'});await new Promise<void>(resolve=>scheduleArtifactFrame(resolve));}if(!current(own)||!openRef.current)return;const value=await nativeOperation(()=>reset?bridge.resetArtifact({reviewId:review.reviewId,runId:run.current??undefined,approved:true,bounds:bounds(),inline,presentation:!!surface.current?.closest('.document-presentation')}):bridge.runArtifact({reviewId:review.reviewId,approved:true,bounds:bounds(),inline,presentation:!!surface.current?.closest('.document-presentation')}));
      if(!current(own)){await release(value.runId??null,undefined,'request-superseded');return;}
      run.current=value.runId??null;setRuntime(value);
    }catch(reason){if(current(own)){const oldRun=run.current;run.current=null;const value=await release(oldRun,review.reviewId).catch(()=>null);if(current(own)){setRuntime(value?.state==='failed'?value:null);setError(artifactError(reason));}}}
    finally{if(current(own))setBusy(false);}
  };
  useEffect(()=>{
    if(!running||!bridge)return;
    let active=true,frame:null|(()=>void)=null,inFlight=false,dirty=false;const own=sequence.current,runId=run.current;
    const valid=()=>active&&mounted.current&&own===sequence.current&&runId===run.current;
    const accept=(value: ArtifactRuntimeState)=>{
      if(!valid()||value.runId&&value.runId!==runId)return;
      if(inline&&(value.focusReturn??0)>focusSequence.current){focusSequence.current=value.focusReturn??0;setExpanded(false);focusAfterLayout(()=>{trigger.current?.focus({preventScroll:true});const lesson=trigger.current?.closest<HTMLElement>('.document-presentation-content');lesson?.focus({preventScroll:true});});}
      setRuntime(value);if(value.state!=='running'&&value.state!=='loading')run.current=null;
      if(value.errorCode)setError(artifactError({code:value.errorCode}));
    };
    const failed=async(reason: unknown)=>{
      if(!valid())return;
      // The host preserves the original runtime failure when a later cleanup
      // Stop arrives. Transport failures remain explicit rather than silently
      // turning into an unexplained ordinary stopped state.
      const stoppedSequence=sequence.current+1;await stop(undefined,'transport-failure');if(mounted.current&&sequence.current===stoppedSequence)setError(artifactError(reason));
    };
    const schedule=()=>{
      dirty=true;if(!valid()||frame||inFlight)return;
      frame=scheduleArtifactFrame(()=>{frame=null;void update();});
    };
    const update=async()=>{
      if(!valid()||!runId||inFlight)return;inFlight=true;dirty=false;
      try{
        const rect=surface.current?.getBoundingClientRect();const owner=surface.current?.closest<HTMLElement>('.document-presentation-content,.fw-file-body,.fw-file-content');const limit=expanded?undefined:owner?.getBoundingClientRect();const top=Math.max(40,limit?.top??0),bottom=Math.min(window.innerHeight,limit?.bottom??window.innerHeight);const visible=!!rect&&rect.width>=120&&Math.min(rect.bottom,bottom)-Math.max(rect.top,top)>=80;
        const area=rect?{x:Math.round(Math.max(0,rect.left)),y:Math.round(Math.max(top,rect.top)),width:Math.floor(Math.min(rect.right,window.innerWidth)-Math.max(0,rect.left)),height:Math.floor(Math.min(rect.bottom,bottom)-Math.max(top,rect.top))}:bounds();
        const value=await nativeOperation(()=>bridge.resizeArtifact({runId,bounds:visible?area:{x:0,y:40,width:120,height:80},visible,viewport:{width:window.innerWidth,height:window.innerHeight}}));
        accept(value);if(valid()&&value.geometryPending)dirty=true;
      }catch(reason){await failed(reason);}
      finally{inFlight=false;if(valid()&&dirty)schedule();}
    };
    const resize=new ResizeObserver(schedule);if(surface.current)resize.observe(surface.current);window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);schedule();
    const unsubscribe=bridge.onArtifactState?.(accept);
    const interval=setInterval(()=>{void bridge.artifactStatus().then(value=>{
      accept(value);if(valid()&&value.geometryPending)schedule();
    }).catch(reason=>{void failed(reason);});},500);
    return()=>{active=false;frame?.();resize.disconnect();unsubscribe?.();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);clearInterval(interval);};
  },[running,runtime?.runId,bridge,stop,inline,expanded,focusAfterLayout]);
  return <div className={inline?"artifact-inline":"artifact-entry"} data-presentation-interactive={inline?"true":undefined} onKeyDown={event=>{if(!inline)return;if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();if(expanded)setExpanded(false);else close();focusAfterLayout(()=>trigger.current?.closest<HTMLElement>(".document-presentation-content")?.focus({preventScroll:true}));}else if(event.key!=="Escape")event.stopPropagation();}}><button ref={trigger} type="button" disabled={disabled||busy||!bridge?.reviewArtifact} onClick={()=>void prepare()}>{inline?"Open interactive example":"Review interactive view"}</button>{inline&&caption&&<p className="artifact-caption">{caption}</p>}{inline&&!open&&fallback&&<p className="artifact-fallback">{fallback}</p>}{!bridge?.reviewArtifact&&<span>Interactive execution is available in the native application.</span>}
    <dialog ref={dialog} className={`artifact-dialog ${inline?"artifact-inline-dialog":""} ${expanded?"artifact-expanded":""}`} aria-label={caption||review?.title||"Interactive view"} onCancel={event=>{event.preventDefault();if(inline&&expanded){setExpanded(false);focusAfterLayout(()=>trigger.current?.focus({preventScroll:true}));}else close();}}>
      <header><div><h2>{review?.title??'Interactive view'}</h2><p>{path}</p></div>{inline&&<button onClick={()=>setExpanded(value=>!value)}>{expanded?"Return inline":"Expand example"}</button>}<button aria-label="Close interactive view" onClick={close}>Close</button></header>
      {error&&<p className="artifact-error" role="alert">{error}</p>}
      {!review?<p role="status">{busy?'Checking local files…':'Review stopped. Close this dialog to inspect the source and correct the reported problem.'}</p>:<>
        {review.warnings?.map((warning,index)=><p key={index} className="artifact-error">{warning}</p>)}
        <div className="artifact-actions"><span role="status">{running?runtime?.geometryPending?'Preparing display…':runtime?.surfaceVisible===false?'Scroll to view':'Running locally':runtime?.state==='failed'?'Stopped after a runtime error':source?'Source':runtime?.state==='stopped'?'Stopped':'Ready for review'}</span>
          {running?<><button disabled={busy} onClick={()=>void stop()}>Stop</button><button disabled={busy} onClick={()=>void start(true)}>Reset</button></>:<button disabled={busy} onClick={()=>void start()}>{busy?'Starting…':'Run interactive view'}</button>}
          <button disabled={busy} onClick={()=>void stop(true)}>Source</button><button disabled={busy} onClick={()=>void stop(false)}>Static fallback</button></div>
        {!running&&runtime?.lastStop&&<details className="artifact-stop-details"><summary>Why did this stop?</summary><p>{({'owner-hidden':'The application window was hidden.','owner-minimized':'The application window was minimized.','user-stop':'The Stop action was requested.','view-close':'The interactive view was closed.','view-unmount':'The document or presentation page changed.','source-switch':'Source view was selected.','fallback-switch':'Static fallback was selected.','transport-failure':'Communication with the native view failed.','request-superseded':'A newer view request replaced this one.'} as Record<string,string>)[runtime.lastStop.cause]??'The native runtime ended this view.'} Run again to restart the example.</p><pre>{JSON.stringify(runtime.lastStop,null,2)}</pre></details>}
        <div className="artifact-surface" ref={surface} aria-label="Interactive content area">
          {!running&&<div className="artifact-reading">{source?<><h3>{review.entryPath}</h3><pre>{review.source}</pre></>:<><h3>Run this local content?</h3><p>Only the listed files can be read. Network, account access, filesystem access, downloads and popups are blocked. Stop or close the view at any time.</p><p>Reset restarts the example, including its controls. It does not change your files.</p><details><summary>Reviewed files and identity</summary><p className="artifact-hash">{review.digest}</p><ul>{review.assets.map(asset=><li key={asset.path}><strong>{asset.path}</strong> · {asset.bytes} bytes<code>{asset.sha256}</code></li>)}</ul></details><h3>Static fallback</h3>{posterUrl&&<img className="artifact-poster" src={posterUrl} alt={`${review.title} — static illustration`}/>}<pre>{review.fallback}</pre></>}</div>}
        </div>
        <footer><span>One view at a time · Offline · Stops after 10 minutes</span><button onClick={close}>Keep reading</button></footer>
      </>}
    </dialog>
  </div>;
}
