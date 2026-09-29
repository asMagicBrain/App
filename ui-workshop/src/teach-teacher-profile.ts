import type {TeachStudyCourse} from './teach-plugin-fixture';
import {teacherCountryCodes,teacherCountryName} from './teach-teacher-countries';

export type TeachPartialDate = {year:string;month:string;day:string};
export type TeachEmployment = {
  organization:string;city:string;region:string;country:string;department:string;roleTitle:string;
  startDate:TeachPartialDate;endDate:TeachPartialDate;link:string;
};
export type TeachTeacherProfile = {
  givenNames:string;familyNames:string;publishedName:string;orcidId:string;alsoKnownAs:string[];
  biography:string;emails:string[];websites:{description:string;url:string}[];keywords:string[];countries:string[];
  employment:TeachEmployment[];
};
export type TeacherProfileProblem = {field:string;message:string};
export const emptyTeacherDate = ():TeachPartialDate => ({year:'',month:'',day:''});
export const emptyTeacherEmployment = ():TeachEmployment => ({organization:'',city:'',region:'',country:'',department:'',roleTitle:'',startDate:emptyTeacherDate(),endDate:emptyTeacherDate(),link:''});
export const emptyTeacherProfile = ():TeachTeacherProfile => ({givenNames:'',familyNames:'',publishedName:'',orcidId:'',alsoKnownAs:[],biography:'',emails:[],websites:[],keywords:[],countries:[],employment:[]});
const trim=(value:string)=>value.trim();
const hasDate=(date:TeachPartialDate)=>Boolean(date.year.trim()||date.month.trim()||date.day.trim());
const hasEmployment=(item:TeachEmployment)=>Boolean(item.organization.trim()||item.city.trim()||item.region.trim()||item.country.trim()||item.department.trim()||item.roleTitle.trim()||item.link.trim()||hasDate(item.startDate)||hasDate(item.endDate));
const normalizeDate=(date:TeachPartialDate):TeachPartialDate=>({year:date.year.trim(),month:date.month.trim(),day:date.day.trim()});

