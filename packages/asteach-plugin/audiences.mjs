// Audience roots are explicit content boundaries, not remote access roles.
export function audienceStructure(term,entries=[]){
 const folder=`${term.year}-${term.season}`;
 if(term.audiences)return {structureVersion:2,...term.audiences};
 const files=new Set(entries.filter(e=>e.type==='file').map(e=>e.path));
 // Compatibility discovery is read-only. Never move, regenerate or rewrite a
 // migrated course just because it was opened.
 if(files.has(`${folder}/instructors/README.md`)&&files.has(`${folder}/students/README.md`))return newAudienceStructure(term);
 return null;
}
export function newAudienceStructure(term){
 const folder=`${term.year}-${term.season}`;
 return {structureVersion:2,instructors:{root:`${folder}/instructors`,home:'README.md'},students:{root:`${folder}/students`,home:'README.md'}};
}
export function audienceHome(structure,audience){const value=structure[audience];return `${value.root}/${value.home}`;}
export function validateAudiences(value,term){
 const expected=newAudienceStructure(term);
 if(!value||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['instructors','structureVersion','students'])||value.structureVersion!==2)throw Object.assign(Error('INVALID_AUDIENCE_STRUCTURE'),{code:'INVALID_AUDIENCE_STRUCTURE'});
 for(const key of ['instructors','students'])if(!value[key]||Object.keys(value[key]).length!==2||value[key].root!==expected[key].root||value[key].home!=='README.md')throw Object.assign(Error('INVALID_AUDIENCE_STRUCTURE'),{code:'INVALID_AUDIENCE_STRUCTURE'});
 return structuredClone(value);
}
