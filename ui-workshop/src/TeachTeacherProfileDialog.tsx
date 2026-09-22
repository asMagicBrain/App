import React,{useId,useRef,useState} from 'react';
import {CourseDialog} from './TeachCoursesStudy';
import {teacherCountries} from './teach-teacher-countries';
import {emptyTeacherEmployment,normalizeTeacherProfile,validateTeacherProfile,type TeachTeacherProfile,type TeachEmployment,type TeachPartialDate,type TeacherProfileProblem} from './teach-teacher-profile';

type Props={profile:TeachTeacherProfile;onSave(profile:TeachTeacherProfile):void;onClose():void};
type RepeatedText='alsoKnownAs'|'emails'|'keywords'|'countries';

export function TeachTeacherProfileDialog({profile,onSave,onClose}:Props) {
  const [draft,setDraft]=useState<TeachTeacherProfile>(()=>({...profile,
    alsoKnownAs:profile.alsoKnownAs.length?[...profile.alsoKnownAs]:[''],emails:profile.emails.length?[...profile.emails]:[''],
    websites:profile.websites.length?profile.websites.map(item=>({...item})):[{description:'',url:''}],
    keywords:profile.keywords.length?[...profile.keywords]:[''],countries:profile.countries.length?[...profile.countries]:[''],
    employment:profile.employment.length?profile.employment.map(item=>({...item,startDate:{...item.startDate},endDate:{...item.endDate}})):[emptyTeacherEmployment()],
  }));
  const [error,setError]=useState<TeacherProfileProblem|null>(null);
  const form=useRef<HTMLFormElement>(null),errorId=useId();
  const focus=(name:string)=>{queueMicrotask(()=>{const control=form.current?.elements.namedItem(name);if(control instanceof HTMLElement){const details=control.closest('details');if(details)details.open=true;control.focus();}});};
  const validation=(name:string)=>({'aria-invalid':error?.field===name||undefined,'aria-describedby':error?.field===name?errorId:undefined});
  const update=(key:'givenNames'|'familyNames'|'publishedName'|'orcidId'|'biography',value:string)=>setDraft(previous=>({...previous,[key]:value}));
  const countrySelect=(name:string,value:string,onChange:(value:string)=>void)=><select name={name} value={value} onChange={event=>onChange(event.target.value)} {...validation(name)}><option value="">Select a country or location</option>{teacherCountries.map(country=><option key={country.code} value={country.code}>{country.name}</option>)}</select>;
  const textInput=(label:string,name:string,value:string,onChange:(value:string)=>void,limit?:number,type='text')=><label key={name}>{label}<input name={name} type={type} value={value} autoComplete="off" onChange={event=>onChange(event.target.value)} {...validation(name)}/>{limit&&<span className="ths-field-count" aria-hidden="true">{value.length.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}</span>}</label>;
  const repeated=(key:RepeatedText,label:string,addLabel:string,limit?:number)=><fieldset className="ths-repeat-group"><legend>{key==='emails'?'Email addresses':key==='countries'?'Countries':key==='keywords'?'Keywords':'Also known as'}</legend>
    {key==='countries'&&<p className="ths-field-help">Countries or locations where you conduct research, rather than nationality.</p>}
    {draft[key].map((value,index)=><div className="ths-repeat-row" key={index}>
      {key==='countries'?<label>{label} {index+1}{countrySelect(`${key}.${index}`,value,next=>setDraft(previous=>({...previous,[key]:previous[key].map((item,row)=>row===index?next:item)})))}</label>:textInput(`${label} ${index+1}`,`${key}.${index}`,value,next=>setDraft(previous=>({...previous,[key]:previous[key].map((item,row)=>row===index?next:item)})),limit,key==='emails'?'email':'text')}
      <button type="button" className="pws-button ths-remove" aria-label={`Remove ${label.toLowerCase()} ${index+1}`} onClick={()=>{setDraft(previous=>({...previous,[key]:previous[key].filter((_,row)=>row!==index)}));setError(null);focus(draft[key].length>1?`${key}.${Math.min(index,draft[key].length-2)}`:`add-${key}`);}}>Remove</button>
    </div>)}
    <button type="button" name={`add-${key}`} className="pws-button" onClick={()=>{setDraft(previous=>({...previous,[key]:[...previous[key],'']}));focus(`${key}.${draft[key].length}`);}}>{addLabel}</button>
  </fieldset>;
  const employmentChange=(index:number,change:Partial<TeachEmployment>)=>setDraft(previous=>({...previous,employment:previous.employment.map((item,row)=>row===index?{...item,...change}:item)}));
  const partialDate=(index:number,kind:'startDate'|'endDate',date:TeachPartialDate)=><fieldset className="ths-partial-date"><legend>{kind==='startDate'?'Start date':'End date'}</legend>{(['year','month','day'] as const).map(part=>textInput(part[0].toUpperCase()+part.slice(1),`employment.${index}.${kind}.${part}`,date[part],value=>employmentChange(index,{[kind]:{...date,[part]:value}})))}</fieldset>;
  const save=(event:React.FormEvent)=>{
    event.preventDefault();const problem=validateTeacherProfile(draft);setError(problem);
    if(problem){focus(problem.field);return;}
    onSave(normalizeTeacherProfile(draft));onClose();
  };
  return <CourseDialog title="Teacher details" onClose={onClose}><form className="ths-profile-form" ref={form} noValidate onSubmit={save} onChange={()=>setError(null)}>
    <div className="ths-orcid-import"><button type="button" className="pws-button" disabled>Import from ORCID</button><p>ORCID import is unavailable in this preview. Edits stay in asTeach and never update your ORCID record.</p></div>
    <p className="ths-profile-intro">All defaults are optional. New courses receive an editable copy; existing courses and added terms keep their own content.</p>
    <section className="ths-profile-group" data-teach-profile-group="names" aria-label="Names and ORCID iD"><h3>Names</h3>
      <div className="ths-profile-fields">{textInput('Given names','givenNames',draft.givenNames,value=>update('givenNames',value),150)}{textInput('Family names','familyNames',draft.familyNames,value=>update('familyNames',value),150)}{textInput('Published name','publishedName',draft.publishedName,value=>update('publishedName',value),150)}{textInput('ORCID iD','orcidId',draft.orcidId,value=>update('orcidId',value))}</div>
      <p className="ths-field-help">ORCID iD is optional and unverified. Enter four groups of four characters separated by hyphens; saving does not verify ownership.</p>
      {repeated('alsoKnownAs','Also known as','Add another name',255)}
    </section>
    <details className="ths-profile-group" data-teach-profile-group="contact" open><summary>Contact and links</summary>
      {repeated('emails','Email address','Add email address')}
      <fieldset className="ths-repeat-group"><legend>Websites &amp; social links</legend>{draft.websites.map((website,index)=><fieldset className="ths-website-row" key={index}><legend>Website or social link {index+1}</legend>
        <div className="ths-profile-fields">{textInput(`Description ${index+1}`,`websites.${index}.description`,website.description,value=>setDraft(previous=>({...previous,websites:previous.websites.map((item,row)=>row===index?{...item,description:value}:item)})))}{textInput(`URL ${index+1}`,`websites.${index}.url`,website.url,value=>setDraft(previous=>({...previous,websites:previous.websites.map((item,row)=>row===index?{...item,url:value}:item)})),undefined,'url')}</div>
        <button type="button" className="pws-button ths-remove" aria-label={`Remove website ${index+1}`} onClick={()=>{setDraft(previous=>({...previous,websites:previous.websites.filter((_,row)=>row!==index)}));setError(null);focus(draft.websites.length>1?`websites.${Math.min(index,draft.websites.length-2)}.description`:'add-websites');}}>Remove website</button>
      </fieldset>)}<p className="ths-field-help">Description is optional. Each listed link needs a unique http:// or https:// URL.</p><button type="button" name="add-websites" className="pws-button" onClick={()=>{setDraft(previous=>({...previous,websites:[...previous.websites,{description:'',url:''}]}));focus(`websites.${draft.websites.length}.description`);}}>Add website</button></fieldset>
    </details>
    <details className="ths-profile-group" data-teach-profile-group="about"><summary>About</summary>
      <label>Biography<textarea name="biography" rows={6} value={draft.biography} onChange={event=>update('biography',event.target.value)} {...validation('biography')}/><span className="ths-field-count" aria-hidden="true">{draft.biography.length.toLocaleString('en-US')} / 5,000 · Plain text</span></label>
      {repeated('keywords','Keyword','Add keyword',100)}{repeated('countries','Country','Add country')}
    </details>
    <details className="ths-profile-group" data-teach-profile-group="employment"><summary>Employment</summary>
      <p className="ths-field-help">An employment entry needs Organization, City, and Country or location. Other fields are optional. Dates can be a year, year and month, or full date.</p>
      {draft.employment.map((item,index)=><fieldset className="ths-employment-row" key={index}><legend>Employment {index+1}</legend><div className="ths-profile-fields">
        {textInput('Organization',`employment.${index}.organization`,item.organization,value=>employmentChange(index,{organization:value}))}
        {textInput('City',`employment.${index}.city`,item.city,value=>employmentChange(index,{city:value}))}
        {textInput('Region, State or County',`employment.${index}.region`,item.region,value=>employmentChange(index,{region:value}))}
        <label>Country or location{countrySelect(`employment.${index}.country`,item.country,value=>employmentChange(index,{country:value}))}</label>
        {textInput('Department',`employment.${index}.department`,item.department,value=>employmentChange(index,{department:value}))}
        {textInput('Role/title',`employment.${index}.roleTitle`,item.roleTitle,value=>employmentChange(index,{roleTitle:value}))}
      </div>{partialDate(index,'startDate',item.startDate)}{partialDate(index,'endDate',item.endDate)}{textInput('Link',`employment.${index}.link`,item.link,value=>employmentChange(index,{link:value}),undefined,'url')}
      <button type="button" className="pws-button ths-remove" aria-label={`Remove employment ${index+1}`} onClick={()=>{setDraft(previous=>({...previous,employment:previous.employment.filter((_,row)=>row!==index)}));setError(null);focus(draft.employment.length>1?`employment.${Math.min(index,draft.employment.length-2)}.organization`:'add-employment');}}>Remove employment</button>
      </fieldset>)}<button type="button" name="add-employment" className="pws-button" onClick={()=>{setDraft(previous=>({...previous,employment:[...previous.employment,emptyTeacherEmployment()]}));focus(`employment.${draft.employment.length}.organization`);}}>Add employment</button>
    </details>
    {error&&<p id={errorId} role="alert" className="tcs-error">{error.message}</p>}
    <footer><button type="button" className="pws-button" onClick={onClose}>Cancel</button><button type="submit" className="pws-button tcs-primary">Save teacher details</button></footer>
  </form></CourseDialog>;
}
