/** The native bridge is an explicit adapter; Storybook keeps its own HTTP transport. */
const adapters = new WeakMap();
const replyMethods = ['configureAutomation','getAutomationStatus','approveAutomation','cancelAutomation','packageStatus','reviewPackageBase','registerPackageBase','reviewPackageUpdate','applyPackageUpdate','recoverPackageUpdate','rollbackPackageUpdate','reviewPackageExport','cancelPackagePlan','savePackageExport','getReadingEvidence','getReadingReference','resolveReadingReference','readingHistory','reviewArtifact','runArtifact','resizeArtifact','stopArtifact','resetArtifact','artifactStatus','catalog','read','readAsset','revealItem','bootstrap','request','importArchive','createRepository','cloneRepository','getCloneProgress','cancelClone','getGitHubConnection','startGitHubConnection','pollGitHubConnection','cancelGitHubConnection','cancelPendingGitHubConnection','openGitHubVerification','disconnectGitHub','getApplicationAccount','startApplicationSignIn','pollApplicationSignIn','verifyApplicationEmail','cancelApplicationSignIn','cancelPendingApplicationSignIn','refreshApplicationAccount','updateApplicationProfile','signOutApplicationAccount','getRepositoryUpdates','checkRepositoryUpdates','getRepositoryUpdateProgress','cancelRepositoryUpdate','readRepositoryUpdateFile','reviewRepositoryUpdate','applyRepositoryUpdate','getRepositoryApplyProgress','renameRepository','duplicateRepository','trashRepository','listTrashedRepositories','restoreRepository','prepareExternalFiles','pickExternalFiles','importExternalFiles','cancelExternalFiles','getRepositoryPins','setRepositoryPinned','listRepositoryFiles','searchRepositoryText','cancelRepositorySearch','getBuildConfiguration','getAppearance','setAppearance','windowAction'];
function unwrapReply(reply) {
  if(reply&&typeof reply==='object'&&reply.ok===true)return reply.value;
  if(reply&&typeof reply==='object'&&reply.ok===false&&typeof reply.error?.code==='string'&&typeof reply.error?.message==='string')throw Object.assign(new Error(reply.error.message),{code:reply.error.code});
  throw Object.assign(new Error('The native operation returned an invalid response.'),{code:'NATIVE_RESPONSE_INVALID'});
}
/** @returns {import('./native-types').NativeBridge | undefined} */
export function getNativeBridge() {
  const bridge = globalThis.window?.asMagicBrain;
  if(bridge?.native!==true)return undefined;
  // Unversioned in-process adapters remain useful to explicit test/HTTP seams.
  // The Electron preload always advertises version 1 and uses plain replies.
  if(bridge.responseVersion===undefined)return /** @type {unknown} */(bridge);
  if(bridge.responseVersion!==1)throw Object.assign(new Error('The native bridge version is unsupported.'),{code:'NATIVE_RESPONSE_INVALID'});
  let adapter=adapters.get(bridge);
  if(!adapter){
    adapter={native:true,nativeWindowControls:bridge.nativeWindowControls===true,onPrepareClose:callback=>bridge.onPrepareClose(callback),closeReady:input=>bridge.closeReady(input)};
    for(const method of replyMethods)if(typeof bridge[method]==='function')adapter[method]=async(...args)=>unwrapReply(await bridge[method](...args));
    Object.freeze(adapter);adapters.set(bridge,adapter);
  }
  return adapter;
}

const pending = new Set();
let closing = false;
export const isNativeClosing = () => closing;
export const setNativeClosing = value => {closing = value;};

/**
 * Track the complete renderer operation, including preparation before IPC.
 * @template T
 * @param {() => T | Promise<T>} action
 * @returns {Promise<T>}
 */
export function nativeOperation(action) {
  const operation = Promise.resolve().then(action);
  pending.add(operation);
  operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
}

