// Existing courses keep their bytes and paths. New courses place metadata in .asteach.
export function internalTeachPath(relative){
 if(relative==='asteach-course.json')return '.asteach/course.json';
 const match=/^(\d{4}-(?:spring|summer|autumn|winter))\/(teaching|class-pages|class-packages)\.json$/.exec(relative);
 return match?`.asteach/terms/${match[1]}/${match[2]}.json`:relative;
}
export function teachMetadataPaths(entries){
 const names=new Set(entries.map(e=>e.path));
 if(names.has('.asteach/course.json'))return entries.filter(e=>e.path==='.asteach'||e.path.startsWith('.asteach/')).map(e=>e.path);
 if(!names.has('asteach-course.json'))return [];
 return entries.filter(e=>internalTeachPath(e.path)!==e.path).map(e=>e.path);
}
