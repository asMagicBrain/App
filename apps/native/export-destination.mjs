import fs from 'node:fs';
import path from 'node:path';
import {pinDirectory,checkDirectory,contains} from '../../packages/desktop-host/src/physical-roots.mjs';
/** Native Save dialog supplies this path. Renderer never supplies destinations. */
export function saveExportDestination(filename,bytes,forbiddenRoots=[]){
 if(typeof filename!=='string'||!path.isAbsolute(filename)||path.normalize(filename)!==filename||path.extname(filename).toLowerCase()!=='.zip')throw Error('Choose a ZIP destination.');
 const parent=pinDirectory(path.dirname(filename));
 if(forbiddenRoots.some(root=>contains(root,filename)))throw Error('Save exported copies outside your managed workspace and application state.');
 let fd,identity;
 try{checkDirectory(parent);fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);identity=fs.fstatSync(fd);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);checkDirectory(parent);const live=fs.lstatSync(filename);if(live.dev!==identity.dev||live.ino!==identity.ino)throw Error('The export destination changed.');const directory=fs.openSync(parent.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
 catch(error){if(identity){try{const live=fs.lstatSync(filename);if(live.dev===identity.dev&&live.ino===identity.ino)fs.unlinkSync(filename);}catch{}}if(error.code==='EEXIST')throw Error('This file already exists. Choose a different filename.');throw error;}
 finally{if(fd!==undefined)fs.closeSync(fd);}
 return {saved:true,filename:path.basename(filename)};
}
