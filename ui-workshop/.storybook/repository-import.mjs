import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {workspaceRoot} from './workspace-paths.mjs';
import {createRepositoryImporter} from '../../packages/desktop-host/src/repository-import/index.mjs';
import {ZIP_IMPORT_LIMITS} from '../../packages/desktop-host/src/zip-import/index.mjs';
import {checkDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';

export const managedRepositoryRoot=workspaceRoot;
const messages={NAME_EXISTS:'A repository with this name already exists. Choose another name.',INVALID_REPOSITORY_NAME:'Use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number. Reserved names and trailing dots are unavailable.',ZIP_LIMIT_EXCEEDED:'This ZIP exceeds the import limits shown above.',ZIP_UNSAFE_PATH:'The ZIP contains a path that cannot be imported safely.',ZIP_CONFLICT:'The ZIP contains duplicate or conflicting file names.',ZIP_UNSUPPORTED:'This ZIP uses an unsupported format. Use a standard, unencrypted ZIP.',ZIP_INVALID:'This file is not a valid ZIP archive.',ZIP_INTEGRITY:'The ZIP is damaged or incomplete.',IMPORT_BUSY:'Another import is running or needs recovery. Your existing repositories are unchanged.',CATALOG_UNAVAILABLE:'The repository list needs recovery. Existing files have been preserved.',REPOSITORY_CHANGED:'A repository folder has changed outside the app. Existing files have been preserved.'};
export function createRepositoryImportHandler({port=6006,base=managedRepositoryRoot}={}){
 const service=createRepositoryImporter({base}),capability=randomBytes(32).toString('hex');let busy=false;
 const respond=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});res.end(JSON.stringify(value));};
 const fail=code=>{throw Object.assign(new Error(code),{code});};
 return async(req,res)=>{
  const allowed=[`127.0.0.1:${port}`,`localhost:${port}`],origin=`http://${req.headers.host}`;
  if(!allowed.includes(req.headers.host)||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin))return respond(res,403,{ok:false,error:{code:'ORIGIN_DENIED',message:'Request origin is not allowed.'}});
  let upload,fd,ownsRequest=false;
  try{
   const url=new URL(req.url,origin);
   if(req.method==='GET'){
    if(url.search)fail('INVALID_REQUEST');service.catalog.recover();
    return respond(res,200,{capability,organization:'asMagicBrain',repositories:service.catalog.list(),limits:ZIP_IMPORT_LIMITS});
   }
   if(req.method!=='POST')return respond(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'Use POST to import a ZIP.'}});
   if(req.headers.origin!==origin||req.headers['x-asmagicbrain-capability']!==capability||req.headers['content-type']!=='application/zip')return respond(res,403,{ok:false,error:{code:'CAPABILITY_DENIED',message:'Reload the import dialog and try again.'}});
   if([...url.searchParams.keys()].length!==1||url.searchParams.getAll('name').length!==1)fail('INVALID_REQUEST');
   if(busy)fail('IMPORT_BUSY');const name=url.searchParams.get('name');service.catalog.assertAvailable(name);
   const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>ZIP_IMPORT_LIMITS.archiveBytes)fail('ZIP_LIMIT_EXCEEDED');
   busy=true;ownsRequest=true;const pin=service.catalog.ensure();upload=path.join(pin.path,`upload-${randomUUID()}.zip`);
   fd=fs.openSync(upload,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);let received=0;
   for await(const chunk of req){received+=chunk.length;if(received>ZIP_IMPORT_LIMITS.archiveBytes)fail('ZIP_LIMIT_EXCEEDED');checkDirectory(pin);fs.writeFileSync(fd,chunk);}
   fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;checkDirectory(pin);
   const value=await service.importArchive({name,archivePath:upload});return respond(res,200,{ok:true,value});
  }catch(error){const code=typeof error.code==='string'?error.code:'IMPORT_FAILED';return respond(res,['NAME_EXISTS','EEXIST','IMPORT_BUSY'].includes(code)?409:400,{ok:false,error:{code,message:messages[code]??'The ZIP could not be imported. Existing repositories are unchanged. Reload the repository list before retrying.'}});}
  finally{if(fd!==undefined)fs.closeSync(fd);if(upload){try{fs.unlinkSync(upload);}catch{}}if(ownsRequest)busy=false;}
 };
}