/** Normalize only surrounding whitespace and empty rows; never shorten authored values. */
export function normalizeTeacherProfile(profile:TeachTeacherProfile):TeachTeacherProfile {
  return {
    givenNames:trim(profile.givenNames),familyNames:trim(profile.familyNames),publishedName:trim(profile.publishedName),orcidId:trim(profile.orcidId),
    alsoKnownAs:profile.alsoKnownAs.map(trim).filter(Boolean),biography:trim(profile.biography),emails:profile.emails.map(trim).filter(Boolean),
    websites:profile.websites.map(item=>({description:trim(item.description),url:trim(item.url)})).filter(item=>item.description||item.url),
    keywords:profile.keywords.map(trim).filter(Boolean),countries:profile.countries.map(trim).filter(Boolean),
    employment:profile.employment.filter(hasEmployment).map(item=>({...item,organization:trim(item.organization),city:trim(item.city),region:trim(item.region),country:trim(item.country),department:trim(item.department),roleTitle:trim(item.roleTitle),link:trim(item.link),startDate:normalizeDate(item.startDate),endDate:normalizeDate(item.endDate)})),
  };
}
export function safeTeacherUrl(value:string):boolean {
  try{const url=new URL(value);return /^https?:\/\//i.test(value)&&!/[\u0000-\u0020\u007f]/.test(value)&&['http:','https:'].includes(url.protocol)&&Boolean(url.hostname)&&!url.username&&!url.password;}
  catch{return false;}
}
export function validTeacherOrcid(value:string):boolean {
  if(!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(value))return false;
  const digits=value.replaceAll('-','');let total=0;
  for(const digit of digits.slice(0,15))total=(total+Number(digit))*2;
  const check=(12-total%11)%11;
  return digits[15]===(check===10?'X':String(check));
}
function dateProblem(date:TeachPartialDate,prefix:string):TeacherProfileProblem|null {
  if(!hasDate(date))return null;
  if(!/^\d{4}$/.test(date.year.trim())||Number(date.year)<1)return {field:`${prefix}.year`,message:'Enter a four-digit year from 0001 to 9999.'};
  if(date.day.trim()&&!date.month.trim())return {field:`${prefix}.month`,message:'Enter a month when a day is given.'};
  if(date.month.trim()&&(!/^\d{1,2}$/.test(date.month.trim())||Number(date.month)<1||Number(date.month)>12))return {field:`${prefix}.month`,message:'Enter a month from 1 to 12, or leave it blank.'};
  if(date.day.trim()){
    const day=Number(date.day),month=Number(date.month),year=Number(date.year);
    const limit=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
    if(!/^\d{1,2}$/.test(date.day.trim())||day<1||day>limit)return {field:`${prefix}.day`,message:'Enter a valid day for this month and year.'};
  }
  return null;
}
const dateBoundary=(date:TeachPartialDate,end:boolean)=>Number(date.year)*10000+(date.month.trim()?Number(date.month):(end?12:1))*100+(date.day.trim()?Number(date.day):(end?31:1));
export function formatTeacherDate(date:TeachPartialDate):string {
  return date.year?[date.year,...(date.month?[date.month.padStart(2,'0')]:[]),...(date.day?[date.day.padStart(2,'0')]:[])].join('-'):'';
}
/** Validate before removing blank rows, so an error points to its visible row. */
export function validateTeacherProfile(profile:TeachTeacherProfile):TeacherProfileProblem|null {
  const tooLong=(field:string,value:string,limit:number,label:string):TeacherProfileProblem|null=>value.trim().length>limit?{field,message:`${label} must be ${limit.toLocaleString('en-US')} characters or fewer. Your text has not been shortened.`}:null;
  for(const [field,limit,label] of [['givenNames',150,'Given names'],['familyNames',150,'Family names'],['publishedName',150,'Published name'],['biography',5000,'Biography']] as const){const problem=tooLong(field,profile[field],limit,label);if(problem)return problem;}
  if(profile.orcidId.trim()&&!validTeacherOrcid(profile.orcidId.trim()))return {field:'orcidId',message:'Enter a valid ORCID iD in the form 0000-0000-0000-0000. This checks its format, not ownership.'};
  for(let index=0;index<profile.alsoKnownAs.length;index++){const problem=tooLong(`alsoKnownAs.${index}`,profile.alsoKnownAs[index],255,'Also known as');if(problem)return problem;}
  for(let index=0;index<profile.emails.length;index++){
    const email=profile.emails[index].trim();if(!email)continue;
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return {field:`emails.${index}`,message:'Enter a valid email address of 254 characters or fewer.'};
  }
  const urls=new Set<string>();
  for(let index=0;index<profile.websites.length;index++){
    const website=profile.websites[index],url=website.url.trim();if(!url&&!website.description.trim())continue;
    const lengthError=tooLong(`websites.${index}.description`,website.description,350,'Description')??tooLong(`websites.${index}.url`,url,2000,'URL');if(lengthError)return lengthError;
    if(!safeTeacherUrl(url))return {field:`websites.${index}.url`,message:'Enter a full http:// or https:// URL without account credentials or spaces.'};
    const key=new URL(url).href;if(urls.has(key))return {field:`websites.${index}.url`,message:'This URL is already listed. Keep each website or social link once.'};urls.add(key);
  }
  for(let index=0;index<profile.keywords.length;index++){const problem=tooLong(`keywords.${index}`,profile.keywords[index],100,'Each keyword');if(problem)return problem;}
  for(let index=0;index<profile.countries.length;index++)if(profile.countries[index]&&!teacherCountryCodes.includes(profile.countries[index]))return {field:`countries.${index}`,message:'Choose a country or location from the list.'};
  for(let index=0;index<profile.employment.length;index++){
    const item=profile.employment[index],prefix=`employment.${index}`;if(!hasEmployment(item))continue;
    for(const [key,label] of [['organization','Organization'],['city','City'],['country','Country or location']] as const)if(!item[key].trim())return {field:`${prefix}.${key}`,message:`${label} is required for an employment entry. Complete it or remove this entry.`};
    if(!teacherCountryCodes.includes(item.country))return {field:`${prefix}.country`,message:'Choose a country or location from the list.'};
    for(const [key,label] of [['organization','Organization'],['city','City'],['region','Region, State or County'],['department','Department'],['roleTitle','Role/title']] as const){const problem=tooLong(`${prefix}.${key}`,item[key],4000,label);if(problem)return problem;}
    const linkError=tooLong(`${prefix}.link`,item.link,2000,'Link');if(linkError)return linkError;
    if(item.link.trim()&&!safeTeacherUrl(item.link.trim()))return {field:`${prefix}.link`,message:'Enter a full http:// or https:// employment link without account credentials or spaces.'};
    const dateError=dateProblem(item.startDate,`${prefix}.startDate`)??dateProblem(item.endDate,`${prefix}.endDate`);if(dateError)return dateError;
    if(item.startDate.year.trim()&&item.endDate.year.trim()&&dateBoundary(item.startDate,false)>dateBoundary(item.endDate,true))return {field:`${prefix}.endDate.year`,message:'End date must not be earlier than start date.'};
  }
  return null;
}
export function teacherProfileSummary(profile:TeachTeacherProfile):{label:string;value:string}[] {
  const p=normalizeTeacherProfile(profile),rows:{label:string;value:string}[]=[];
  const add=(label:string,value:string)=>{if(value)rows.push({label,value});};
  add('Given names',p.givenNames);add('Family names',p.familyNames);add('Published name',p.publishedName);add('ORCID iD (unverified)',p.orcidId);
  add('Also known as',p.alsoKnownAs.join('\n'));add('Email addresses',p.emails.join('\n'));
  add('Websites & social links',p.websites.map(item=>item.description?`${item.description} — ${item.url}`:item.url).join('\n'));
  add('Biography',p.biography);add('Keywords',p.keywords.join('\n'));add('Countries',p.countries.map(teacherCountryName).join('\n'));
  p.employment.forEach((item,index)=>add(`Employment ${index+1}`,[
    ['Organization',item.organization],['City',item.city],['Region, State or County',item.region],['Country or location',teacherCountryName(item.country)],
    ['Department',item.department],['Role/title',item.roleTitle],['Start date',formatTeacherDate(item.startDate)],['End date',formatTeacherDate(item.endDate)],['Link',item.link],
  ].filter(([,value])=>value).map(([label,value])=>`${label}: ${value}`).join('\n')));
  return rows;
}
// Escape authored syntax before encoding leading whitespace; the inserted entities
// prevent indented Markdown blocks without treating profile text as Markdown.
const markdownText=(value:string)=>value.replace(/[\\`*_{}\[\]()#+.!<>|~=&\-]/g,'\\$&').replace(/^[\t ]+/gm,whitespace=>[...whitespace].map(character=>character==='\t'?'&#9;':'&#32;').join(''));
/** Copy defaults into an empty teacher section once; existing sections remain byte-identical. */
export function withTeacherProfileSnapshot(course:TeachStudyCourse,profile:TeachTeacherProfile):TeachStudyCourse {
  const saved=normalizeTeacherProfile(profile);
  const problem=validateTeacherProfile(saved);if(problem)throw new Error(problem.message);
  const rows=teacherProfileSummary(saved);if(!rows.length)return course;
  return {...course,sections:course.sections.map(section=>section.id==='teaching-team'&&!section.source.trim()
    ? {...section,source:`# ${section.title}\n\n${rows.map(row=>`- **${row.label}:** ${markdownText(row.value).replace(/\r?\n/g,'  \n  ')}`).join('\n')}\n`}
    : section)};
}
