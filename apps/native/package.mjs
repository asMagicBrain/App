import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolveAccountBuildConfig} from './account-build-config.mjs';
import {registrationSummary} from './github-registration.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {createBundledDocsManifest} from './bundled-docs-manifest.mjs';
import {packageOptions, packageIdentity, packageOutputName} from './build-channel.mjs';
import {copyGitRuntime} from './git-runtime.mjs';
import {releaseSourceTag} from './release-identity.mjs';
import {packageAttribution} from './product-attribution.mjs';
import {sha256,assertPhysical,validateRelease,bundleExecutable,runtimeClosure,inventory,dependencyNotices,requireUnencryptedCookieStore} from './package-support.mjs';

const appRoot=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const accountSelector=process.env.ASMB_ACCOUNT_CONFIG??'offline';
const accounts=resolveAccountBuildConfig(accountSelector);
const {candidate,configuration}=packageOptions(process.argv.slice(2));
const {channel}=configuration;
const release=validateRelease(JSON.parse(fs.readFileSync(path.join(appRoot,'apps/native/release.json'),'utf8')));
const attribution=packageAttribution(JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')));
const identity=packageIdentity({channel,bundleId:release.bundleId});
const runtime=JSON.parse(fs.readFileSync(path.join(appRoot,'apps/native/runtime.json'),'utf8'));
if(process.platform!=='darwin'||process.arch!=='arm64'||runtime.platform!=='darwin'||runtime.arch!=='arm64')throw Error('This packager supports the pinned macOS arm64 runtime only.');
assertPhysical(path.dirname(testRoot),testRoot,{directory:true});
const evidence=path.join(testRoot,'runs/native-package');fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const temporary=path.join(evidence,'tmp');fs.mkdirSync(temporary,{recursive:true,mode:0o700});
assertPhysical(testRoot,evidence,{directory:true});assertPhysical(testRoot,temporary,{directory:true});
const env={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',TMPDIR:temporary,TMP:temporary,TEMP:temporary,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',ASMB_TEST_ROOT:testRoot,ASMB_ACCOUNT_CONFIG:accountSelector};
function run(executable,words,{cwd=appRoot,combined=false}={}){
 const result=spawnSync(executable,words,{cwd,env,encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(`${path.basename(executable)} failed (${result.status??result.signal}): ${(result.stderr||result.stdout||'').slice(-4096)}`);
 return (result.stdout??'')+(combined?(result.stderr??''):'');
}
const git=(...words)=>run('/usr/bin/git',['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...words]).trim();
const sourceCommit=git('rev-parse','HEAD'),sourceTag=releaseSourceTag(release),initialStatus=git('status','--porcelain=v1','--untracked-files=all');
function verifySource(){
 if(git('rev-parse','HEAD')!==sourceCommit)throw Error('Source commit changed while packaging.');
 if(!candidate){if(git('status','--porcelain=v1','--untracked-files=all'))throw Error('Final packages require a clean tracked/untracked source tree.');if(git('rev-parse',`refs/tags/${sourceTag}^{commit}`)!==sourceCommit)throw Error('Release tag must resolve exactly to source HEAD.');}
}
verifySource();
const parent=candidate?path.join(evidence,'candidates'):path.join(appRoot,'releases');fs.mkdirSync(parent,{recursive:true,mode:0o700});assertPhysical(appRoot===parent?appRoot:path.dirname(parent),parent,{directory:true});
const destination=path.join(parent,packageOutputName({version:release.version,channel,candidate,id:randomUUID()}));
if(fs.existsSync(destination))throw Error('Version output already exists; preserve it and choose a new version.');
const stage=path.join(parent,`.staging-${release.version}-${channel}-${randomUUID()}`);fs.mkdirSync(stage,{mode:0o700});
const log=path.join(stage,'packaging.log');
const record=(label,value)=>fs.appendFileSync(log,`${label}\n${value}\n`,{mode:0o600});
const bundle=path.join(stage,'asMagicBrain.app');
try{
 const archiveCandidates=[path.join(testRoot,'tooling-downloads',runtime.archive),path.join(testRoot,'runs/native-ui-20260917/downloads',runtime.archive)];
 const archive=archiveCandidates.find(filename=>fs.existsSync(filename));if(!archive||sha256(fs.readFileSync(archive))!==runtime.archiveSha256)throw Error('The preserved pinned runtime archive is missing or its checksum differs.');
 assertPhysical(testRoot,archive);
 const runtimeDirectory=path.join(evidence,`runtime-input-${randomUUID()}`);fs.mkdirSync(runtimeDirectory,{mode:0o700});
 record('verified runtime extraction',run('/usr/bin/ditto',['-x','-k','--noqtn','--noextattr',archive,runtimeDirectory],{combined:true}));
 const runtimeApp=path.join(runtimeDirectory,'Electron.app');assertPhysical(evidence,runtimeApp,{directory:true});
 if(fs.readFileSync(path.join(runtimeDirectory,'version'),'utf8').trim()!==runtime.version)throw Error('Extracted runtime version disagrees with runtime.json.');
 inventory(runtimeApp,{internalLinks:true});
 // Build from the admitted local dependency closure; no npm install/network.
 record('native build',run(process.execPath,[path.join(appRoot,'apps/native/build.mjs')]));verifySource();
 const compiledAccounts=await import(pathToFileURL(path.join(appRoot,'apps/native/dist-host/account-config.mjs')).href);
 if(JSON.stringify(compiledAccounts.accountConfiguration)!==JSON.stringify({id:accounts.id,sha256:accounts.sha256})||JSON.stringify(compiledAccounts.applicationAccount)!==JSON.stringify(accounts.applicationAccount)||JSON.stringify(compiledAccounts.githubApp)!==JSON.stringify(accounts.githubApp))throw Error('Compiled account configuration changed or differs from the selected build configuration.');
 const closure=runtimeClosure(appRoot),dist=path.join(appRoot,'apps/native/dist');assertPhysical(appRoot,dist,{directory:true});
 const distEntries=inventory(dist);if(!distEntries.some(item=>item.path==='index.html'))throw Error('Native renderer is missing.');
 if(distEntries.some(item=>item.path.endsWith('.map')))throw Error('Source maps are not admitted release assets.');
 record('runtime copy',run('/usr/bin/ditto',['--noqtn','--noextattr',runtimeApp,bundle]));
 const framework=path.join(bundle,'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
 assertPhysical(bundle,framework);
 const accountRuntimePolicy={persistence:'session',electronFuses:requireUnencryptedCookieStore(fs.readFileSync(framework))};
 record('account runtime policy',JSON.stringify(accountRuntimePolicy));
 const contents=path.join(bundle,'Contents'),resources=path.join(contents,'Resources'),application=path.join(resources,'app');
 if(fs.existsSync(application)||fs.existsSync(path.join(resources,'app.asar')))throw Error('Unexpected application in pinned runtime.');fs.mkdirSync(application,{mode:0o755});
 // Retire only the copied vendor default app and icon from our owned staging.
 for(const name of ['default_app.asar','electron.icns']){const filename=path.join(resources,name);if(fs.existsSync(filename))fs.unlinkSync(filename);}
 const inputs=[];
 function copy(source,relative,mode=0o644){const filename=path.join(application,relative);assertPhysical(appRoot,source);fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o755});fs.copyFileSync(source,filename,fs.constants.COPYFILE_EXCL);fs.chmodSync(filename,mode);inputs.push({path:relative,sha256:sha256(fs.readFileSync(source)),bytes:fs.statSync(source).size});}
 for(const relative of closure)copy(path.join(appRoot,relative),relative);
 const searchRuntime=JSON.parse(fs.readFileSync(path.join(appRoot,'apps/native/dist-host/search-runtime.json'),'utf8'));
 const searchBinary='apps/native/dist-host/rg';
 if(searchRuntime.sha256!==sha256(fs.readFileSync(path.join(appRoot,searchBinary)))||searchRuntime.platform!=='darwin'||searchRuntime.arch!=='arm64')throw Error('Search binary input differs from verified build.');
 copy(path.join(appRoot,searchBinary),searchBinary,0o755);
 copy(path.join(appRoot,'apps/native/dist-host/search-runtime.json'),'apps/native/dist-host/search-runtime.json');
 record('verify search binary signature',run('/usr/bin/codesign',['--verify','--strict',path.join(application,searchBinary)],{combined:true}));
 const gitRelative='apps/native/dist-host/git',gitSource=path.join(appRoot,gitRelative),gitDestination=path.join(application,gitRelative);
 const copiedGit=copyGitRuntime(gitSource,gitDestination);
 const gitManifest=JSON.parse(fs.readFileSync(path.join(gitDestination,'runtime-manifest.json'),'utf8'));
 for(const entry of inventory(gitSource,{internalLinks:true}).filter(item=>item.type==='file')) inputs.push({path:`${gitRelative}/${entry.path}`,sha256:entry.sha256,bytes:entry.bytes});
 for(const item of gitManifest.machO)record('verify bundled Git signature',run('/usr/bin/codesign',['--verify','--strict',path.join(gitDestination,item.path)],{combined:true}));
 const bundledGit={distribution:'desktop/dugite-native',release:copiedGit.release,gitVersion:copiedGit.gitVersion,platform:gitManifest.platform,arch:gitManifest.arch,manifestSha256:copiedGit.manifestSha256,correspondingSource:'apps/native/dist-host/git/licenses'};
 for(const entry of distEntries.filter(item=>item.type==='file'))copy(path.join(dist,entry.path),`apps/native/dist/${entry.path}`);
 const docs=createBundledDocsManifest(path.join(appRoot,'docs'),release.version);
 for(const entry of docs.files)copy(path.join(appRoot,'docs',entry.path),`docs/${entry.path}`);
 fs.writeFileSync(path.join(application,'docs-manifest.json'),JSON.stringify(docs,null,2)+'\n',{flag:'wx',mode:0o644});
 for(const name of ['LICENSE','NOTICE'])copy(path.join(appRoot,name),name);
 const accountConfiguration={id:accounts.id,sha256:accounts.sha256};
 const bundledDocumentation={version:docs.version,digest:docs.digest,fileCount:docs.files.length};
 const metadata={schemaVersion:1,version:release.version,buildNumber:release.buildNumber,attribution,channel,buildConfiguration:configuration,sourceCommit,sourceTag:candidate?null:sourceTag,...(channel==='development'?{testRoot}:{}),candidate,githubRegistration:registrationSummary(accounts.githubApp),accountConfiguration,bundledDocumentation,accountRuntimePolicy,searchRuntime,bundledGit};
 fs.writeFileSync(path.join(application,'native-package.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o644});
 fs.writeFileSync(path.join(application,'package.json'),JSON.stringify({name:identity.packageName,productName:identity.productName,version:release.version,main:'apps/native/main.mjs',type:'module',license:'MIT',private:true,...attribution},null,2)+'\n',{flag:'wx',mode:0o644});
 const noticeRoot=path.join(resources,'ThirdPartyNotices');fs.mkdirSync(noticeRoot,{mode:0o755});
 for(const name of ['LICENSE','LICENSES.chromium.html'])fs.copyFileSync(path.join(runtimeDirectory,name),path.join(noticeRoot,`Electron-${name}`),fs.constants.COPYFILE_EXCL);
 const notices=dependencyNotices(appRoot);for(const item of notices){const directory=path.join(noticeRoot,`${item.name.replaceAll('/','--')}--${item.location}`);fs.mkdirSync(directory,{recursive:true,mode:0o755});fs.copyFileSync(item.source,path.join(directory,item.filename),fs.constants.COPYFILE_EXCL);}
 const icon=path.join(appRoot,'apps/native/assets/asMagicBrain.icns');assertPhysical(appRoot,icon);fs.copyFileSync(icon,path.join(resources,'asMagicBrain.icns'),fs.constants.COPYFILE_EXCL);
 function plist(file,key,type,value){try{run('/usr/libexec/PlistBuddy',['-c',`Delete :${key}`,file]);}catch{}if(type)run('/usr/libexec/PlistBuddy',['-c',`Add :${key} ${type} ${value}`,file]);}
 function brand(directory,name,id){
  const info=path.join(directory,'Contents/Info.plist');
  const properties=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',info]));
  const old=bundleExecutable(directory,properties.CFBundleExecutable);
  if(old!==name)fs.renameSync(path.join(directory,'Contents/MacOS',old),path.join(directory,'Contents/MacOS',name));
  for(const [key,value] of Object.entries({CFBundleName:name,CFBundleDisplayName:name,CFBundleExecutable:name,CFBundleIdentifier:id,CFBundleShortVersionString:release.version.split('-')[0],CFBundleVersion:String(release.buildNumber)}))plist(info,key,'string',value);
  plist(info,'ElectronAsarIntegrity');
 }
 const helpers=fs.readdirSync(path.join(contents,'Frameworks')).filter(name=>/^Electron Helper(?: \((?:GPU|Renderer|Plugin)\))?\.app$/.test(name));
 if(helpers.length!==4)throw Error('Unexpected Electron helper layout.');
 for(const oldName of helpers){const name=oldName.slice(0,-4).replace(/^Electron/,'asMagicBrain'),old=path.join(contents,'Frameworks',oldName),helper=path.join(contents,'Frameworks',`${name}.app`);fs.renameSync(old,helper);const kind=/\((.+)\)/.exec(name)?.[1]?.toLowerCase();brand(helper,name,`${identity.bundleId}.helper${kind?'.'+kind:''}`);}
 brand(bundle,'asMagicBrain',identity.bundleId);plist(path.join(contents,'Info.plist'),'CFBundleDisplayName','string',identity.productName);plist(path.join(contents,'Info.plist'),'CFBundleIconFile','string','asMagicBrain.icns');
 plist(path.join(contents,'Info.plist'),'LSApplicationCategoryType','string','public.app-category.productivity');
 plist(path.join(contents,'Info.plist'),'NSHumanReadableCopyright');
 run('/usr/bin/plutil',['-insert','NSHumanReadableCopyright','-string',attribution.copyright,path.join(contents,'Info.plist')]);
 // Sign physical nested code from the inside out, then each framework/helper
 // bundle and finally the outer application. No identity/keychain credentials.
 const entries=inventory(bundle,{internalLinks:true});
 const nested=[];
 for(const entry of entries.filter(item=>item.type==='file')){
  const filename=path.join(bundle,entry.path),fd=fs.openSync(filename,'r'),header=Buffer.alloc(4);try{fs.readSync(fd,header,0,4,0);}finally{fs.closeSync(fd);}
  if(['cffaedfe','cefaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(header.toString('hex'))&&entry.path!=='Contents/MacOS/asMagicBrain'&&entry.path!=='Contents/Resources/app/'+searchBinary&&!entry.path.startsWith('Contents/Resources/app/'+gitRelative+'/'))nested.push(filename);
 }
 for(const filename of nested.sort((a,b)=>b.length-a.length))record('sign nested',run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',filename],{combined:true}));
 const bundles=entries.filter(item=>item.type==='directory'&&/\.(?:app|framework)$/.test(item.path)).map(item=>path.join(bundle,item.path)).sort((a,b)=>b.length-a.length);
 for(const filename of bundles)record('sign bundle',run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',filename],{combined:true}));
 record('sign application',run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',bundle],{combined:true}));
 record('verify signature',run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',bundle],{combined:true}));
 record('signature details',run('/usr/bin/codesign',['--display','--verbose=4',bundle],{combined:true}));
 for(const input of inputs)if(sha256(fs.readFileSync(path.join(appRoot,input.path)))!==input.sha256)throw Error('Source/build input changed while packaging.');verifySource();
 const manifest={schemaVersion:1,kind:candidate?'candidate':'versioned-preview',...metadata,bundleId:identity.bundleId,productName:identity.productName,createdAt:new Date().toISOString(),runtime:{version:runtime.version,platform:runtime.platform,arch:runtime.arch,archive:runtime.archive,archiveSha256:runtime.archiveSha256},signing:'ad-hoc; codesign --verify --deep --strict passed; no Developer ID/notarization',inputs,dependencyNotices:notices.map(({name,version,filename,location,source,sourceUrl})=>({name,version,filename,location,sha256:sha256(fs.readFileSync(source)),...(sourceUrl?{sourceUrl}: {})})),candidateDirty:!!initialStatus,entries:inventory(bundle,{internalLinks:true})};
 const manifestBytes=JSON.stringify(manifest,null,2)+'\n';fs.writeFileSync(path.join(stage,'package-manifest.json'),manifestBytes,{flag:'wx',mode:0o600});fs.writeFileSync(path.join(stage,'SHA256SUMS'),`${sha256(manifestBytes)}  package-manifest.json\n`,{flag:'wx',mode:0o600});
 // An exclusive reservation prevents concurrent builders from replacing a
 // completed version, including an existing empty directory.
 fs.mkdirSync(destination,{mode:0o700});fs.renameSync(stage,destination);
 console.log(JSON.stringify({kind:manifest.kind,channel,bundle:path.join(destination,'asMagicBrain.app'),manifest:path.join(destination,'package-manifest.json'),sourceCommit,sourceTag:metadata.sourceTag}));
}catch(error){try{fs.writeFileSync(path.join(stage,'failure.json'),JSON.stringify({schemaVersion:1,message:error.message,sourceCommit,sourceTag,candidate,retainedStaging:stage},null,2)+'\n',{flag:'wx',mode:0o600});}catch{}console.error(`Packaging failed; staging retained at ${stage}`);throw error;}
