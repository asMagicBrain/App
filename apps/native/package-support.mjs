import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,isBuiltin} from 'node:module';
import {parseSync} from '../../ui-workshop/node_modules/oxc-parser/src-js/index.js';
export {validateRelease} from './release-identity.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Electron's documented V1 fuse wire. Read-only: never turn an existing
// encrypted cookie store into an unencrypted one to satisfy this policy.
export function requireUnencryptedCookieStore(bytes){
 const sentinel=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
 const offset=bytes.indexOf(sentinel),start=offset+sentinel.length;
 if(offset<0||bytes.indexOf(sentinel,offset+1)!==-1||bytes[start]!==1)throw Error('Unknown Electron fuse layout.');
 const length=bytes[start+1],wire=bytes.subarray(start+2,start+2+length);
 if(length<2||wire.length!==length||!/^[01r]+$/.test(wire.toString('ascii')))throw Error('Invalid Electron fuse wire.');
 if(wire[1]!==0x30)throw Error('Session-only accounts require a runtime without OS-encrypted cookies. Preserve the runtime and profile; do not flip its cookie encryption fuse.');
 return {version:1,wire:wire.toString('ascii'),cookieEncryption:false};
}
export function assertPhysical(root,filename,{directory=false}={}){
 const relative=path.relative(root,filename);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Package input escaped the source root.');
 const stat=fs.lstatSync(filename);
 if(fs.realpathSync(filename)!==filename||stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()))throw Error(`A physical ${directory?'directory':'file'} is required: ${relative}`);
 return stat;
}
export function bundleExecutable(directory,declared){
 const macOS=path.join(directory,'Contents/MacOS');assertPhysical(directory,macOS,{directory:true});
 const names=fs.readdirSync(macOS);
 const name=declared===undefined&&names.length===1?names[0]:declared;
 if(typeof name!=='string'||!name||path.basename(name)!==name||!names.includes(name))throw Error('Bundle executable is missing or ambiguous.');
 const stat=assertPhysical(directory,path.join(macOS,name));
 if(!(stat.mode&0o111))throw Error('Bundle executable is not executable.');
 return name;
}
export function runtimeClosure(root,entries=['apps/native/main.mjs','apps/native/preload.cjs']){
 const seen=new Set(),queue=entries.map(relative=>path.resolve(root,relative));
 while(queue.length){
  const filename=queue.shift();if(seen.has(filename))continue;
  const relative=path.relative(root,filename).split(path.sep).join('/');
  if(!/^(?:apps\/native\/|packages\/)/.test(relative)||/(?:^|\/)(?:node_modules|tests?|docs|acceptance|\.git)(?:\/|$)|\.(?:test|spec)\./i.test(relative)||!['.mjs','.cjs','.js','.json'].includes(path.extname(filename)))throw Error(`Unadmitted runtime source: ${relative}`);
  assertPhysical(root,filename);seen.add(filename);if(filename.endsWith('.json'))continue;
  const source=parseSync(filename,fs.readFileSync(filename,'utf8'));
  if(source.errors.length)throw Error(`Cannot parse runtime source: ${relative}`);
  function admit(specifier){
   if(specifier==='electron'||isBuiltin(specifier))return;
   if(!specifier.startsWith('./')&&!specifier.startsWith('../'))throw Error(`Unbundled runtime dependency: ${specifier}`);
   queue.push(path.resolve(path.dirname(filename),specifier));
  }
  function literal(node){if(node?.type!=='Literal'||typeof node.value!=='string')throw Error(`Computed module import or runtime URL in ${relative}`);return node.value;}
  function visit(node){
   if(!node||typeof node!=='object')return;
   if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type)&&node.source)admit(literal(node.source));
   if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='require'){
    if(node.arguments.length!==1)throw Error(`Computed module import in ${relative}`);admit(literal(node.arguments[0]));
   }
   const base=node.arguments?.[1];
   if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='URL'&&node.arguments.length===2&&base.type==='MemberExpression'&&base.object.type==='MetaProperty'&&base.object.meta.name==='import'&&base.object.property.name==='meta'&&base.property.name==='url'){
    const target=literal(node.arguments[0]);if(target!=='.'&&!target.endsWith('/'))admit(target);
   }
   for(const value of Object.values(node))if(Array.isArray(value))for(const child of value)visit(child);else if(value&&typeof value==='object')visit(value);
  }
  visit(source.program);
 }
 return [...seen].map(filename=>path.relative(root,filename).split(path.sep).join('/')).sort();
}
export function inventory(root,{internalLinks=false}={}){
 const entries=[];
 function visit(filename,relative){
  const stat=fs.lstatSync(filename),item={path:relative,mode:stat.mode&0o777};
  if(stat.isSymbolicLink()){
   const target=fs.readlinkSync(filename),resolved=fs.realpathSync(filename);
   if(!internalLinks||path.isAbsolute(target)||!resolved.startsWith(root+path.sep))throw Error(`External/dangling package link: ${relative}`);
   item.type='symlink';item.target=target;
  }else if(stat.isFile()){item.type='file';item.bytes=stat.size;item.sha256=sha256(fs.readFileSync(filename));}
  else if(stat.isDirectory())item.type='directory';else throw Error(`Special package entry: ${relative}`);
  entries.push(item);if(item.type==='directory')for(const name of fs.readdirSync(filename).sort())visit(path.join(filename,name),relative?`${relative}/${name}`:name);
 }
 visit(root,'');return entries;
}
export function dependencyNotices(root,manifestRoots=[root,path.join(root,'ui-workshop')],{platform=process.platform,arch=process.arch}={}){
 const queue=manifestRoots.flatMap(from=>Object.keys(JSON.parse(fs.readFileSync(path.join(from,'package.json'),'utf8')).dependencies??{}).map(name=>({name,from}))),seen=new Set(),notices=[],missing=[];
 const fallbackRoot=path.join(root,'apps/native/licenses'),fallbackFile=path.join(fallbackRoot,'provenance.json');
 const fallback=fs.existsSync(fallbackFile)?JSON.parse(fs.readFileSync(fallbackFile,'utf8')):null;
 if(fallback&&(fallback.schemaVersion!==1||!Array.isArray(fallback.licenses)))throw Error('Invalid notice provenance.');
 while(queue.length){
  const {name,from}=queue.shift();const require=createRequire(path.join(from,'package.json'));
  // Some runtime packages expose subpaths only. Locate their metadata along
  // Node's ordinary package search order without importing package code.
  const directory=require.resolve.paths(name)?.map(base=>path.join(base,name)).find(base=>fs.existsSync(path.join(base,'package.json')));
  if(!directory)throw Error(`Missing package metadata for ${name}`);
  const physical=fs.realpathSync(directory);if(!physical.startsWith(root+path.sep))throw Error('Dependency notice resolved outside App.');
  if(seen.has(physical))continue;seen.add(physical);const manifest=JSON.parse(fs.readFileSync(path.join(physical,'package.json'),'utf8'));
  if(manifest.name!==name)throw Error(`Unexpected dependency metadata for ${name}`);
  const files=fs.readdirSync(physical).filter(file=>/^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(file)).filter(file=>fs.lstatSync(path.join(physical,file)).isFile());
  const location=sha256(path.relative(root,physical)).slice(0,12);
  if(!files.length){
   const matches=fallback?.licenses.filter(item=>item.name===name&&item.version===manifest.version)??[];
   if(matches.length!==1)missing.push(`${name}@${manifest.version}`);
   else{
    const item=matches[0];
    if(typeof item.file!=='string'||!/^[A-Za-z0-9_.-]+\.txt$/.test(item.file)||typeof item.sourceUrl!=='string'||!item.sourceUrl.startsWith('https://')||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid notice provenance entry.');
    const source=path.join(fallbackRoot,item.file);assertPhysical(root,source);
    if(sha256(fs.readFileSync(source))!==item.sha256)throw Error(`Notice provenance hash differs: ${name}`);
    notices.push({name,version:manifest.version,filename:'LICENSE.txt',location,source,sourceUrl:item.sourceUrl,sha256:item.sha256});
   }
  }
  for(const filename of files){assertPhysical(root,path.join(physical,filename));notices.push({name,version:manifest.version,filename,location,source:path.join(physical,filename)});}
  for(const child of Object.keys(manifest.dependencies??{}))queue.push({name:child,from:physical});
  // The ripgrep resolver ships exactly one installed platform binary. Include
  // that package's notice as well as the resolver's license.
  if(name==='@vscode/ripgrep'){const child=`@vscode/ripgrep-${platform}-${arch}`;if(!Object.hasOwn(manifest.optionalDependencies??{},child))throw Error('Unsupported ripgrep notice platform.');queue.push({name:child,from:physical});}
 }
 const searchNotice=path.join(fallbackRoot,'ripgrep-provenance.json');
 if(fs.existsSync(searchNotice)){
  assertPhysical(root,searchNotice);const item=JSON.parse(fs.readFileSync(searchNotice,'utf8'));
  if(item.schemaVersion!==1||item.name!=='ripgrep'||item.version!=='15.0.0'||item.file!=='ripgrep-15.0.0-third-party.txt'||typeof item.sourceUrl!=='string'||!item.sourceUrl.startsWith('https://github.com/BurntSushi/ripgrep/'))throw Error('Invalid bundled search notice provenance.');
  const source=path.join(fallbackRoot,item.file);assertPhysical(root,source);if(sha256(fs.readFileSync(source))!==item.sha256)throw Error('Bundled search notice bytes differ.');
  notices.push({name:item.name,version:item.version,filename:'THIRD-PARTY-NOTICES.txt',location:'bundled-search',source,sourceUrl:item.sourceUrl});
  notices.push({name:item.name,version:item.version,filename:'PROVENANCE.json',location:'bundled-search',source:searchNotice,sourceUrl:item.sourceUrl});
  if(platform==='linux'&&arch==='x64'){
   const provenance=path.join(fallbackRoot,'ripgrep-linux-x64-provenance.json');assertPhysical(root,provenance);
   const linux=JSON.parse(fs.readFileSync(provenance,'utf8'));
   if(linux.schemaVersion!==1||linux.name!=='ripgrep'||linux.version!==item.version||linux.platform!=='linux'||linux.arch!=='x64'||linux.binaryPackage!=='@vscode/ripgrep-linux-x64@1.18.0'||linux.binarySha256!=='193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21'||linux.upstreamRevision!==item.upstreamRevision||linux.commonNotice?.file!==item.file||linux.commonNotice?.sha256!==item.sha256||!Array.isArray(linux.notices)||linux.notices.length!==2)throw Error('Invalid Linux search notice provenance.');
   const expected=new Set(['rust-1.88.0-library-COPYRIGHT.html','musl-1.2.3-COPYRIGHT.txt']);
   for(const notice of linux.notices){
    if(!expected.delete(notice.file)||typeof notice.name!=='string'||typeof notice.version!=='string'||typeof notice.sourceUrl!=='string'||!notice.sourceUrl.startsWith('https://')||!/^[a-f0-9]{64}$/.test(notice.sha256))throw Error('Invalid Linux search runtime notice.');
    const source=path.join(fallbackRoot,notice.file);assertPhysical(root,source);
    if(sha256(fs.readFileSync(source))!==notice.sha256)throw Error('Linux search runtime notice bytes differ.');
    notices.push({name:notice.name,version:notice.version,filename:notice.file,location:'bundled-search-linux-runtime',source,sourceUrl:notice.sourceUrl});
   }
   notices.push({name:linux.name,version:linux.version,filename:'PROVENANCE-linux-x64.json',location:'bundled-search',source:provenance,sourceUrl:linux.sourceUrl});
  }
 }
 if(missing.length)throw Error(`Missing distributable license for ${missing.join(', ')}`);
 return notices;
}
