/** Reviewed publication surface. Expanding it requires source/privacy review. */
const rootFiles=new Set(['.gitignore','.gitattributes','.gitleaks.toml','AGENTS.md','CODE_OF_CONDUCT.md','CONTRIBUTING.md','LICENSE','NOTICE','README.md','SECURITY.md','SUPPORT.md','package.json','package-lock.json']);
const directories=new Set(['.github','apps','contributing','docs','packages','tools','ui-workshop']);
const denied=/(?:^|\/)(?:\.git|node_modules|dist|dist-host|releases|private|internal|backup|evidence|test-output)(?:\/|$)|\.(?:pem|p12|pfx|key)$/i;
export function isPublicSourcePath(value){
 if(typeof value!=='string'||/[\\\x00-\x1f\x7f]/.test(value)||denied.test(value))return false;
 const parts=value.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))return false;
 if(parts.length===1)return rootFiles.has(value);
 if(!directories.has(parts[0]))return false;
 // This reviewed file contains fixed public npm install policy, no credentials.
 if(value==='ui-workshop/.npmrc')return true;
 return parts.every((p,i)=>!p.startsWith('.')||(i===0&&p==='.github')||(i===1&&parts[0]==='ui-workshop'&&p==='.storybook'));
}
