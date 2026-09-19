import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {testRoot} from '../../tools/development-paths.mjs';
import {resolveAccountBuildConfig} from './account-build-config.mjs';
import {registrationSummary} from './github-registration.mjs';
import {packageOptions,packageIdentity} from './build-channel.mjs';
import {createBundledDocsManifest} from './bundled-docs-manifest.mjs';
import {copyGitRuntime} from './git-runtime.mjs';
import {releaseSourceTag} from './release-identity.mjs';
import {packageAttribution} from './product-attribution.mjs';
import {sha256,assertPhysical,validateRelease,runtimeClosure,inventory,dependencyNotices} from './package-support.mjs';
import {linuxPackageIdentity,linuxControl,linuxDesktopEntry,linuxAppArmorProfile,linuxMaintainerScripts,applyLinuxFuses,assertLinuxPackageModes,moveLinuxPackageEvidence} from './linux-package-policy.mjs';

if(process.platform!=='linux'||process.arch!=='x64')throw Error('Linux packages must be built on Linux x64 with the pinned inputs.');
const appRoot=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const runtime=JSON.parse(fs.readFileSync(new URL('./runtime-linux-x64.json',import.meta.url),'utf8'));
const {candidate,configuration}=packageOptions(process.argv.slice(2)),{channel}=configuration;
const release=validateRelease(JSON.parse(fs.readFileSync(new URL('./release.json',import.meta.url),'utf8')));
const attribution=packageAttribution(JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')));
const identity=linuxPackageIdentity(channel),sharedIdentity=packageIdentity({channel,bundleId:release.bundleId});
const selector=process.env.ASMB_ACCOUNT_CONFIG??'offline',accounts=resolveAccountBuildConfig(selector);
const evidence=path.join(testRoot,'runs/native-package-linux');fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const temporary=path.join(evidence,'tmp');fs.mkdirSync(temporary,{recursive:true,mode:0o700});
assertPhysical(testRoot,evidence,{directory:true});assertPhysical(testRoot,temporary,{directory:true});
const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:temporary,TMP:temporary,TEMP:temporary,
  GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',ASMB_TEST_ROOT:testRoot,ASMB_ACCOUNT_CONFIG:selector};
function run(command,args,{cwd=appRoot}={}){const r=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});if(r.error)throw r.error;if(r.status!==0)throw Error(`${path.basename(command)} failed (${r.status??r.signal}): ${(r.stderr||r.stdout||'').slice(-4096)}`);return (r.stdout??'')+(r.stderr??'');}
const git=(...args)=>run('/usr/bin/git',['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args]).trim();
const sourceCommit=git('rev-parse','HEAD'),sourceTag=releaseSourceTag(release),initialStatus=git('status','--porcelain=v1','--untracked-files=all');
function verifySource(){if(git('rev-parse','HEAD')!==sourceCommit)throw Error('Source HEAD changed while packaging.');if(!candidate&&(git('status','--porcelain=v1','--untracked-files=all')||git('rev-parse',`refs/tags/${sourceTag}^{commit}`)!==sourceCommit))throw Error('Final Linux packages require a clean exact release tag.');}
verifySource();
const parent=candidate?path.join(evidence,'candidates'):path.join(appRoot,'releases');fs.mkdirSync(parent,{recursive:true,mode:0o700});assertPhysical(path.dirname(parent),parent,{directory:true});
const suffix=candidate?`-candidate-${randomUUID()}`:'',name=`${release.version}-linux-x64-${channel}${suffix}`,destination=path.join(parent,name);
if(fs.existsSync(destination))throw Error('Linux version output already exists; preserve it.');
const stage=path.join(parent,`.staging-${name}`);fs.mkdirSync(stage,{mode:0o700});
const record=(label,value)=>fs.appendFileSync(path.join(stage,'packaging.log'),`${label}\n${value}\n`,{mode:0o600});
try{
  const archive=path.join(testRoot,'tooling-downloads',runtime.archive);assertPhysical(testRoot,archive);
  if(sha256(fs.readFileSync(archive))!==runtime.archiveSha256)throw Error('Pinned Linux Electron archive differs.');
  const extracted=path.join(stage,'runtime-input');fs.mkdirSync(extracted,{mode:0o755});
  record('runtime extraction',run('/usr/bin/unzip',['-q',archive,'-d',extracted]));
  if(fs.readFileSync(path.join(extracted,'version'),'utf8').trim()!==runtime.version)throw Error('Linux runtime version differs.');
  inventory(extracted,{internalLinks:true});
  record('native build',run(process.execPath,[path.join(appRoot,'apps/native/build.mjs')]));verifySource();
  const compiled=await import(pathToFileURL(path.join(appRoot,'apps/native/dist-host/account-config.mjs')).href);
  if(JSON.stringify(compiled.accountConfiguration)!==JSON.stringify({id:accounts.id,sha256:accounts.sha256})||JSON.stringify(compiled.applicationAccount)!==JSON.stringify(accounts.applicationAccount)||JSON.stringify(compiled.githubApp)!==JSON.stringify(accounts.githubApp))throw Error('Compiled account input differs.');
  const rootfs=path.join(stage,'rootfs'),bundle=path.join(rootfs,identity.installRoot),application=path.join(bundle,'resources/app');
  fs.mkdirSync(path.dirname(bundle),{recursive:true,mode:0o755});fs.cpSync(extracted,bundle,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
  for(const name of ['default_app.asar']){const file=path.join(bundle,'resources',name);if(fs.existsSync(file))fs.unlinkSync(file);}
  fs.renameSync(path.join(bundle,'electron'),path.join(bundle,'asmagicbrain'));
  const executable=path.join(bundle,'asmagicbrain'),fuses=applyLinuxFuses(executable);
  fs.mkdirSync(application,{mode:0o755});
  const inputs=[];
  function copy(source,relative,mode=0o644){assertPhysical(appRoot,source);const file=path.join(application,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o755});fs.copyFileSync(source,file,fs.constants.COPYFILE_EXCL);fs.chmodSync(file,mode);inputs.push({path:relative,sha256:sha256(fs.readFileSync(source)),bytes:fs.statSync(source).size});}
  for(const relative of runtimeClosure(appRoot))copy(path.join(appRoot,relative),relative);
  const search=JSON.parse(fs.readFileSync(path.join(appRoot,'apps/native/dist-host/search-runtime.json'),'utf8'));
  if(search.platform!=='linux'||search.arch!=='x64'||search.sha256!==sha256(fs.readFileSync(path.join(appRoot,'apps/native/dist-host/rg'))))throw Error('Pinned Linux search input differs.');
  copy(path.join(appRoot,'apps/native/dist-host/rg'),'apps/native/dist-host/rg',0o755);
  copy(path.join(appRoot,'apps/native/dist-host/search-runtime.json'),'apps/native/dist-host/search-runtime.json');
  const gitRelative='apps/native/dist-host/git',gitSource=path.join(appRoot,gitRelative),gitDestination=path.join(application,gitRelative);
  const copiedGit=copyGitRuntime(gitSource,gitDestination),gitManifest=JSON.parse(fs.readFileSync(path.join(gitDestination,'runtime-manifest.json'),'utf8'));
  if(gitManifest.platform!=='linux'||gitManifest.arch!=='x64')throw Error('Wrong Git platform.');
  for(const file of inventory(gitSource,{internalLinks:true}).filter(v=>v.type==='file'))inputs.push({path:`${gitRelative}/${file.path}`,sha256:file.sha256,bytes:file.bytes});
  const dist=path.join(appRoot,'apps/native/dist'),renderer=inventory(dist);
  if(!renderer.some(v=>v.path==='index.html')||renderer.some(v=>v.path.endsWith('.map')))throw Error('Invalid packaged renderer.');
  for(const file of renderer.filter(v=>v.type==='file'))copy(path.join(dist,file.path),`apps/native/dist/${file.path}`);
  const docs=createBundledDocsManifest(path.join(appRoot,'docs'),release.version);
  for(const file of docs.files)copy(path.join(appRoot,'docs',file.path),`docs/${file.path}`);
  fs.writeFileSync(path.join(application,'docs-manifest.json'),JSON.stringify(docs,null,2)+'\n',{flag:'wx',mode:0o644});
  for(const file of ['LICENSE','NOTICE'])copy(path.join(appRoot,file),file);
  const bundledGit={distribution:'desktop/dugite-native',release:copiedGit.release,gitVersion:copiedGit.gitVersion,platform:'linux',arch:'x64',manifestSha256:copiedGit.manifestSha256,correspondingSource:`${gitRelative}/licenses`};
  const metadata={schemaVersion:1,version:release.version,buildNumber:release.buildNumber,attribution,channel,buildConfiguration:configuration,sourceCommit,sourceTag:candidate?null:sourceTag,...(channel==='development'?{testRoot}:{}),candidate,
    githubRegistration:registrationSummary(accounts.githubApp),accountConfiguration:{id:accounts.id,sha256:accounts.sha256},bundledDocumentation:{version:docs.version,digest:docs.digest,fileCount:docs.files.length},
    accountRuntimePolicy:{persistence:'session',electronFuses:fuses.after},searchRuntime:search,bundledGit};
  fs.writeFileSync(path.join(application,'native-package.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o644});
  fs.writeFileSync(path.join(application,'package.json'),JSON.stringify({name:identity.name,productName:identity.productName,version:release.version,main:'apps/native/main.mjs',type:'module',license:'MIT',private:true,...attribution},null,2)+'\n',{flag:'wx',mode:0o644});
  const notices=dependencyNotices(appRoot),noticeRoot=path.join(bundle,'resources/ThirdPartyNotices');fs.mkdirSync(noticeRoot,{mode:0o755});
  for(const file of ['LICENSE','LICENSES.chromium.html'])fs.copyFileSync(path.join(extracted,file),path.join(noticeRoot,`Electron-${file}`),fs.constants.COPYFILE_EXCL);
  for(const item of notices){const dir=path.join(noticeRoot,`${item.name.replaceAll('/','--')}--${item.location}`);fs.mkdirSync(dir,{recursive:true,mode:0o755});fs.copyFileSync(item.source,path.join(dir,item.filename),fs.constants.COPYFILE_EXCL);}
  function payload(relative,bytes,mode=0o644){const file=path.join(rootfs,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o755});fs.writeFileSync(file,bytes,{flag:'wx',mode});}
  payload(`usr/share/applications/${identity.desktopId}`,linuxDesktopEntry(channel));
  payload(`usr/share/icons/hicolor/scalable/apps/${identity.name}.svg`,fs.readFileSync(path.join(appRoot,'apps/native/assets/asMagicBrain.svg')));
  payload(`etc/apparmor.d/${identity.profile}`,linuxAppArmorProfile(channel));
  // The namespace profile supplies the sandbox permission; no setuid helper is shipped.
  for(const item of inventory(rootfs,{internalLinks:true}).filter(v=>v.type!=='symlink'))fs.chmodSync(path.join(rootfs,item.path),item.type==='directory'||item.mode&0o111?0o755:0o644);
  assertLinuxPackageModes(rootfs);
  const entries=inventory(rootfs,{internalLinks:true}),control=path.join(rootfs,'DEBIAN');fs.mkdirSync(control,{mode:0o755});
  fs.writeFileSync(path.join(control,'control'),linuxControl({channel,version:release.version,attribution,installedSize:Math.ceil(entries.reduce((sum,v)=>sum+(v.bytes??0),0)/1024)}),{flag:'wx',mode:0o644});
  fs.writeFileSync(path.join(control,'conffiles'),`/etc/apparmor.d/${identity.profile}\n`,{flag:'wx',mode:0o644});
  for(const [file,bytes] of Object.entries(linuxMaintainerScripts(channel)))fs.writeFileSync(path.join(control,file),bytes,{flag:'wx',mode:0o755});
  const artifactName=`${identity.name}_${release.version}_amd64.deb`,artifact=path.join(stage,artifactName);
  record('build Debian package',run('/usr/bin/dpkg-deb',['--root-owner-group','--uniform-compression','-Zzstd','-z6','--threads-max=4','--build',rootfs,artifact]));
  record('Debian control',run('/usr/bin/dpkg-deb',['--info',artifact]));
  const roundtrip=path.join(stage,'verify-extracted');fs.mkdirSync(roundtrip,{mode:0o755});
  record('verify extracted payload',run('/usr/bin/dpkg-deb',['--extract',artifact,roundtrip]));
  if(JSON.stringify(inventory(roundtrip,{internalLinks:true}))!==JSON.stringify(entries))throw Error('Debian payload round-trip differs.');
  for(const input of inputs)if(sha256(fs.readFileSync(path.join(appRoot,input.path)))!==input.sha256)throw Error('Source/build input changed during packaging.');verifySource();
  const manifest={schemaVersion:1,kind:candidate?'candidate':'versioned-preview',...metadata,bundleId:sharedIdentity.bundleId,productName:identity.productName,createdAt:new Date().toISOString(),runtime:{version:runtime.version,platform:'linux',arch:'x64',archive:runtime.archive,archiveSha256:runtime.archiveSha256},
    distribution:{format:'deb',compression:'zstd level 6, at most 4 threads',baseline:'Ubuntu 24.04 x64',installRoot:identity.installRoot,executable:identity.executable,artifact:artifactName,sha256:sha256(fs.readFileSync(artifact)),bytes:fs.statSync(artifact).size,sandbox:'Chromium sandbox; app-specific AppArmor userns grant; no setuid helper',fuses},
    signing:'SHA-256 integrity manifest; no repository/package signing identity',candidateDirty:!!initialStatus,inputs,dependencyNotices:notices.map(({name,version,filename,location,source,sourceUrl})=>({name,version,filename,location,sha256:sha256(fs.readFileSync(source)),...(sourceUrl?{sourceUrl}:{})})),entries};
  const bytes=JSON.stringify(manifest,null,2)+'\n';fs.writeFileSync(path.join(stage,'package-manifest.json'),bytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(stage,'SHA256SUMS'),`${manifest.distribution.sha256}  ${artifactName}\n${sha256(bytes)}  package-manifest.json\n`,{flag:'wx',mode:0o600});
  // Preserve owned staging and verification trees with the build evidence, not in delivery.
  const receiptRoot=path.join(evidence,`package-inputs-${randomUUID()}`);fs.mkdirSync(receiptRoot,{mode:0o700});
  for(const dir of ['rootfs','runtime-input','verify-extracted'])moveLinuxPackageEvidence(path.join(stage,dir),path.join(receiptRoot,dir));
  fs.mkdirSync(destination,{mode:0o700});fs.renameSync(stage,destination);
  console.log(JSON.stringify({kind:manifest.kind,channel,artifact:path.join(destination,artifactName),manifest:path.join(destination,'package-manifest.json'),sourceCommit,sourceTag:metadata.sourceTag,evidence:receiptRoot}));
}catch(error){try{fs.writeFileSync(path.join(stage,'failure.json'),JSON.stringify({schemaVersion:1,message:error.message,sourceCommit,sourceTag,candidate,retainedStaging:stage},null,2)+'\n',{flag:'wx',mode:0o600});}catch{}console.error(`Linux packaging failed; staging retained at ${stage}`);throw error;}
