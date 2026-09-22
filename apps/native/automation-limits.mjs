/** Separate inbound intent, ordinary results and font-inclusive export bounds.
 * The durable journal remains below the shared private store's 4 MiB record cap. */
export const AUTOMATION_LIMITS = Object.freeze({
  operations: 16, textBytes: 65536, archiveBytes: 262144, resultBytes: 524288,
  exportArchiveBytes: 1048576, exportResultBytes: 1572864,
  requestBytes: 1048576, responseBytes: 2097152, journalBytes: 3145728,
});
export const automationResultLimit = kind => kind === 'export.plan' ? AUTOMATION_LIMITS.exportResultBytes : AUTOMATION_LIMITS.resultBytes;
// Only an authorized, completed export receipt receives the larger outbound
// frame. Errors, ordinary reads, catalogues and pending plans keep the old cap.
export function automationResponseLimit(reply) {
  return reply?.ok === true && reply.value?.kind === 'export.plan' && reply.value?.status === 'completed'
    && typeof reply.value?.result?.archiveBase64 === 'string'
    ? AUTOMATION_LIMITS.responseBytes : AUTOMATION_LIMITS.requestBytes;
}
