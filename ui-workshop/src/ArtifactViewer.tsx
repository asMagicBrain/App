import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {getNativeBridge, nativeOperation} from './native-bridge.mjs';
import type {ArtifactReview, ArtifactRuntimeState} from './native-types';
import './artifact-viewer.css';

const artifactMessages: Record<string,string> = {
  ARTIFACT_REVIEW_STALE: 'These files changed after review. Close this view and review them again.',
  ARTIFACT_REVIEW_REQUIRED: 'Review the current files before running this view.',
  ARTIFACT_HASH_MISMATCH: 'A file differs from its manifest. Update the manifest before reviewing it again.',
  ARTIFACT_PHYSICAL_CHANGE: 'A file or folder changed while it was being checked. Review it again.',
  ARTIFACT_LIMIT: 'This example exceeds the supported file or size limits.',
  ARTIFACT_INVALID_MANIFEST: 'This interactive manifest is unsupported or incomplete.',
  ARTIFACT_CANCELLED: 'Opening was cancelled. Review the example again to continue.',
  ARTIFACT_INVALID_BOUNDS: 'Enlarge the window to run this view.',
  ARTIFACT_GEOMETRY_TIMEOUT: 'The view stopped while the window changed. Run it again when the window is ready.',
  ARTIFACT_GEOMETRY_FAILED: 'The view could not be positioned safely. Its source is still available.',
};
function artifactError(reason: unknown) {
  const error=reason as {code?:string;message?:string};
  return artifactMessages[error.code??''] ?? (error.code ? 'This view could not run. Your files remain unchanged; its source is still available.' : error.message??'The view could not run.');
}

