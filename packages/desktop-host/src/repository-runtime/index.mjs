import {persistentIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pinDirectory, checkDirectory, checkSourceSpelling, contains } from '../physical-roots.mjs';
import { createPrivateStore, assertOutsideGit } from '../private-store.mjs';
import { createNodeFilesystem } from '../../../source-foundation/src/adapters/node-filesystem.mjs';
import { prepareSourceTransaction, prepareFileTransaction } from '../../../source-foundation/src/operations/requests.mjs';
import { inspectSourceBytes } from '../../../source-foundation/src/content/source-bytes.mjs';
import { isPortableRelativePath, portablePathKey } from '../../../source-foundation/src/domain/path-policy.mjs';
import { normalizeRepositoryPath } from '../../../source-foundation/src/repository-model/index.mjs';
import { createFileManagement, validateManagementPlan, validateManagedTrash, managementPathContains } from './file-management.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/u.test(value);
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const MAX_BYTES = 1024 * 1024;

/** Trusted host factory. Never pass renderer-controlled roots or owner IDs. */
export function createRepositoryRuntime({ sourceRoot, privateRoot, localOwnerId, localRootId, checkoutId, sourceBindingRoot, hooks = {} }) {
  if (![localOwnerId, localRootId, checkoutId].every(validId)) fail('INVALID_IDENTITY');
  const source = pinDirectory(sourceRoot), privatePin = pinDirectory(privateRoot);
  if (contains(source.path, privatePin.path) || contains(privatePin.path, source.path)) fail('INVALID_PRIVATE_ROOT');
  assertOutsideGit(privatePin.path);
  if ((fs.statSync(privateRoot).mode & 0o777) !== 0o700) fail('INVALID_PRIVATE_ROOT');
  // A host-authorized repository rename retains its original logical binding.
  // The current physical source is still pinned and every operation uses it.
  if (sourceBindingRoot !== undefined && (typeof sourceBindingRoot !== 'string' || !path.isAbsolute(sourceBindingRoot) || path.normalize(sourceBindingRoot) !== sourceBindingRoot)) fail('INVALID_IDENTITY');
  const binding = { schemaVersion: 1, localOwnerId, localRootId, checkoutId, sourceRoot: sourceBindingRoot ?? source.path, sourceIdentity: source.identity };
  const bindingHash = hash(JSON.stringify(binding));
  function subdirectory(name) {
    checkDirectory(privatePin);
    const target = path.join(privateRoot, name);
    try { fs.mkdirSync(target, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // Persist each private child name before a draft/intent can be acknowledged.
    const child = pinDirectory(target), fd = fs.openSync(privatePin.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { if (persistentIdentity(fs.fstatSync(fd)) !== privatePin.identity) fail('DENIED'); fs.fsyncSync(fd); checkDirectory(privatePin); }
    finally { fs.closeSync(fd); }
    return child.path;
  }
  const store = createPrivateStore({ privateRoot: subdirectory('records'), bindingHash });
  // Compatibility key for the existing qualified transaction engine only; never a Space domain entity.
  const key = bindingHash.slice(0, 32);
  const transportId = `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
  const adapter = createNodeFilesystem({ repositoryRoot: source.path, recoveryRoot: subdirectory('recovery'), spaceRoot: '.', spaceId: transportId });
  let closed = false;
  let snapshot, state;
  const management = createFileManagement({ source, privateRoot: subdirectory('managed-content'), check, hooks });
  function check() { if (closed) fail('CLOSED'); checkDirectory(source); checkDirectory(privatePin); }
  function validateState(value) {
    // Read the immediately preceding Stage3 candidate shape without modifying stored history.
    if (exact(value, ['schemaVersion','binding','documents','drafts','trash','pending'])) value = { ...value, recoveredDrafts: [] };
    if (!exact(value, ['schemaVersion','binding','documents','drafts','trash','recoveredDrafts','pending']) || value.schemaVersion !== 1 || JSON.stringify(value.binding) !== JSON.stringify(binding)
      || !Array.isArray(value.recoveredDrafts) || !Array.isArray(value.trash) || !Array.isArray(value.documents) || !Array.isArray(value.drafts) || value.documents.length > 10000) fail('RECOVERY_REQUIRED');
    const paths = new Set(), ids = new Set();
    for (const d of value.documents) {
      if (!exact(d, ['path','documentId']) || !validId(d.documentId)) fail('RECOVERY_REQUIRED');
      safePath(d.path); if (paths.has(d.path) || ids.has(d.documentId)) fail('RECOVERY_REQUIRED'); paths.add(d.path); ids.add(d.documentId);
    }
    const drafted = new Set();
    for (const d of value.drafts) {
      if (!exact(d, ['documentId','baseHash','text']) || !ids.has(d.documentId) || drafted.has(d.documentId) || !digest(d.baseHash)) fail('RECOVERY_REQUIRED');
      sourceText(d.text); drafted.add(d.documentId);
    }
    for (const recovered of value.recoveredDrafts) {
      if (!exact(recovered, ['path','text'])) fail('RECOVERY_REQUIRED'); safePath(recovered.path); sourceText(recovered.text);
    }
    const trashed = new Set();
    for (const entry of value.trash) {
      if(entry.format==='tree-v1'){
        validateManagedTrash(entry);if(trashed.has(entry.trashId))fail('RECOVERY_REQUIRED');trashed.add(entry.trashId);continue;
      }
      if (!exact(entry, ['trashId','documentId','path','bytes','hash']) || !validId(entry.trashId) || !ids.has(entry.documentId)
        || trashed.has(entry.trashId) || typeof entry.bytes !== 'string' || !digest(entry.hash)) fail('RECOVERY_REQUIRED');
      safePath(entry.path); const bytes = Buffer.from(entry.bytes, 'base64');
      if (bytes.length > MAX_BYTES || bytes.toString('base64') !== entry.bytes || hash(bytes) !== entry.hash) fail('RECOVERY_REQUIRED');
      trashed.add(entry.trashId);
    }
    if (value.pending !== null) {
      const pending = value.pending;
      if(pending.kind==='management'){
        if(!exact(pending,['kind','phase','plan','after'])||!['staging','prepared','completed','rollback'].includes(pending.phase)||!exact(pending.after,['documents','drafts','trash','recoveredDrafts']))fail('RECOVERY_REQUIRED');
        validateManagementPlan(pending.plan);validateState({...value,...pending.after,pending:null});return value;
      }
      if (!exact(pending, ['requestId','changes','after']) || !validId(pending.requestId) || !Array.isArray(pending.changes)
        || !pending.changes.length || pending.changes.length > 2 || !exact(pending.after, ['documents','drafts','trash'])) fail('RECOVERY_REQUIRED');
      for (const change of pending.changes) {
        if (!exact(change, ['path','beforeHash','afterHash','bytes']) || !(change.beforeHash === null || digest(change.beforeHash))
          || !(change.afterHash === null || digest(change.afterHash))) fail('RECOVERY_REQUIRED');
        safePath(change.path);
        if (change.bytes === null ? change.afterHash !== null : typeof change.bytes !== 'string' || hash(Buffer.from(change.bytes, 'base64')) !== change.afterHash) fail('RECOVERY_REQUIRED');
      }
      validateState({ ...value, ...pending.after, pending: null });
    }
    return value;
  }
  function load() {
    check(); snapshot = store.ensureDurable(store.scan());
    state = snapshot.events.length ? validateState(snapshot.events.at(-1).payload) : { schemaVersion: 1, binding, documents: [], drafts: [], trash: [], recoveredDrafts: [], pending: null };
  }
  function persist(next) {
    validateState(next); check();
    if (snapshot.tailRecords >= 24) snapshot = store.compact(snapshot, state);
    snapshot = store.append(snapshot, 'draft', next); state = structuredClone(next);
  }
  function safePath(relative) {
    try { normalizeRepositoryPath(relative); } catch { fail('INVALID_PATH'); }
    if (relative.split('/').some(part => part.toLowerCase().startsWith('.asmb-') || part.toLowerCase() === '.asmagicbrain')) fail('RESERVED_PATH');
    return relative;
  }
  // Directory creation is an explicit, non-rollback operation. Each existing
  // ancestor is pinned and rechecked; aliases and links never count as parents.
  function withDirectories(relative, includeLeaf, operation) {
    safePath(relative);
    if(state.trash.some(entry=>managementPathContains(entry.path,relative)))fail('TRASH_PATH_RESERVED');
    if (!isPortableRelativePath(relative)) fail('INVALID_PATH');
    const parts = relative.split('/');
    if (parts.length > 32) fail('LIMIT_EXCEEDED');
    const targets = parts.slice(0, includeLeaf ? parts.length : -1);
    const createdDirectories = [], pins = [source];
    try {
      for (let index = 0; index < targets.length; index++) {
        check(); pins.forEach(checkDirectory);
        const next = targets.slice(0, index + 1).join('/');
        if (state.documents.some(entry => portablePathKey(entry.path) === portablePathKey(next))) fail('ALREADY_EXISTS');
        const parent = pins.at(-1), name = targets[index];
        // Bounded discovery also prevents accepting aliases on case-sensitive hosts.
        const entries = [], directory = fs.opendirSync(parent.path);
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entries.length >= 10000) fail('LIMIT_EXCEEDED'); entries.push(entry.name);
        } } finally { directory.closeSync(); }
        checkDirectory(parent);
        const matches = entries.filter(entry => portablePathKey(entry) === portablePathKey(name));
        if (matches.length && (matches.length !== 1 || matches[0] !== name)) fail('DENIED');
        const absolute = path.join(source.path, next);
        if (!matches.length) {
          if(entries.length>=10000)fail('LIMIT_EXCEEDED');
          hooks.at?.('before-directory-create');
          check(); pins.forEach(checkDirectory);
          // No recursive mkdir, link-following or destructive rollback.
          management.createDirectory(parent.path,name);
          createdDirectories.push(next);
        }
        const pinned = pinDirectory(absolute);
        pins.forEach(checkDirectory); checkSourceSpelling(source.path, next);
        pins.push(pinned);
        if (createdDirectories.at(-1) === next) {
          for (const target of [pinned, parent]) {
            const fd = fs.openSync(target.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try {
              const stat = fs.fstatSync(fd);
              if (persistentIdentity(stat) !== target.identity) fail('DENIED');
              fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
          }
          hooks.at?.('after-directory-create');
        }
      }
      check(); pins.forEach(checkDirectory);
      return { ...operation(), createdDirectories };
    } catch (error) {
      // Callers must not report an all-or-nothing failure if empty parents remain.
      error.createdDirectories = [...createdDirectories]; throw error;
    }
  }
  function createFolder({ path: relative }) {
    load(); writable();
    const result = withDirectories(relative, true, () => ({ path: relative }));
    return { status: result.createdDirectories.length ? 'created' : 'exists', ...result };
  }
  function sourceText(text) {
    if (typeof text !== 'string' || !text.isWellFormed() || text.includes('\u0000')) fail('INVALID_TEXT');
    const bytes = Buffer.from(text, 'utf8'); if (bytes.length > MAX_BYTES) fail('LIMIT_EXCEEDED'); return bytes;
  }
  function inspect(relative) { check(); safePath(relative); const item = adapter.inspect(relative); check(); return item; }
  function document(relative) {
    if (state.trash.some(entry => managementPathContains(entry.path,relative))) fail('TRASH_PATH_RESERVED');
    let d = state.documents.find(item => item.path === relative);
    if (!d) { d = { path: relative, documentId: randomUUID() }; persist({ ...state, documents: [...state.documents, d] }); }
    return d;
  }
  function writable() {
    if (state.pending || adapter.inspectRecovery().blocked) fail('RECOVERY_REQUIRED');
  }
  function open(relative) {
    load(); check(); safePath(relative); checkSourceSpelling(source.path, relative);
    const metadata = fs.lstatSync(path.join(source.path, relative));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail('READ_ONLY');
    if (metadata.size > MAX_BYTES) return { path: relative, documentId: document(relative).documentId, sourceHash: null, text: null,
      encoding: 'oversized', readOnly: true, draft: null, conflict: false, recoveryRequired: Boolean(state.pending) };
    const item = inspect(relative); if (item.bytes === null) fail('NOT_FOUND');
    const bytes = inspectSourceBytes(item.bytes), d = document(relative), draft = state.drafts.find(v => v.documentId === d.documentId) ?? null;
    return { path: relative, documentId: d.documentId, sourceHash: item.hash, text: bytes.text, encoding: bytes.encoding,
      readOnly: item.readOnly || bytes.encoding !== 'utf-8' || bytes.text?.includes('\u0000'), draft: draft ? { text: draft.text, baseHash: draft.baseHash } : null,
      conflict: Boolean(draft && draft.baseHash !== item.hash), recoveryRequired: Boolean(state.pending) };
  }
  function discover() {
    load(); const entries = [], issues = []; let truncated = false;
    function walk(relative = '', depth = 0) {
      if (depth > 32) { truncated = true; return; }
      check(); const absolute = relative ? path.join(source.path, relative) : source.path;
      if (relative) checkSourceSpelling(source.path, relative);
      const pinned = pinDirectory(absolute), directory = fs.opendirSync(absolute);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entries.length >= 10000) { truncated = true; break; }
          if (['.git', '.asmagicbrain'].includes(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.asmb-')) continue;
          const next = relative ? `${relative}/${entry.name}` : entry.name;
          try {
            safePath(next); checkDirectory(pinned); checkSourceSpelling(source.path, next);
            const stat = fs.lstatSync(path.join(source.path, next));
            if (stat.isSymbolicLink()) { issues.push({ path: next, code: 'SYMLINK' }); continue; }
            if (stat.isDirectory()) { entries.push({ path: next, type: 'directory' }); walk(next, depth + 1); }
            else if (stat.isFile() && stat.nlink === 1) entries.push({ path: next, type: 'file', byteLength: stat.size, editableCandidate: /\.(md|markdown|txt)$/iu.test(next) && stat.size <= MAX_BYTES });
            else issues.push({ path: next, code: 'UNSUPPORTED_FILE' });
          } catch (error) { issues.push({ path: next, code: error.code ?? 'UNSAFE_PATH' }); }
        }
      } finally { directory.closeSync(); }
      checkDirectory(pinned);
    }
    walk(); return { entries: entries.sort((a,b) => a.path.localeCompare(b.path)), issues, complete: !truncated && !issues.length };
  }
  function checkpoint({ path: relative, baseHash, text }) {
    load(); writable(); sourceText(text); if (!digest(baseHash)) fail('INVALID_BASE');
    const item = inspect(relative); if (item.bytes === null) fail('NOT_FOUND');
    if (item.readOnly || inspectSourceBytes(item.bytes).encoding !== 'utf-8' || inspectSourceBytes(item.bytes).text?.includes('\u0000')) fail('READ_ONLY');
    const d = document(relative);
    // Retain a conflicted checkpoint rather than lose the user's edits; Save still rejects it.
    persist({ ...state, drafts: [...state.drafts.filter(v => v.documentId !== d.documentId), { documentId: d.documentId, baseHash, text }] });
    return { status: 'checkpointed', conflict: item.hash !== baseHash };
  }
  function discard(relative) {
    load(); writable(); safePath(relative); const d = state.documents.find(v => v.path === relative);
    if (d) persist({ ...state, drafts: state.drafts.filter(v => v.documentId !== d.documentId) });
    return { status: 'discarded' };
  }
  function transact(files, after, { sourceOnly = false, expectedHashes } = {}) {
    const requestId = randomUUID();
    const expected = files.map((file,index) => ({ path: file.path, hash: expectedHashes[index] }));
    const raw = { schemaVersion: sourceOnly ? 2 : 3, requestId, target: { kind: 'source', spaceId: transportId },
      expected: { files: expected }, input: { files, assets: [], ...(sourceOnly ? {} : { directories: [] }) } };
    const plan = sourceOnly ? prepareSourceTransaction(raw) : prepareFileTransaction(raw);
    adapter.preflight(plan);
    const pending = { requestId, changes: files.map((file,index) => ({ path: file.path, beforeHash: expected[index].hash,
      afterHash: file.bytes === null ? null : hash(file.bytes), bytes: file.bytes === null ? null : Buffer.from(file.bytes).toString('base64') })), after };
    persist({ ...state, pending }); hooks.at?.('after-intent');
    const outcome = adapter.apply(plan);
    if (!['completed','no-op'].includes(outcome.status)) fail('RECOVERY_REQUIRED');
    hooks.at?.('after-source-write');
    if (pending.changes.some(change => inspect(change.path).hash !== change.afterHash)) fail('RECOVERY_REQUIRED');
    persist({ ...state, ...after, recoveredDrafts: state.recoveredDrafts.filter(entry => !files.some(file => file.path === entry.path && file.bytes !== null)), pending: null });
  }
  function write({ path: relative, baseHash, text }, creating = false) {
    load(); writable(); const bytes = sourceText(text); const item = inspect(relative);
    if (creating ? item.bytes !== null : item.bytes === null) fail(creating ? 'ALREADY_EXISTS' : 'NOT_FOUND');
    if (item.readOnly || (!creating && (inspectSourceBytes(item.bytes).encoding !== 'utf-8' || inspectSourceBytes(item.bytes).text?.includes('\u0000')))) fail('READ_ONLY');
    if (creating ? baseHash !== null : !digest(baseHash)) fail('INVALID_BASE');
    if (item.hash !== baseHash) fail('CONFLICT');
    if (state.trash.some(entry => managementPathContains(entry.path,relative))) fail('TRASH_PATH_RESERVED');
    const d = document(relative), drafts = state.drafts.filter(v => v.documentId !== d.documentId);
    // Durable user text before source publication, also present in the pending transaction for creates.
    if (!creating) persist({ ...state, drafts: [...drafts, { documentId: d.documentId, baseHash, text }] });
    hooks.at?.('before-source-preflight');
    if (inspect(relative).hash !== baseHash) fail('CONFLICT');
    transact([{ path: relative, bytes }], { documents: state.documents, drafts, trash: state.trash }, { sourceOnly: true, expectedHashes: [baseHash] });
    return { status: 'saved', ...open(relative) };
  }
  function rename({ path: relative, newPath, baseHash }) {
    const result=manage({operation:'move',items:[{path:relative,newPath,token:baseHash}]});
    const item=management.inspectEntry({path:newPath});return {...result,status:'renamed',...(item.type==='file'?open(newPath):item)};
  }

  function trash({ path: relative, baseHash }) {
    const result=manage({operation:'trash',items:[{path:relative,token:baseHash}]});
    return {...result,status:'trashed',trashId:result.items[0].trashId,path:relative};
  }
  function restore({ trashId }) {
    load(); writable(); const entry = state.trash.find(v => v.trashId === trashId); if (!entry) fail('NOT_FOUND');
    if(entry.format==='tree-v1'){
      const plan=management.restorePlan(entry),after={documents:state.documents,drafts:state.drafts,trash:state.trash.filter(value=>value.trashId!==trashId),recoveredDrafts:state.recoveredDrafts};
      const result=performManagement(plan,after);return {...result,status:'restored',...(entry.snapshot.type==='file'?open(entry.path):management.inspectEntry({path:entry.path}))};
    }
    if (inspect(entry.path).bytes !== null) fail('ALREADY_EXISTS');
    transact([{ path: entry.path, bytes: Buffer.from(entry.bytes, 'base64') }], { documents: state.documents, drafts: state.drafts, trash: state.trash.filter(v => v.trashId !== trashId) }, { expectedHashes: [null] });
    return { status: 'restored', ...open(entry.path) };
  }
  function listTrash() { load(); return state.trash.map(entry=>entry.format==='tree-v1'?{trashId:entry.trashId,path:entry.path,type:entry.snapshot.type,token:entry.snapshot.token,hash:entry.snapshot.token,byteLength:entry.snapshot.byteLength,fileCount:entry.snapshot.fileCount,entryCount:entry.snapshot.entryCount,documentId:state.documents.find(document=>document.path===entry.path)?.documentId??null}:(({trashId,documentId,path,hash})=>({trashId,documentId,path,hash,type:'file'}))(entry)); }
  function inspectEntry(request){load();return management.inspectEntry(request);}
  function managementResult(plan,createdDirectories=[]){
    const pathMoves=plan.operation==='move'?plan.items.map(item=>({from:item.path,to:item.newPath})):[];
    const changedPaths=[];
    for(const item of plan.items)for(const file of item.snapshot.entries.filter(entry=>entry.type==='file')){
      if(item.path&&plan.operation!=='copy')changedPaths.push(file.path?`${item.path}/${file.path}`:item.path);
      if(item.newPath)changedPaths.push(file.path?`${item.newPath}/${file.path}`:item.newPath);
    }
    return {status:'completed',operation:plan.operation,items:plan.items.map(item=>({path:item.path??item.newPath,...(item.newPath?{newPath:item.newPath}:{}),...(item.trashId?{trashId:item.trashId}:{})})),pathMoves,changedPaths:[...new Set(changedPaths)],createdDirectories};
  }
  function performManagement(plan,after){
    const pending={kind:'management',phase:'staging',plan,after};validateState({...state,pending});
    if(snapshot.tailRecords>=21)snapshot=store.compact(snapshot,state);
    store.reserve(snapshot,[{type:'draft',payload:{...state,pending}},{type:'draft',payload:{...state,pending:{...pending,phase:'prepared'}}},{type:'draft',payload:{...state,pending:{...pending,phase:'completed'}}},{type:'draft',payload:{...state,...after,pending:null}}]);
    const createdDirectories=[];
    for(const item of plan.items)if(item.newPath){
      // A restore is allowed to recreate parents of its own reserved Trash path.
      const retained=state.trash;state={...state,trash:state.trash.filter(entry=>entry.trashId!==item.trashId)};
      try{createdDirectories.push(...withDirectories(item.newPath,false,()=>({})).createdDirectories);}catch(error){error.createdDirectories=[...createdDirectories,...(error.createdDirectories??[])];throw error;}finally{state={...state,trash:retained};}
    }
    persist({...state,pending});
    try{
      management.stage(plan);if(plan.operation==='import')hooks.checkCancelled?.();persist({...state,pending:{...pending,phase:'prepared'}});
      hooks.at?.('after-intent');
      management.execute(plan);hooks.at?.('after-source-write');
      if(management.settle(plan,{onDecision:phase=>persist({...state,pending:{...state.pending,phase}})})!=='completed')fail('RECOVERY_REQUIRED');
      management.cleanup(plan,'completed');persist({...state,...after,pending:null});
      return managementResult(plan,createdDirectories);
    }catch(error){throw Object.assign(new Error('RECOVERY_REQUIRED'),{code:'RECOVERY_REQUIRED',cause:error,createdDirectories});}
  }
  function manage(request){
    load();writable();const plan=management.prepare(request);
    for(const item of plan.items){
      if(state.trash.some(entry=>managementPathContains(entry.path,item.path)||managementPathContains(item.path,entry.path)||(item.newPath&&(managementPathContains(entry.path,item.newPath)||managementPathContains(item.newPath,entry.path)))))fail('TRASH_PATH_RESERVED');
      if(item.newPath&&state.documents.some(document=>managementPathContains(item.newPath,document.path)))fail('ALREADY_EXISTS');
    }
    let documents=state.documents.map(document=>({...document}));
    for(const item of plan.items)if(item.snapshot.type==='file'&&!documents.some(document=>document.path===item.path))documents.push({path:item.path,documentId:randomUUID()});
    const relocate=relative=>{const item=plan.items.find(item=>managementPathContains(item.path,relative));return item?item.newPath+relative.slice(item.path.length):relative;};
    if(plan.operation==='move')documents=documents.map(document=>({...document,path:relocate(document.path)}));
    if(plan.operation==='copy')documents.push(...documents.filter(document=>plan.items.some(item=>managementPathContains(item.path,document.path))).map(document=>({path:relocate(document.path),documentId:randomUUID()})));
    const trash=plan.operation==='trash'?[...state.trash,...plan.items.map(item=>({format:'tree-v1',trashId:item.trashId,path:item.path,snapshot:item.snapshot}))]:state.trash;
    const recoveredDrafts=plan.operation==='move'?state.recoveredDrafts.map(draft=>({...draft,path:relocate(draft.path)})):state.recoveredDrafts;
    return performManagement(plan,{documents,drafts:state.drafts,trash,recoveredDrafts});
  }
  // Trusted host-only intake. External paths never enter the renderer-facing
  // operation dispatcher; all source bytes are copied, never moved or deleted.
  function importExternal({sources,destination='',reservedPaths=[]}){
    load();writable();
    const prepared=management.prepareImport({sources,destination,reservedPaths:[...state.documents.map(item=>item.path),...state.trash.map(item=>item.path),...state.recoveredDrafts.map(item=>item.path),...reservedPaths]});
    if(!prepared.plan)fail('NO_IMPORTABLE_FILES');
    const plan=prepared.plan,after={documents:state.documents,drafts:state.drafts,trash:state.trash,recoveredDrafts:state.recoveredDrafts};
    const found=discover();if(!found.complete||found.entries.length+plan.items.reduce((total,item)=>total+item.snapshot.entryCount,0)>10000)fail('LIMIT_EXCEEDED');
    let result;
    try{result=performManagement(plan,after);}catch(error){
      // Ordinary prepublication cancellation/failure gets the same durable
      // rollback as a restarted transaction. Unknown bytes remain held rather
      // than being deleted under a generic cleanup rule.
      try{const outcome=reconcile();if(outcome.status==='completed')result=outcome;else if(outcome.status==='retained-old')throw error.cause??error;else throw error;}
      catch(recovery){if(recovery===error.cause||recovery===error)throw recovery;throw Object.assign(new Error('External file import requires recovery. Original files remain untouched.'),{code:'RECOVERY_REQUIRED',cause:recovery});}
    }
    return {...result,status:'completed',importedPaths:plan.items.map(item=>item.newPath),skippedMetadata:prepared.skippedMetadata};
  }
  function reconcile() {
    load();
    // Reconcile metadata only when the qualified transaction engine is already terminal.
    // Mixed/ambiguous source outcomes remain retained for manual recovery; never blindly replay.
    if (adapter.inspectRecovery().blocked) fail('RECOVERY_REQUIRED');
    if (!state.pending) return { status: 'current' };
    if(state.pending.kind==='management'){
      const pending=state.pending;
      if(pending.phase==='staging'){management.abortStaging(pending.plan);persist({...state,pending:null});return {...managementResult(pending.plan),status:'retained-old'};}
      const result=management.settle(pending.plan,{outcome:pending.phase,onDecision:phase=>persist({...state,pending:{...state.pending,phase}})});management.cleanup(pending.plan,result);
      persist({...state,...(result==='completed'?pending.after:{}),pending:null});return {...managementResult(pending.plan),status:result};
    }
    const pending = state.pending, observed = pending.changes.map(change => inspect(change.path).hash);
    if (pending.changes.every((change,index) => observed[index] === change.afterHash)) {
      persist({ ...state, ...pending.after, pending: null }); return { status: 'completed' };
    }
    if (pending.changes.every((change,index) => observed[index] === change.beforeHash)) {
      // Pending bytes remain in the immutable history; existing draft stays available.
      const retainedChanges = pending.changes.filter(v => v.bytes !== null).map(v => ({ path: v.path, bytes: v.bytes }));
      let recoveredDrafts = state.recoveredDrafts;
      if (pending.changes.length === 1 && pending.changes[0].beforeHash === null && pending.changes[0].bytes !== null) {
        const change = pending.changes[0], text = inspectSourceBytes(Buffer.from(change.bytes, 'base64')).text;
        recoveredDrafts = [...recoveredDrafts.filter(v => v.path !== change.path), { path: change.path, text }];
      }
      persist({ ...state, recoveredDrafts, pending: null }); return { status: 'retained-old', retainedChanges };
    }
    fail('RECOVERY_REQUIRED');
  }
  function adoptReferences(references) {
    load(); writable();
    if (!Array.isArray(references) || references.length > 10000) fail('INVALID_REFERENCES');
    const documents = state.documents.map(value => ({ ...value }));
    const incomingPaths = new Set(), incomingIds = new Set();
    for (const reference of references) {
      if (!exact(reference, ['path','documentId']) || !validId(reference.documentId)) fail('INVALID_REFERENCES');
      safePath(reference.path);
      if (incomingPaths.has(reference.path) || incomingIds.has(reference.documentId)) fail('REFERENCE_COLLISION');
      incomingPaths.add(reference.path); incomingIds.add(reference.documentId);
      checkSourceSpelling(source.path, reference.path);
      const stat = fs.lstatSync(path.join(source.path, reference.path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('INVALID_REFERENCES');
      const byPath = documents.find(v => v.path === reference.path), byId = documents.find(v => v.documentId === reference.documentId);
      if ((byPath && byPath.documentId !== reference.documentId) || (byId && byId.path !== reference.path)
        || state.trash.some(v => v.path === reference.path || v.documentId === reference.documentId)) fail('REFERENCE_COLLISION');
      if (!byPath) documents.push({ ...reference });
    }
    if (documents.length !== state.documents.length) persist({ ...state, documents });
    return { status: 'adopted', count: references.length };
  }
  function status() { load(); return { identity: { localOwnerId, localRootId, checkoutId }, draftCount: state.drafts.length,
    recoveredDrafts: structuredClone(state.recoveredDrafts), recoveryRequired: Boolean(state.pending) || adapter.inspectRecovery().blocked, pending: state.pending ? { paths: state.pending.kind==='management'?state.pending.plan.items.flatMap(item=>[item.path,item.newPath].filter(Boolean)):state.pending.changes.map(v => v.path) } : null }; }
  load();
  // Persist the binding even before the first document: another folder/owner may not reuse this store.
  if (!snapshot.events.length) persist(state);
  return Object.freeze({ identity: Object.freeze({ localOwnerId, localRootId, checkoutId }), discover, open, checkpoint, discard, rename, trash, restore, listTrash, reconcile, adoptReferences, inspectEntry, manage, importExternal,
    save: request => write(request), createFolder, create: ({ path, text = '' }) => {
      load(); writable(); sourceText(text);
      return withDirectories(path, false, () => write({ path, text, baseHash: null }, true));
    }, state: status,
    close() { closed = true; } });
}