export async function waitForNativeOperations() {
  // This is a lifetime drain, not a second error consumer. Each request reports
  // its own failure; nested failures may already be handled by the enclosing
  // operation. Wait for its cleanup too. Close separately awaits appearance
  // persistence and the editor's draft/filename preservation checks.
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * IPC is not cancellable; stale responses are rejected before they reach the UI.
 * @param {{repo:string,path?:string,ref?:string}} input
 * @param {AbortSignal | undefined} [signal]
 * @param {typeof fetch | undefined} [transport]
 * @returns {Promise<any>}
 */
export async function readRepository({repo, path = '', ref = ''}, signal, transport) {
  const aborted = () => {if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');};
  aborted();
  const bridge = transport ? undefined : getNativeBridge();
  let value;
  if (bridge) value = await nativeOperation(() => bridge.read({repo, path, ref}));
  else {
    const response = await (transport ?? fetch)(`/__local-repositories?${new URLSearchParams({repo, path, ref})}`, {signal});
    if (!response.ok) throw new Error('This repository path is unavailable.');
    value = await response.json();
  }
  aborted();
  return value;
}

/**
 * Native-only read-only media; no implicit HTTP or remote URL fallback.
 * @param {{repo:string,path:string,ref?:string}} input
 * @param {AbortSignal | undefined} [signal]
 * @returns {Promise<import('./native-types').NativeRepositoryAsset>}
 */
export async function readRepositoryAsset({repo,path,ref=''},signal) {
  const aborted=()=>{if(signal?.aborted)throw new DOMException('Request aborted','AbortError');};
  aborted();
  const bridge=getNativeBridge();
  if(!bridge?.readAsset)throw Object.assign(new Error('Local media preview requires the current native application.'),{code:'ASSET_UNAVAILABLE'});
  const value=await nativeOperation(()=>bridge.readAsset({repo,path,ref}));
  aborted();
  if(!value||!['image/png','image/jpeg','image/gif','image/webp','video/webm','video/mp4'].includes(value.mime)||!(value.data instanceof ArrayBuffer)||value.data.byteLength>64*1024*1024)throw Object.assign(new Error('The local media response is unavailable.'),{code:'ASSET_UNAVAILABLE'});
  return value;
}

/** Reveal an existing managed working-tree item in the operating system.
 * Empty path selects the repository folder. No browser or remote fallback.
 * @param {{repo:string,path:string,ref?:string}} input
 * @returns {Promise<void>}
 */
export async function revealRepositoryItem({repo,path,ref=''}) {
  const bridge=getNativeBridge();
  if(!bridge?.revealItem)throw Object.assign(new Error('Revealing files requires the native application.'),{code:'REVEAL_UNAVAILABLE'});
  await nativeOperation(()=>bridge.revealItem({repo,path,ref}));
}

/** A managed repository rename is native-only and participates in close drain.
 * @param {{repository:string,name:string}} input
 * @returns {Promise<import('./native-types').RenamedRepository>}
 */
export async function renameRepository({repository,name}){
  const bridge=getNativeBridge();
  if(!bridge?.renameRepository)throw Object.assign(new Error('Repository rename requires the current native application.'),{code:'RENAME_UNAVAILABLE'});
  const value=await nativeOperation(()=>bridge.renameRepository({repository,name}));
  if(!value||value.repository!==name||value.previousName!==repository||value.organization!=='asMagicBrain'||typeof value.defaultRepository!=='string'||!Array.isArray(value.repositories)||!value.repositories.every(item=>item&&typeof item.name==='string'&&typeof item.privateRepo==='boolean')||value.repositories[0]?.name!==value.defaultRepository||!value.repositories.some(item=>item.name===name))throw Object.assign(new Error('The rename response could not be verified. Reopen the repository list before continuing.'),{code:'RENAME_UNVERIFIED'});
  return value;
}

function verifyRepositoryManagement(value,repository,active){
 if(!value||value.repository!==repository||value.organization!=='asMagicBrain'||typeof value.defaultRepository!=='string'||!Array.isArray(value.repositories)||!value.repositories.every(item=>item&&typeof item.name==='string'&&typeof item.privateRepo==='boolean')||value.repositories[0]?.name!==value.defaultRepository||value.repositories.some(item=>item.name===repository)!==active)throw Object.assign(new Error('Reopen the repository list to verify the completed operation.'),{code:'REPOSITORY_OPERATION_UNVERIFIED'});
 return value;
}
/** @param {{repository:string,name:string,requestId:string}} input
 * @returns {Promise<import('./native-types').DuplicatedRepository>} */
export async function duplicateRepository(input){
 const bridge=getNativeBridge();if(!bridge?.duplicateRepository)throw Object.assign(new Error('Repository duplication requires the current native application.'),{code:'MANAGEMENT_UNAVAILABLE'});
 const value=verifyRepositoryManagement(await nativeOperation(()=>bridge.duplicateRepository(input)),input.name,true);
 if(value.sourceRepository!==input.repository)throw Object.assign(new Error('Reopen the repository list to verify the copy.'),{code:'REPOSITORY_OPERATION_UNVERIFIED'});return value;
}
/** @param {{repository:string,requestId:string}} input
 * @returns {Promise<import('./native-types').TrashedRepository>} */
export async function trashRepository(input){
 const bridge=getNativeBridge();if(!bridge?.trashRepository)throw Object.assign(new Error('Repository Trash requires the current native application.'),{code:'MANAGEMENT_UNAVAILABLE'});
 const value=verifyRepositoryManagement(await nativeOperation(()=>bridge.trashRepository(input)),input.repository,false);
 if(value.trashId!==input.requestId)throw Object.assign(new Error('Reopen Repository Trash to verify the operation.'),{code:'REPOSITORY_OPERATION_UNVERIFIED'});return value;
}
/** @returns {Promise<import('./native-types').RepositoryTrashEntry[]>} */
export async function listTrashedRepositories(){
 const bridge=getNativeBridge();if(!bridge?.listTrashedRepositories)throw Object.assign(new Error('Repository Trash requires the current native application.'),{code:'MANAGEMENT_UNAVAILABLE'});
 const value=await nativeOperation(()=>bridge.listTrashedRepositories());if(!Array.isArray(value)||value.some(item=>!item||typeof item.trashId!=='string'||typeof item.name!=='string'||typeof item.trashedAt!=='string'))throw Object.assign(new Error('Repository Trash could not be verified.'),{code:'REPOSITORY_OPERATION_UNVERIFIED'});return value;
}
/** @param {{trashId:string,name:string}} input
 * @returns {Promise<import('./native-types').RepositoryManagementResult>} */
export async function restoreRepository(input){
 const bridge=getNativeBridge();if(!bridge?.restoreRepository)throw Object.assign(new Error('Repository restore requires the current native application.'),{code:'MANAGEMENT_UNAVAILABLE'});
 return verifyRepositoryManagement(await nativeOperation(()=>bridge.restoreRepository(input)),input.name,true);
}
