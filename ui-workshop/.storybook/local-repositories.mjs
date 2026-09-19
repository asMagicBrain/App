import path from 'node:path';
import {workspaceRoot} from './workspace-paths.mjs';
import {BUILTIN_REPOSITORIES} from '../../packages/desktop-host/src/repository-import/index.mjs';
import {readLocalRepository as readRepository} from '../../packages/desktop-host/src/repository-reader.mjs';
export const repositoryNames=BUILTIN_REPOSITORIES.map(repo=>repo.name);
const fixtureRoot=workspaceRoot;
export const readLocalRepository=(name,relative='',base=fixtureRoot,revision='')=>readRepository(name,relative,base,revision);
export async function localRepositoryResponse(req,res,port=6006,base=fixtureRoot) {
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const allowed=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!allowed.includes(req.headers.host)||(req.headers.origin&&!allowed.map(h=>`http://${h}`).includes(req.headers.origin))||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403);res.end();return;}
  try {
    const url=new URL(req.url,`http://${req.headers.host}`);
    const formats=url.searchParams.getAll('format'),format=formats[0];
    if(formats.length>1||(format!==undefined&&!['raw','download'].includes(format))){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify({error:'Unsupported response format'}));return;}
    const relative=url.searchParams.get('path')||'';
    const data=await readLocalRepository(url.searchParams.get('repo')||'Workspace',relative,base,url.searchParams.get('ref')||'');
    if(format){
      if(data.type!=='file'||typeof data.content!=='string')throw Error('Text file unavailable');
      const headers={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"};
      if(format==='download'){
        const name=path.basename(relative),fallback=name.replace(/[^A-Za-z0-9._-]/g,'_')||'file.txt';
        const encoded=encodeURIComponent(name).replace(/['()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        headers['Content-Disposition']=`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
      }
      res.writeHead(200,headers);res.end(data.content);return;
    }
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));
  } catch {res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Local repository or path unavailable'}));}
}
