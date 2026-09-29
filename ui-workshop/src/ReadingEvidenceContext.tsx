import React from 'react';
export type ReadingEvidence={status:string;message:string;collectionId?:string;documentId?:string|null;evidence:Record<string,string>|null};
const labels:Record<string,string>={observationDate:'Observation date',build:'Build',kind:'Evidence kind',validation:'Validation declaration',scope:'Scope',supersedes:'Supersedes'};
/** Plain strings only. Author metadata cannot assert application verification. */
export function ReadingEvidenceContext({context}:{context:ReadingEvidence}){
 if(context.status==='missing')return null;
 if(context.status!=='declared')return <p className="rfe-evidence-warning">{context.message}</p>;
 return <details className="rfe-evidence-context"><summary>Evidence context · Author declared</summary><p>{context.message}</p><dl><dt>Document ID</dt><dd>{context.documentId}</dd><dt>Collection ID</dt><dd>{context.collectionId}</dd>{Object.entries(labels).flatMap(([key,label])=>context.evidence?.[key]?[<dt key={`${key}-label`}>{label}</dt>,<dd key={key}>{context.evidence[key]}</dd>]:[])}</dl></details>;
}
