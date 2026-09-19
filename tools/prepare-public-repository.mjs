/** Initialize a local, history-free publication repository from a pinned source
 * export. No remote is configured or contacted; originals are never rewritten. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isPublicSourcePath} from './public-source-policy.mjs';
import {validateRelease, releaseSourceTag} from '../apps/native/release-identity.mjs';
import {packageAttribution} from '../apps/native/product-attribution.mjs';

const appRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(a,b)=>a===b||b.startsWith(a+path.sep);
const args=process.argv.slice(2),options={};
for(const arg of args){const m=/^--(export|output|manifest-sha256)=(.+)$/.exec(arg);if(!m||m[1] in options)throw Error('Use --export=/absolute/export --manifest-sha256=REVIEWED_SHA256 --output=/absolute/new/directory');options[m[1]]=m[2];}
if(Object.keys(options).length!==3||!path.isAbsolute(options.export)||!path.isAbsolute(options.output)||!/^[a-f0-9]{64}$/.test(options['manifest-sha256']))throw Error('An exact source export, independently reviewed manifest hash and new absolute output are required.');
const sourceExport=path.resolve(options.export),output=path.resolve(options.output),source=path.join(sourceExport,'source');
if(within(appRoot,output)||within(output,appRoot)||within(sourceExport,output)||within(output,sourceExport))throw Error('Publication output must be disjoint from the source checkout and export.');
if(fs.existsSync(output))throw Error('Preserve existing publication: choose a new output directory.');
for(const folder of [sourceExport,source])if(!fs.lstatSync(folder).isDirectory()||fs.realpathSync(folder)!==folder)throw Error('Export inputs require physical directories.');
let ancestor=path.dirname(output);while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
if(!fs.lstatSync(ancestor).isDirectory()||fs.realpathSync(ancestor)!==ancestor)throw Error('Publication output requires physical ancestors.');
function physicalFile(filename){const s=fs.lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||fs.realpathSync(filename)!==filename)throw Error('Only physical ordinary input files are admitted.');return s;}
const manifestPath=path.join(sourceExport,'source-manifest.json');physicalFile(manifestPath);
const manifestBytes=fs.readFileSync(manifestPath);
if(hash(manifestBytes)!==options['manifest-sha256'])throw Error('Export manifest differs from the reviewed hash.');
const manifest=JSON.parse(manifestBytes);
if(manifest.schemaVersion!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||manifest.publication!=='prepared-local-only'||manifest.historyIncluded!==false||manifest.license!=='MIT'||!Array.isArray(manifest.files)||!manifest.files.length||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)||typeof manifest.sourceTag!=='string')throw Error('Expected a reviewed history-free source export.');
if(manifest.archive!==`asMagicBrain-${manifest.version}-source.zip`||!/^[a-f0-9]{64}$/.test(manifest.archiveSha256))throw Error('Invalid source archive identity.');
const archive=path.join(sourceExport,manifest.archive);physicalFile(archive);
if(hash(fs.readFileSync(archive))!==manifest.archiveSha256)throw Error('Source archive differs from its manifest.');
const paths=new Set(),files=[];
for(const f of manifest.files){
 if(typeof f.path!=='string'||f.path.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f\x7f]/.test(f.path)||path.isAbsolute(f.path)||!isPublicSourcePath(f.path)||paths.has(f.path)||![0o644,0o755].includes(f.mode)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid or unadmitted source manifest member.');
 paths.add(f.path);files.push(f);
}
function inventory(folder){
 const actual=[];
 function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const name=path.join(dir,ent.name),s=fs.lstatSync(name);if(s.isDirectory()&&!s.isSymbolicLink())walk(name);else{physicalFile(name);actual.push(path.relative(folder,name).split(path.sep).join('/'));}}}
 walk(folder);return actual.sort();
}
function verify(folder){
 if(JSON.stringify(inventory(folder))!==JSON.stringify([...paths].sort()))throw Error('Source membership differs from reviewed export.');
 for(const f of files){const filename=path.join(folder,f.path),s=physicalFile(filename);if(s.size!==f.bytes||(s.mode&0o777)!==f.mode||hash(fs.readFileSync(filename))!==f.sha256)throw Error('Source bytes or permissions differ from reviewed export.');}
}
verify(source);
const release=validateRelease(JSON.parse(fs.readFileSync(path.join(source,'apps/native/release.json'),'utf8')));
if(release.version!==manifest.version||releaseSourceTag(release)!==manifest.sourceTag)throw Error('Export release/tag identity mismatch.');
const attribution=packageAttribution(JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')));
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const timestamp=new Date().toISOString();
const gitEnv={...environment,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:attribution.author.name,GIT_AUTHOR_EMAIL:attribution.author.email,GIT_COMMITTER_NAME:attribution.author.name,GIT_COMMITTER_EMAIL:attribution.author.email,GIT_AUTHOR_DATE:timestamp,GIT_COMMITTER_DATE:timestamp,GIT_TERMINAL_PROMPT:'0'};
const repository=path.join(output,'repository');
function gitBytes(...command){const r=spawnSync('git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.autocrlf=false','-c','core.logAllRefUpdates=false','-c','commit.gpgSign=false','-c','tag.gpgSign=false',...command],{cwd:repository,env:gitEnv,maxBuffer:64*1024*1024});if(r.error||r.status!==0)throw Error('Local publication Git operation failed.');return r.stdout;}
const git=(...command)=>gitBytes(...command).toString('utf8').trim();
fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
if(fs.realpathSync(path.dirname(output))!==path.dirname(output))throw Error('Publication ancestor changed.');
fs.mkdirSync(output,{mode:0o700});
try{
 if(fs.realpathSync(output)!==output)throw Error('Publication destination changed.');
 fs.mkdirSync(repository,{mode:0o700});
 for(const f of files){const dest=path.join(repository,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o755});fs.writeFileSync(dest,fs.readFileSync(path.join(source,f.path)),{flag:'wx',mode:f.mode});fs.chmodSync(dest,f.mode);}
 verify(repository);verify(source);
 git('init','--initial-branch=main','--object-format=sha1','--template=');
 // All files come from the reviewed manifest; Git ignore rules cannot omit one.
 const pathspec=Buffer.from(files.map(f=>f.path).join('\0')+'\0');
 const add=spawnSync('git',['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.autocrlf=false','add','--force','--pathspec-from-file=-','--pathspec-file-nul'],{cwd:repository,env:gitEnv,input:pathspec,maxBuffer:1024*1024});if(add.error||add.status!==0)throw Error('Cannot stage exact public source.');
 git('commit','--no-gpg-sign','-m',`Initial public source: asMagicBrain v${release.version}`);
 const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),tag=releaseSourceTag(release);
 const members=gitBytes('ls-tree','-r','-z','HEAD').toString('utf8').split('\0').filter(Boolean).map(line=>{const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);if(!m)throw Error('Unexpected public Git member.');return {path:m[3],object:m[2],mode:parseInt(m[1],8)&0o777};});
 if(JSON.stringify(members.map(f=>f.path).sort())!==JSON.stringify([...paths].sort()))throw Error('Public Git membership changed.');
 for(const f of files){const m=members.find(e=>e.path===f.path);if(m.mode!==f.mode||hash(gitBytes('cat-file','blob',m.object))!==f.sha256)throw Error('Git attributes changed public source bytes.');}
 git('tag','-a',tag,'-m',`asMagicBrain v${release.version} public source`);
 if(git('rev-list','--count','--all')!=='1'||git('remote')||git('status','--porcelain=v1','--untracked-files=all')||git('rev-parse',`refs/tags/${tag}^{commit}`)!==commit||fs.existsSync(path.join(repository,'.git/logs'))||git('fsck','--no-reflogs','--unreachable'))throw Error('Public repository must contain exactly one clean root commit, one release tag and no private history.');
 if(hash(fs.readFileSync(manifestPath))!==options['manifest-sha256'])throw Error('Input manifest changed.');verify(source);
 const receipt={schemaVersion:1,status:'prepared-local-only',version:release.version,buildNumber:release.buildNumber,createdAt:timestamp,attribution,upstream:{sourceCommit:manifest.sourceCommit,sourceTag:manifest.sourceTag,manifestSha256:options['manifest-sha256'],archiveSha256:manifest.archiveSha256},publicRepository:{directory:'repository',branch:'main',sourceCommit:commit,sourceTag:tag,tree,commitCount:1,remotes:[]},files,publication:'Not uploaded. Review the exact public repository and destination before publication. Build public downloads from this public commit/tag, never relabel an internal package.'};
 const bytes=JSON.stringify(receipt,null,2)+'\n';fs.writeFileSync(path.join(output,'publication-manifest.json'),bytes,{flag:'wx'});fs.writeFileSync(path.join(output,'SHA256SUMS'),hash(bytes)+'  publication-manifest.json\n',{flag:'wx'});
 console.log(JSON.stringify({version:release.version,repository,sourceCommit:commit,sourceTag:tag,files:files.length,publication:'prepared-local-only'}));
}catch(error){fs.writeFileSync(path.join(output,'INCOMPLETE.txt'),'Public repository preparation failed. Preserve this directory for inspection.\n',{flag:'wx'});throw error;}
