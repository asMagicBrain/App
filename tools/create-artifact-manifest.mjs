import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ARTIFACT_LIMITS,artifactPath,pinDirectory,prepareArtifactSnapshot,validateArtifactManifest} from '../apps/native/artifact-snapshot.mjs';

/** Explicit file inventory only. Never evaluates repository scripts or discovers
 * dependencies by running an imported project. All paths share a physical root. */
export function buildArtifactManifest({root,id,title,entry,fallback,assets=[],poster}) {
  const pinned=pinDirectory(root),files=[...new Set([entry,fallback,...assets,...(poster?[poster]:[])])];
  const inventory=files.map(relative=>{
    if(!artifactPath(relative))throw Error('Use portable paths within the manifest folder.');
    const filename=path.join(pinned.path,relative),stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.nlink!==1||fs.realpathSync(filename)!==filename)throw Error('Only physical regular local files are admitted.');
    const limit=/\.(?:woff2|ttf|otf)$/i.test(relative)?ARTIFACT_LIMITS.fontBytes:ARTIFACT_LIMITS.fileBytes;if(stat.size>limit)throw Error('Asset exceeds its bounded file budget.');
    const bytes=fs.readFileSync(filename);
    return {path:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:relative===entry?'entry':relative===fallback?'fallback':/\.m?js$/i.test(relative)?'script':/\.css$/i.test(relative)?'style':'data'};
  });
  return validateArtifactManifest({schemaVersion:1,id,title,entryPath:entry,fallbackPath:fallback,...(poster?{posterPath:poster}:{}),network:'none',assets:inventory});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=key=>args.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
  const root=get('root'),output=get('output');
  if(!root||!path.isAbsolute(root)||!artifactPath(output)||!output.endsWith('.artifact.json')||output.includes('/'))throw Error('Provide an absolute physical --root and a simple --output=name.artifact.json.');
  const manifest=buildArtifactManifest({root,id:get('id'),title:get('title'),entry:get('entry'),fallback:get('fallback'),poster:get('poster'),assets:args.filter(a=>a.startsWith('--asset=')).map(a=>a.slice(8))});
  const target=path.join(root,output),temporary=path.join(root,`manifest-${randomUUID()}.artifact.json`);
  if(fs.existsSync(target)&&!args.includes('--replace'))throw Error('Manifest exists. Review changed files and pass --replace to regenerate hashes.');
  if(fs.existsSync(target)&&(!fs.lstatSync(target).isFile()||fs.realpathSync(target)!==target))throw Error('Existing manifest is not a physical regular file.');
  fs.writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  prepareArtifactSnapshot({root:pinDirectory(root),path:path.basename(temporary)});
  fs.renameSync(temporary,target);
  process.stdout.write(`Manifest saved and admission verified: ${output}\n`);
}
