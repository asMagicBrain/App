import {readRepository} from './native-bridge.mjs';
import React,{useEffect,useState} from 'react';
import './revision-listing.css';
type Commit={author:string;message:string;sha:string;date:string};
type Props={kind:'branches'|'tags';repository:string;branch:string;branches:string[];tags:string[];onSelect:(ref:string)=>void;onBack:()=>void};
function Unavailable({children,label}:{children:React.ReactNode;label?:string}){return <button disabled data-unavailable aria-label={label} title={label?`${label} — not implemented yet`:'Not implemented yet'}>{children}</button>}
function Icon({name}:{name:string}){const paths:Record<string,string>={tag:'M3 3h8l10 10-8 8L3 11ZM7 7h.1',copy:'M9 3h12v12H9ZM3 9v12h12',trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v6l4 2',commit:'M3 12h5m8 0h5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',archive:'M5 2h10l4 4v16H5ZM11 3v3m0 2v3m0 2v3m0 2v3',file:'M5 2h10l4 4v16H5ZM14 2v5h5',download:'M12 2v13m-5-5 5 5 5-5M3 16v6h18v-6',search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-2 4 7 7'};return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;}
export function RevisionListing({kind,repository,branch,branches,tags,onSelect,onBack}:Props){
 const [query,setQuery]=useState(''),[view,setView]=useState<'Overview'|'All'>('Overview');
 const [metadata,setMetadata]=useState<Record<string,Commit|null>>({}),[failed,setFailed]=useState<string[]>([]);
 const [expanded,setExpanded]=useState<string[]>([]);
 const names=kind==='branches'?branches:tags;
 const signature=JSON.stringify(names);
 useEffect(()=>{setQuery('');setView('Overview');setExpanded([]);},[kind,repository]);
 useEffect(()=>{
  const controller=new AbortController();let active=true;setMetadata({});setFailed([]);
  const load=async()=>{for(const name of JSON.parse(signature) as string[]){
   if(!active)return;
   const ref=`refs/${kind==='branches'?'heads':'tags'}/${name}`;
   try{const data=await readRepository({repo:repository,ref,path:''},controller.signal);if(active)setMetadata(previous=>({...previous,[name]:data.commit}));}
   catch(error){if(active)setFailed(previous=>[...previous,name]);}
  }};void load();return()=>{active=false;controller.abort();};
 },[repository,kind,signature]);
 const matching=names.filter(name=>name.toLowerCase().includes(query.toLowerCase()));
 const date=(name:string)=>{const commit=metadata[name];if(!commit?.date)return failed.includes(name)?'Unavailable':Object.hasOwn(metadata,name)?'No commits':'Loading…';const days=Math.max(0,Math.floor((Date.now()-Date.parse(commit.date))/86400000));return days===0?'today':days===1?'yesterday':`${days} days ago`;};
 const rows=(items:string[])=><div className="rl-table-scroll"><table><colgroup><col style={{width:'49%'}}/><col style={{width:'14%'}}/><col style={{width:'11%'}}/><col style={{width:'11%'}}/><col style={{width:'9%'}}/><col style={{width:'6%'}}/></colgroup><thead><tr><th>Branch</th><th>Updated</th><th>Check status</th><th>Behind <span className="rl-head-divider"/> Ahead</th><th>Pull request</th><th aria-label="Actions"/></tr></thead><tbody>{items.map(name=><tr key={name}><td><div className="rl-branch-name"><button className="rl-link" onClick={()=>onSelect(`refs/heads/${name}`)}>{name}</button><Unavailable label="Copy branch name"><Icon name="copy"/></Unavailable></div></td><td title={`${metadata[name]?.author||''} ${metadata[name]?.date||''}`}><span className="rl-author" aria-hidden="true">{metadata[name]?.author.slice(0,1)||'·'}</span>{date(name)}</td><td/><td>{name===branch&&<small className="rl-badge">Default</small>}</td><td/><td><div className="rl-branch-actions"><Unavailable label="Delete branch"><Icon name="trash"/></Unavailable><Unavailable label="Branch menu">⋯</Unavailable></div></td></tr>)}</tbody></table></div>;
 return <section className={`rl-page rl-${kind}`} aria-label={kind==='branches'?'Repository branches':'Repository tags'}>
  {kind==='branches'?<>
   <header className="rl-heading"><h1>Branches</h1><Unavailable>New branch</Unavailable></header>
   <nav className="rl-nav" aria-label="Branch categories">{(['Overview','Yours','Active','Stale','All'] as const).map(label=><button key={label} disabled={label!=='Overview'&&label!=='All'} data-unavailable={label!=='Overview'&&label!=='All'||undefined} aria-current={view===label?'page':undefined} onClick={()=>{if(label==='Overview'||label==='All')setView(label);}}>{label}</button>)}</nav>
   <div className="rl-search-wrap"><Icon name="search"/><input type="search" className="rl-search" aria-label="Search branches" placeholder="Search branches…" value={query} onChange={event=>setQuery(event.target.value)}/></div>
   {matching.length?view==='All'?<div className="rl-section"><h2>All branches</h2>{rows(matching)}</div>:<>{matching.includes(branch)&&<div className="rl-section"><h2>Default</h2>{rows([branch])}</div>}{matching.some(name=>name!==branch)&&<div className="rl-section"><h2>Other branches</h2>{rows(matching.filter(name=>name!==branch))}</div>}</>:<p className="rl-empty">{query?'No matching branches':'No local branches'}</p>}
  </>:<>
   <nav className="rl-release-tabs" aria-label="Releases and tags"><Unavailable>Releases</Unavailable><button aria-current="page">Tags</button></nav>
   <div className="rl-tag-list"><h2 className="rl-tags-heading"><Icon name="tag"/> Tags</h2>{tags.length?tags.map(name=><article className="rl-tag" key={name}><div className="rl-tag-body"><div className="rl-tag-title"><button className="rl-tag-name" onClick={()=>onSelect(`refs/tags/${name}`)}>{name}</button><button className="rl-expand" aria-label={`Show commit message for ${name}`} aria-expanded={expanded.includes(name)} disabled={!metadata[name]?.message} onClick={()=>setExpanded(previous=>previous.includes(name)?previous.filter(item=>item!==name):[...previous,name])}>…</button></div>{expanded.includes(name)&&<pre className="rl-message">{metadata[name]?.message}</pre>}<div className="rl-tag-meta"><span title={metadata[name]?.date}><Icon name="clock"/>{date(name)}</span><Unavailable><Icon name="commit"/>{metadata[name]?.sha.slice(0,7)||'Commit'}</Unavailable><Unavailable><Icon name="archive"/>zip</Unavailable><Unavailable><Icon name="archive"/>tar.gz</Unavailable><Unavailable><Icon name="file"/>Notes</Unavailable><Unavailable><Icon name="download"/>Downloads</Unavailable></div></div><div className="rl-tag-actions"><Unavailable label="Tag menu">⋯</Unavailable></div></article>):<p className="rl-empty">No local tags</p>}</div>
  </>}
 </section>;
}
