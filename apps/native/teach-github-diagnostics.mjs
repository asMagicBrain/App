/** Public diagnostics contain no request URL, credentials, contact fields or raw body. */
const messages={
 GITHUB_SEAT_LIMIT:'GitHub rejected the invitation because the organization has no available collaborator seat. An organization owner must resolve the seat limit before a fresh review.',
 GITHUB_PERMISSION_REQUIRED:'GitHub refused this request. Check repository access, organization policy and app authorization.',
 GITHUB_GRANT_REJECTED:'GitHub rejected the collaborator request. Check the account and repository invitation policy.',
 GITHUB_REPOSITORY_UNAVAILABLE:'GitHub could not find or admit the target repository.',
 GITHUB_RECONNECT_REQUIRED:'Reconnect the GitHub account before reviewing again.',
 GITHUB_OUTCOME_UNKNOWN:'The request did not return a conclusive result. Recheck GitHub before retrying.',
 GITHUB_UNAVAILABLE:'GitHub is temporarily unavailable. Recheck before retrying.'
};
const apiMessages=new Set(['Resource not accessible by integration','Resource not accessible by personal access token','Validation Failed','Not Found','Bad credentials']);
export function githubDiagnostic(code,{status,requestId,apiMessage,reason,noGrantVerified,outcome='unknown'}={}){
 return {code:/^GITHUB_[A-Z_]{1,70}$/.test(code??'')?code:'GITHUB_REQUEST_FAILED',message:messages[code]??'GitHub access could not be verified.',outcome:['rejected','unknown'].includes(outcome)?outcome:'unknown',...(Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{}),...(typeof requestId==='string'&&/^[a-zA-Z0-9:.-]{1,80}$/.test(requestId)?{requestId}:{}),...(apiMessages.has(apiMessage)?{apiMessage}:{}),...(reason==='seat_limit'?{reason}:{}),...(noGrantVerified===true?{noGrantVerified:true}:{})};
}
export function safeGitHubDiagnostic(error){
 const d=error?.diagnostic??{};
 return githubDiagnostic(error?.code,{status:d.httpStatus,requestId:d.requestId,apiMessage:d.apiMessage,reason:d.reason,noGrantVerified:d.noGrantVerified,outcome:d.outcome});
}
export function githubFailure(code,details){const diagnostic=githubDiagnostic(code,details);return Object.assign(new Error(code),{code,diagnostic,publicMessage:diagnostic.message});}
