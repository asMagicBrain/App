/** @param {{builtin?: string, readOnly?: boolean} | undefined} entry */
export const isDocumentationRepository = entry => entry?.builtin === 'documentation' && entry.readOnly === true;

/** Preserve the caller's order while keeping host-owned documentation last.
 * @template {{builtin?: string, readOnly?: boolean}} T
 * @param {readonly T[]} entries
 * @returns {T[]}
 */
export function documentationLast(entries) {
  return [...entries.filter(entry => !isDocumentationRepository(entry)), ...entries.filter(isDocumentationRepository)];
}
