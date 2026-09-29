const {contextBridge, ipcRenderer, webUtils} = require('electron');
// Errors thrown through contextBridge lose custom fields. Keep every asynchronous
// reply plain data; the renderer adapter reconstructs its own coded Error.
const failure = (error, fallback = 'NATIVE_OPERATION_FAILED') => ({ok:false,error:{
  code:typeof error?.code==='string'?error.code:fallback,
  message:typeof error?.message==='string'?error.message:'Native operation failed.',
}});
const invoke = async (method, args) => {
  try {return await ipcRenderer.invoke('asmb:native', {method, args});}
  catch (error) {return failure(error);}
};
contextBridge.exposeInMainWorld('asMagicBrain', Object.freeze({
  native: true,
  configureAutomation: args => invoke('configureAutomation',args),
  getAutomationStatus: args => invoke('getAutomationStatus',args),
  approveAutomation: args => invoke('approveAutomation',args),
  cancelAutomation: args => invoke('cancelAutomation',args),

  packageStatus: args => invoke('packageStatus',args),
  reviewPackageBase: args => invoke('reviewPackageBase',args),
  registerPackageBase: args => invoke('registerPackageBase',args),
  reviewPackageUpdate: args => invoke('reviewPackageUpdate',args),
  applyPackageUpdate: args => invoke('applyPackageUpdate',args),
  recoverPackageUpdate: args => invoke('recoverPackageUpdate',args),
  rollbackPackageUpdate: args => invoke('rollbackPackageUpdate',args),
  reviewPackageExport: args => invoke('reviewPackageExport',args),
  cancelPackagePlan: args => invoke('cancelPackagePlan',args),
  savePackageExport: args => invoke('savePackageExport',args),

  nativeWindowControls: process.platform === 'darwin',
  responseVersion: 1,
  getBuildConfiguration: () => invoke('getBuildConfiguration'),
  catalog: () => invoke('catalog'),
  getReadingEvidence: args => invoke('getReadingEvidence',args),
  getReadingReference: args => invoke('getReadingReference',args),
  resolveReadingReference: args => invoke('resolveReadingReference',args),
  readingHistory: args => invoke('readingHistory',args),
  reviewArtifact: args => invoke('reviewArtifact', args),
  runArtifact: args => invoke('runArtifact', args),
  resizeArtifact: args => invoke('resizeArtifact', args),
  stopArtifact: args => invoke('stopArtifact', args),
  resetArtifact: args => invoke('resetArtifact', args),
  artifactStatus: args => invoke('artifactStatus', args),

  read: args => invoke('read', args),
  readAsset: args => invoke('readAsset', args),
  revealItem: args => invoke('revealItem', args),
  bootstrap: repo => invoke('bootstrap', repo),
  request: args => invoke('request', args),
  importArchive: args => invoke('importArchive', args),
  createRepository: args => invoke('createRepository', args),
  cloneRepository: args => invoke('cloneRepository', args),
  getCloneProgress: args => invoke('getCloneProgress', args),
  cancelClone: args => invoke('cancelClone', args),
  getRepositoryUpdates: args => invoke('getRepositoryUpdates', args),
  reviewRepositoryUpdate: args => invoke('reviewRepositoryUpdate', args),
  applyRepositoryUpdate: args => invoke('applyRepositoryUpdate', args),
  getRepositoryApplyProgress: args => invoke('getRepositoryApplyProgress', args),
  checkRepositoryUpdates: args => invoke('checkRepositoryUpdates', args),
  getRepositoryUpdateProgress: args => invoke('getRepositoryUpdateProgress', args),
  cancelRepositoryUpdate: args => invoke('cancelRepositoryUpdate', args),
  readRepositoryUpdateFile: args => invoke('readRepositoryUpdateFile', args),
  getGitHubConnection: () => invoke('getGitHubConnection'),
  startGitHubConnection: () => invoke('startGitHubConnection'),
  pollGitHubConnection: args => invoke('pollGitHubConnection', args),
  cancelGitHubConnection: args => invoke('cancelGitHubConnection', args),
  cancelPendingGitHubConnection: () => invoke('cancelPendingGitHubConnection'),
  openGitHubVerification: args => invoke('openGitHubVerification', args),
  disconnectGitHub: () => invoke('disconnectGitHub'),
  getApplicationAccount: () => invoke('getApplicationAccount'),
  startApplicationSignIn: args => invoke('startApplicationSignIn', args),
  pollApplicationSignIn: args => invoke('pollApplicationSignIn', args),
  verifyApplicationEmail: args => invoke('verifyApplicationEmail', args),
  cancelApplicationSignIn: args => invoke('cancelApplicationSignIn', args),
  cancelPendingApplicationSignIn: () => invoke('cancelPendingApplicationSignIn'),
  refreshApplicationAccount: () => invoke('refreshApplicationAccount'),
  updateApplicationProfile: args => invoke('updateApplicationProfile', args),
  signOutApplicationAccount: () => invoke('signOutApplicationAccount'),
  duplicateRepository: args => invoke('duplicateRepository', args),
  trashRepository: args => invoke('trashRepository', args),
  listTrashedRepositories: () => invoke('listTrashedRepositories'),
  restoreRepository: args => invoke('restoreRepository', args),
  renameRepository: args => invoke('renameRepository', args),
  prepareExternalFiles: async files => {
    try {
      if(!Array.isArray(files)||!files.length||files.length>256)throw Object.assign(new Error('Choose 1–256 local files or folders.'),{code:'INVALID_EXTERNAL_FILES'});
      // Resolve while handling the original File objects. Synthetic browser Files
      // have no disk path; callers cannot substitute a string/path property.
      const paths=files.map(file=>webUtils.getPathForFile(file));
      if(paths.some(value=>!value))throw Object.assign(new Error('Only files or folders from this computer can be imported.'),{code:'INVALID_EXTERNAL_FILES'});
      return await ipcRenderer.invoke('asmb:external-files',paths);
    }catch(error){return failure(error,'INVALID_EXTERNAL_FILES');}
  },
  pickExternalFiles: () => invoke('pickExternalFiles'),
  importExternalFiles: args => invoke('importExternalFiles',args),
  cancelExternalFiles: args => invoke('cancelExternalFiles',args),
  getRepositoryPins: () => invoke('getRepositoryPins'),
  setRepositoryPinned: args => invoke('setRepositoryPinned', args),
  listRepositoryFiles: args => invoke('listRepositoryFiles', args),
  searchRepositoryText: args => invoke('searchRepositoryText', args),
  cancelRepositorySearch: args => invoke('cancelRepositorySearch', args),
  getAppearance: () => invoke('getAppearance'),
  setAppearance: args => invoke('setAppearance', args),
  windowAction: action => invoke('windowAction', action),
  onPrepareClose: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('asmb:prepare-close', listener);
    return () => ipcRenderer.removeListener('asmb:prepare-close', listener);
  },
  closeReady: result => ipcRenderer.send('asmb:close-ready', result),
}));
