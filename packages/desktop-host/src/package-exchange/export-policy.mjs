/** Filename heuristic only: this does not scan source text for embedded secrets.
 * Host account storage is outside the saved source tree and never enumerated. */
export function exportExcludedReason(relative){
 const parts=relative.toLowerCase().split('/'),name=parts.at(-1);
 if(parts.some(part=>['.ssh','.gnupg','.aws'].includes(part)))return 'suspected-credential-filename';
 if(['.env.example','.env.sample','.env.template'].includes(name))return null;
 if(name.startsWith('.env')||['.npmrc','.netrc','_netrc','.git-credentials','credentials.json','id_rsa','id_dsa','id_ecdsa','id_ed25519'].includes(name)||/\.(?:pem|key|p12|pfx)$/.test(name))return 'suspected-credential-filename';
 return null;
}
export function selectExportFiles(files){
 const included=[],excluded=[];
 for(const file of files){const reason=exportExcludedReason(file.path);if(reason)excluded.push({path:file.path,reason});else included.push(file);}
 return {files:included,excluded};
}
