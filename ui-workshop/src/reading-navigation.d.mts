export type ReadingLocation={schemaVersion:1;repoId:string;repo:string;ref:string;path:string;type:'file'|'directory';mode:'preview'|'source'|'visual'|'split';editing:boolean;visual?:boolean;fragment?:string;selection:{anchor:number;head:number};scroll:{main:number;source:number;preview:number}};
export type ReadingHistoryState={back:boolean;forward:boolean;count:number;index:number};
export type ReadingHistoryTicket={token:string;location:ReadingLocation};
export type ReadingHistoryAdapter={visit(value:ReadingLocation):Promise<ReadingHistoryState>;checkpoint(value:ReadingLocation):Promise<ReadingHistoryState>;peek(direction:-1|1):Promise<ReadingHistoryTicket|null>;complete(token:string,value:ReadingLocation):Promise<ReadingHistoryState>;cancel(token:string):Promise<ReadingHistoryState>;state():Promise<ReadingHistoryState>};
export const READING_HISTORY_LIMIT:number;
export function readingLocation(value:unknown):ReadingLocation;
export class ReadingHistory {constructor(limit?:number);state():ReadingHistoryState;current():ReadingLocation|null;checkpoint(value:ReadingLocation):ReadingHistoryState;visit(value:ReadingLocation):ReadingHistoryState;peek(direction:-1|1):ReadingHistoryTicket|null;complete(token:string,value:ReadingLocation):ReadingHistoryState;cancel(token:string):ReadingHistoryState;removeRepository(repoId:string):ReadingHistoryState;renamePaths(repoId:string,moves:{from:string;to:string}[]):ReadingHistoryState;clear():ReadingHistoryState;}

export function preserveBeforeNavigation(preserve:()=>Promise<unknown>,checkpoint:()=>Promise<ReadingHistoryState|null>):Promise<{historyState:ReadingHistoryState|null;historyUnavailable:boolean}>;
