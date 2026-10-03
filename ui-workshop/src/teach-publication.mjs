import {splitTeachStudentSections} from './teach-document.mjs';

export const teachPublicationDestinations=Object.freeze([
  Object.freeze({id:'export',label:'Export package',description:'Prepare a portable ZIP for offline delivery.'}),
  Object.freeze({id:'github',label:'Student repository',description:'Review files for a separate student Git repository.'}),
  Object.freeze({id:'gitbook',label:'GitBook package',description:'Prepare a GitBook-compatible multipage folder.'}),
]);

const safePart=value=>String(value??'').trim().replaceAll('/','_').replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^-+|-+$/g,'')||'course';
const pagePart=(id,index)=>safePart(id==='introduction'?'introduction':id||`page-${index+1}`).toLowerCase();
export const teachStudentRepositoryName=code=>safePart(code);
export const teachPublicationTermFolder=(year,season)=>`${safePart(year)}-${safePart(season).toLowerCase()}`;
export const validTeachStudentRepository=value=>/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(String(value??'').trim())&&!/^(?:\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(String(value??'').trim());

/** Pure Storybook plan. It describes derived bytes but never writes or publishes them. */
export function createTeachPublicationPlan({course,edition,destination='export',format='multiple',repository=teachStudentRepositoryName(course?.code)}) {
  const source=String(edition?.source??''),sections=splitTeachStudentSections(source).filter(section=>section.source.trim());
  const term=teachPublicationTermFolder(course?.year,course?.season),errors=[];
  if(!source.trim())errors.push('Create a reviewed Student version before preparing output.');
  if(!validTeachStudentRepository(repository))errors.push('Enter a repository name using letters, numbers, periods, hyphens or underscores.');
  if(!teachPublicationDestinations.some(item=>item.id===destination))errors.push('Choose a supported destination.');
  if(!['single','multiple'].includes(format))errors.push('Choose one-page or multipage output.');
  const pages=format==='single'
    ?[{id:'student-course',title:'Student course',path:`${term}/README.md`,sections:sections.map(item=>item.id)}]
    :sections.map((section,index)=>({id:section.id,title:section.title,path:index===0?`${term}/README.md`:`${term}/${pagePart(section.id,index)}.md`,sections:[section.id]}));
  const files=[
    {path:'README.md',kind:'generated',description:'Course and term index'},
    {path:'asteach-course.json',kind:'generated',description:'Portable student-course metadata'},
    ...pages.map((page,index)=>({path:page.path,kind:'content',description:index===0?'Term landing and reviewed Student content':page.title})),
  ];
  if(destination==='gitbook')files.unshift({path:'.gitbook.yaml',kind:'adapter',description:'GitBook root configuration'},{path:'SUMMARY.md',kind:'adapter',description:'Generated page navigation'});
  const target=destination==='export'?`${repository}-${term}-student.zip`:destination==='github'?repository:`${repository}-gitbook`;
  return {ready:errors.length===0,errors,destination,format,repository,term,target,pages,files,sectionCount:sections.length,editionNumber:edition?.number??null,warnings:[
    'Only content in the reviewed Student version is included.',
    'Referenced local assets still require byte and permission review before native publication.',
    destination==='github'?'A future reviewed push is required; this plan does not contact GitHub.':destination==='gitbook'?'Direct GitBook synchronization is not included; this is a local compatible package.':'No ZIP is created by this Storybook preview.',
  ]};
}
