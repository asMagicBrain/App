export type PackageChoice = 'keep-current' | 'use-incoming' | 'keep-both';
export type PackageWarning = {path?: string; code: string; message: string};
export type PackageRow = {path: string; action?: 'register'|'preserve'|'unchanged'|'add'|'update'|'remove'|'conflict'; owned?: boolean; baseHash?:string|null; currentHash?:string|null; incomingHash?:string|null; conflict?:boolean; protectedDraft?:boolean; choices?:PackageChoice[]; base?:string|null; current?:string|null; incoming?:string|null; sha256?:string; bytes?:number};
export type ExchangeLimits = {files:number;changedFiles:number;memberBytes:number;updateMemberBytes:number;totalBytes:number;retainedBytes:number;reviewMs:number;operations:number};
export type PackageReview = {schemaVersion:1;kind:'register'|'update'|'export';planId:string;expiresAt:number;packageDigest:string|null;collectionId:string;version:string;semantics:'snapshot'|'patch'|null;rows:PackageRow[];drafts:string[];warnings:PackageWarning[];excluded:{path:string;reason:'suspected-credential-filename'}[];fileCount:number;limits:ExchangeLimits};
export type ExchangeStatus = {schemaVersion:1;registration:{collectionId:string;version:string;ownedFiles:number}|null;recoveryRequired:boolean;pending:{operationId:string;direction:'apply'|'rollback';phase:string;completed:number;total:number;paths:string[]}|null;operations:{operationId:string;status:'completed'|'rolled-back'|'pending'|'interrupted';version:string;createdAt:number;paths:string[];canRollback:boolean}[];limits:ExchangeLimits};
export type ExchangeResult = {status:'completed'|'rolled-back';operationId:string;changedPaths:string[];createdDirectories:string[]};
export type OfflineRenderer = (input:{files:{path:string;bytes:Uint8Array}[];analyzeOnly:boolean}) => {files?:{path:string;bytes:Uint8Array}[];warnings:PackageWarning[]};
export declare const EXCHANGE_LIMITS:Readonly<ExchangeLimits>;
export declare function createPackageExchange(options:{sourceRoot:string;sourceBindingRoot?:string;privateRoot:string;getDraftPaths?:()=>string[]|Promise<string[]>;renderOffline?:OfflineRenderer;hooks?:{at?:(phase:string,value?:unknown)=>void;transactionAt?:(phase:string,index?:number)=>void;checkCancelled?:()=>void}}):Readonly<{
 registrationReview(input:{archive:Uint8Array;collectionId?:string;version?:string}):Promise<PackageReview>;
 registerBase(input:{planId:string}|{archive:Uint8Array;collectionId?:string;version?:string}):Promise<ExchangeStatus>;
 reviewUpdate(input:{archive:Uint8Array;semantics?:'snapshot'|'patch';version?:string}):Promise<PackageReview>;
 /** operationId is trusted-host-only receipt correlation; retries use status, never reapply. */
 apply(input:{planId:string;choices:{path:string;choice:PackageChoice}[];operationId?:string}):Promise<ExchangeResult>;
 rollback(input:{operationId:string}):Promise<ExchangeResult>;
 recover(input?:{operationId?:string;direction?:'resume'|'rollback'}):Promise<ExchangeResult>;
 status():ExchangeStatus;
 reviewExport(input?:{collectionId?:string;version?:string}):Promise<PackageReview>;
 buildExport(input:{planId:string;kind?:'source'|'offline'}):Promise<{schemaVersion:1;kind:'source'|'offline';bytes:Uint8Array;sha256:string;filename:string;fileCount:number;warnings:PackageWarning[]}>;
 cancelPlan(planId:string):{status:'cancelled'|'absent'};
}>;
