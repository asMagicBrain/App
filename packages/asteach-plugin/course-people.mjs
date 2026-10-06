const roles=['instructor','assistant','student'];
const repositories=['instructors','assistants','students'];
const username=v=>typeof v==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v)&&!v.includes('--');
const fail=message=>{throw Error(message);};
export function validCoursePeople(entries){
 const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
 const assignments=e=>e.assignments===undefined||Array.isArray(e.assignments)&&e.assignments.length<=3&&new Set(e.assignments.map(a=>a?.role)).size===e.assignments.length&&e.assignments.every(a=>a&&Object.keys(a).sort().join(',')==='permission,repositoryId,role'&&repositories.includes(a.role)&&/^[a-f0-9]{64}$/.test(a.repositoryId)&&['read','write'].includes(a.permission)&&(e.role!=='student'||a.role==='students'&&a.permission==='read'));
 return Array.isArray(entries)&&entries.length<=532&&entries.filter(e=>e?.role!=='student').length<=32&&entries.filter(e=>e?.role==='student').length<=500&&entries.every(e=>e&&Object.keys(e).every(k=>['login','role','firstName','lastName','email','assignments'].includes(k))&&roles.includes(e.role)&&typeof e.login==='string'&&(e.login===''||username(e.login))&&['firstName','lastName'].every(k=>e[k]===undefined||text(e[k],100))&&(e.email===undefined||text(e.email,254)&&(e.email===''||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)))&&(e.login||e.firstName||e.lastName||e.email)&&assignments(e))&&new Set(entries.filter(e=>e.login).map(e=>e.login.toLowerCase())).size===entries.filter(e=>e.login).length;
}
export function parsePeopleImport(text){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>512*1024)fail('Import must be UTF-8 CSV or TSV up to 512 KiB.');
 text=text.replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0],delimiter=first.includes('\t')?'\t':',';const rows=[];let row=[],cell='',quoted=false,afterQuote=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else cell+=c;continue;}if(c==='"'){if(cell||afterQuote)fail('Malformed quoted import cell.');quoted=true;continue;}if(c===delimiter||c==='\n'||c==='\r'){row.push(cell.trim());cell='';afterQuote=false;if(c!==delimiter){if(row.some(Boolean))rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}continue;}if(afterQuote&&!/\s/.test(c))fail('Unexpected text after a quoted cell.');cell+=c;}
 if(quoted)fail('Unclosed quoted import cell.');row.push(cell.trim());if(row.some(Boolean))rows.push(row);
 if(rows.length<2||rows.length>533)fail('Provide a header and 1–532 people.');
 const aliases={firstname:'firstName',lastname:'lastName',email:'email',github:'login',githubusername:'login',login:'login',role:'role'};
 const header=rows.shift().map(v=>aliases[v.toLowerCase().replace(/[ _-]/g,'')]);
 if(header.some(v=>!v)||new Set(header).size!==header.length)fail('Use only first_name,last_name,email,github,role columns, without duplicate headers.');
 if(!header.includes('email')&&!header.includes('login'))fail('Include an email or GitHub column to match existing people.');
 return rows.map((cells,i)=>{if(cells.length!==header.length)fail(`Row ${i+2}: column count does not match the header.`);const person=Object.fromEntries(header.map((k,n)=>[k,cells[n]]));if(person.role){person.role=person.role.toLowerCase();if(person.role==='ta')person.role='assistant';if(!roles.includes(person.role))fail(`Row ${i+2}: role must be instructor, assistant or student.`);}return person;});
}
export function reviewPeopleImport(existing,text){
 const input=parsePeopleImport(text),entries=structuredClone(existing),changes=[],touched=new Set();
 for(const [n,person] of input.entries()){
  const matching=existing.map((e,i)=>({e,i})).filter(({e})=>person.login&&e.login.toLowerCase()===person.login.toLowerCase()||person.email&&e.email?.toLowerCase()===person.email.toLowerCase());
  if(matching.length>1)fail(`Row ${n+2}: email and GitHub match different or duplicate people. Resolve the identities first.`);
  const index=matching[0]?.i??entries.length,key=index<existing.length?'existing:'+index:person.login?'github:'+person.login.toLowerCase():'email:'+person.email?.toLowerCase();
  if(touched.has(key)||input.slice(0,n).some(e=>person.login&&e.login?.toLowerCase()===person.login.toLowerCase()||person.email&&e.email?.toLowerCase()===person.email.toLowerCase()))fail(`Row ${n+2}: duplicate person in this import.`);touched.add(key);
  const before=entries[index],after={...(before??{login:'',role:'student'}),...Object.fromEntries(Object.entries(person).filter(([,v])=>v!==''))};
  if(after.role==='student'&&after.assignments)after.assignments=after.assignments.filter(a=>a.role==='students'&&a.permission==='read');
  entries[index]=after;changes.push({row:n+2,index,action:before?JSON.stringify(before)===JSON.stringify(after)?'unchanged':'update':'add',before:before??null,after});
 }
 if(!validCoursePeople(entries))fail('Import contains invalid contact details, duplicate GitHub accounts or exceeds 32 staff / 500 students.');
 return {entries,changes};
}
/** @param {any[]} entries @param {number[]} indices @param {{role?:string,permission?:string,repositoryId?:string,courseRole?:string}} options */
export function assignCoursePeople(entries,indices,{role=undefined,permission=undefined,repositoryId=undefined,courseRole=undefined}){
 const selected=new Set(indices);if(!selected.size||[...selected].some(i=>!Number.isInteger(i)||!entries[i]))fail('Select existing people first.');
 const result=entries.map((e,i)=>{if(!selected.has(i))return e;if(courseRole){const next={...e,role:courseRole};if(courseRole==='student'&&next.assignments)next.assignments=next.assignments.filter(a=>a.role==='students'&&a.permission==='read');return next;}return {...e,assignments:[...(e.assignments??[]).filter(a=>a.role!==role),{role,permission,repositoryId}]};});
 if(!validCoursePeople(result))fail('Students can only be assigned Read on Students. Check roles, repository and directory limits.');return result;
}
export function personAccess(remote,login){
 if(!login)return 'No GitHub account';if(!remote)return 'Not checked';if(!remote.accessComplete)return 'Inspection incomplete';const member=remote.collaborators?.find(e=>e.login?.toLowerCase()===login.toLowerCase()),invite=remote.invitations?.find(e=>e.login?.toLowerCase()===login.toLowerCase());
 if(member)return `Observed ${member.role}`;if(invite)return `Pending ${invite.role}`;return remote.visibility==='public'?'Public read; no listed grant':'No listed grant';
}
