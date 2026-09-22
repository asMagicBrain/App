import type {TeachStudyCourse} from './teach-plugin-fixture';

export type TeachStudentSection = {
  id:string; title:string; source:string; recognized:boolean; empty:boolean;
  from:number; to:number; level:number;
};
export type TeachDocumentPart = {
  id:string; title:string; from:number; to:number; originalSource:string; originalPath:string;
};
export type TeachInstructorDocument = {
  source:string; path:string; parts:TeachDocumentPart[];
  aliases:{id:string;title:string;from:number}[];
};
export type TeachStudentDependency = {
  kind:'image'|'link'|'include'|'reference'; target:string; status:string; path?:string;
};
export const teachDocumentSections:readonly {readonly id:string;readonly title:string}[];
export function createTeachInstructorDocument(course:TeachStudyCourse):TeachInstructorDocument;
export function splitTeachStudentSections(source:string):TeachStudentSection[];
export function composeTeachStudentSource(sections:readonly TeachStudentSection[],ids:Iterable<string>):string;
export function rebaseTeachSource(source:string,fromPath:string,toPath:string):string;
export function inspectTeachStudentDependencies(source:string,path:string,assets?:Readonly<Record<string,string>>):TeachStudentDependency[];