/** Host-owned review UI. Repository HTML never enters this renderer's DOM. */
export function ArtifactViewer({repository, path, disabled = false}: {repository: string; path: string; disabled?: boolean}) {
  const bridge = getNativeBridge();
  const [open,setOpen]=useState(false),[review,setReview]=useState<ArtifactReview|null>(null),[runtime,setRuntime]=useState<ArtifactRuntimeState|null>(null);
  const [posterUrl,setPosterUrl]=useState<string|null>(null);
  useEffect(()=>{if(!review?.poster){setPosterUrl(null);return;}const url=URL.createObjectURL(new Blob([review.poster.data],{type:review.poster.mime}));setPosterUrl(url);return()=>URL.revokeObjectURL(url);},[review]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[source,setSource]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),surface=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const sequence=useRef(0),run=useRef<string|null>(null),mounted=useRef(true),openRef=useRef(false),reviewIdRef=useRef<string|null>(null);
  const running=runtime?.state==='running'||runtime?.state==='loading';
  const release=useCallback(async(runId: string|null,reviewId?: string|null)=>{
    if(bridge?.stopArtifact&&(reviewId||runId)) return nativeOperation(()=>bridge.stopArtifact(reviewId?{reviewId}:{runId:runId!}));
  },[bridge]);
  const current=(own: number)=>mounted.current&&own===sequence.current;
  const stop=useCallback(async(nextSource?: boolean)=>{
    const own=++sequence.current,runId=run.current;run.current=null;setBusy(true);
    try{const value=await release(runId,reviewIdRef.current);if(mounted.current&&own===sequence.current){setRuntime(value??{state:'stopped'});if(nextSource!==undefined)setSource(nextSource);}}
    catch(reason){if(mounted.current&&own===sequence.current)setError(artifactError(reason));}
    finally{if(mounted.current&&own===sequence.current)setBusy(false);}
  },[release]);
  const close=useCallback(()=>{
    sequence.current++;openRef.current=false;const runId=run.current,reviewId=reviewIdRef.current;run.current=null;reviewIdRef.current=null;
    setOpen(false);setBusy(false);setRuntime(null);setReview(null);setSource(false);setError('');
    void release(runId,reviewId).catch(()=>{});
    if(!trigger.current?.closest('[hidden],[inert]'))trigger.current?.focus();
  },[release]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++;const runId=run.current,reviewId=reviewIdRef.current;run.current=null;reviewIdRef.current=null;void release(runId,reviewId).catch(()=>{});};},[release]);
  useLayoutEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
  // A retained editor can be hidden by an ancestor; only its own active view is disposed.
  useEffect(()=>{const element=trigger.current?.closest('.fw-window');if(!element)return;const observer=new MutationObserver(()=>{if(openRef.current&&trigger.current?.closest('[hidden],[inert]'))close();});observer.observe(element,{attributes:true,subtree:true,attributeFilter:['hidden','inert']});return()=>observer.disconnect();},[close]);
  useEffect(()=>{if(disabled&&open)close();},[disabled,open,close]);
  const bounds=()=>{const rect=surface.current?.getBoundingClientRect();if(!rect||rect.width<120||rect.height<80)throw Error('Enlarge the window to run this view.');return{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.floor(rect.width),height:Math.floor(rect.height)};};
  const prepare=async()=>{
    if(!bridge?.reviewArtifact)return;const own=++sequence.current;openRef.current=true;
    setBusy(true);setError('');setSource(false);setRuntime(null);setReview(null);setOpen(true);
    try{const result=await nativeOperation(()=>bridge.reviewArtifact({repo:repository,path,ref:''}));if(current(own)){reviewIdRef.current=result.reviewId;setReview(result);}}
    catch(reason){if(current(own))setError(artifactError(reason));}finally{if(current(own))setBusy(false);}
  };
  const start=async(reset=false)=>{
    if(!bridge||!review)return;const own=++sequence.current;setBusy(true);setError('');setSource(false);
    try{const value=await nativeOperation(()=>reset?bridge.resetArtifact({reviewId:review.reviewId,runId:run.current??undefined,approved:true,bounds:bounds()}):bridge.runArtifact({reviewId:review.reviewId,approved:true,bounds:bounds()}));
      if(!current(own)){await release(value.runId??null);return;}
      run.current=value.runId??null;setRuntime(value);
    }catch(reason){if(current(own)){const oldRun=run.current;run.current=null;await release(oldRun,review.reviewId).catch(()=>{});if(current(own)){setRuntime(null);setError(artifactError(reason));}}}
    finally{if(current(own))setBusy(false);}
  };
  useEffect(()=>{
    if(!running||!bridge)return;
    let active=true,frame=0,inFlight=false,dirty=false;const own=sequence.current,runId=run.current;
    const valid=()=>active&&mounted.current&&own===sequence.current&&runId===run.current;
    const accept=(value: ArtifactRuntimeState)=>{
      if(!valid()||value.runId&&value.runId!==runId)return;
      setRuntime(value);if(value.state!=='running'&&value.state!=='loading')run.current=null;
      if(value.errorCode)setError(artifactError({code:value.errorCode}));
    };
    const failed=async(reason: unknown)=>{
      if(!valid())return;
      // The host preserves the original runtime failure when a later cleanup
      // Stop arrives. Transport failures remain explicit rather than silently
      // turning into an unexplained ordinary stopped state.
      const stoppedSequence=sequence.current+1;await stop();if(mounted.current&&sequence.current===stoppedSequence)setError(artifactError(reason));
    };
    const schedule=()=>{
      dirty=true;if(!valid()||frame||inFlight)return;
      frame=requestAnimationFrame(()=>{frame=0;void update();});
    };
    const update=async()=>{
      if(!valid()||!runId||inFlight)return;inFlight=true;dirty=false;
      try{
        const value=await nativeOperation(()=>bridge.resizeArtifact({runId,bounds:bounds(),viewport:{width:window.innerWidth,height:window.innerHeight}}));
        accept(value);if(valid()&&value.geometryPending)dirty=true;
      }catch(reason){await failed(reason);}
      finally{inFlight=false;if(valid()&&dirty)schedule();}
    };
    const resize=new ResizeObserver(schedule);if(surface.current)resize.observe(surface.current);window.addEventListener('resize',schedule);schedule();
    const interval=setInterval(()=>{void bridge.artifactStatus().then(value=>{
      accept(value);if(valid()&&value.geometryPending)schedule();
    }).catch(reason=>{void failed(reason);});},500);
    return()=>{active=false;cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('resize',schedule);clearInterval(interval);};
  },[running,runtime?.runId,bridge,stop]);
  return <div className="artifact-entry"><button ref={trigger} type="button" disabled={disabled||busy||!bridge?.reviewArtifact} onClick={()=>void prepare()}>Review interactive view</button>{!bridge?.reviewArtifact&&<span>Interactive execution is available in the native application.</span>}
    <dialog ref={dialog} className="artifact-dialog" aria-labelledby="artifact-title" onCancel={event=>{event.preventDefault();close();}}>
      <header><div><h2 id="artifact-title">{review?.title??'Interactive view'}</h2><p>{path}</p></div><button aria-label="Close interactive view" onClick={close}>Close</button></header>
      {error&&<p className="artifact-error" role="alert">{error}</p>}
      {!review?<p role="status">{busy?'Checking local files…':'The view could not be reviewed. Its source remains available.'}</p>:<>
        <div className="artifact-actions"><span role="status">{running?'Running locally':runtime?.state==='failed'?'Stopped after a runtime error':source?'Source':runtime?.state==='stopped'?'Stopped':'Ready for review'}</span>
          {running?<><button disabled={busy} onClick={()=>void stop()}>Stop</button><button disabled={busy} onClick={()=>void start(true)}>Reset</button></>:<button disabled={busy} onClick={()=>void start()}>{busy?'Starting…':'Run interactive view'}</button>}
          <button disabled={busy} onClick={()=>void stop(true)}>Source</button><button disabled={busy} onClick={()=>void stop(false)}>Static fallback</button></div>
        <div className="artifact-surface" ref={surface} aria-label="Interactive content area">
          {!running&&<div className="artifact-reading">{source?<><h3>{review.entryPath}</h3><pre>{review.source}</pre></>:<><h3>Run this local content?</h3><p>Only the listed files can be read. Network, account access, filesystem access, downloads and popups are blocked. Stop or close the view at any time.</p><p>Reset restarts the example, including its controls. It does not change your files.</p><details><summary>Reviewed files and identity</summary><p className="artifact-hash">{review.digest}</p><ul>{review.assets.map(asset=><li key={asset.path}><strong>{asset.path}</strong> · {asset.bytes} bytes<code>{asset.sha256}</code></li>)}</ul></details><h3>Static fallback</h3>{posterUrl&&<img className="artifact-poster" src={posterUrl} alt={`${review.title} — static illustration`}/>}<pre>{review.fallback}</pre></>}</div>}
        </div>
        <footer><span>One view at a time · Offline · Stops after 10 minutes</span><button onClick={close}>Keep reading</button></footer>
      </>}
    </dialog>
  </div>;
}
