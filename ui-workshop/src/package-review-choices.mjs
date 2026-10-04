/** Select only additions/updates admitted as nonconflicting by the host.
 * Never replace individual choices or select deletions/conflicts in bulk. */
export function selectNonconflictingUpdates(rows,current={}) {
 const next={...current};
 for(const row of rows){
  if(next[row.path]||!row.choices?.length)continue;
  if(row.protectedDraft&&row.choices.includes('keep-current'))next[row.path]='keep-current';
  else if(!row.conflict&&!row.protectedDraft&&['add','update'].includes(row.action)&&row.choices.includes('use-incoming'))next[row.path]='use-incoming';
 }
 return next;
}
