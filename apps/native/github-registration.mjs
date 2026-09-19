/** Public GitHub App identifiers only; token material is never configuration. */
const exact = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'clientId') && Object.hasOwn(value, 'slug');
// A local typo/secret guard, not proof that GitHub registered this identifier.
export function validateGitHubRegistration(value) {
  if (!exact(value)) throw Error('GitHub registration must contain only clientId and slug.');
  if (value.clientId === null && value.slug === null) return Object.freeze({clientId: null, slug: null});
  if (typeof value.clientId !== 'string' || !/^(?:Iv1\.|Iv23\.?)[A-Za-z0-9]{1,64}$/.test(value.clientId) || typeof value.slug !== 'string' || value.slug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)) {
    throw Error('Use the GitHub App public client ID and app slug together, or leave both null.');
  }
  return Object.freeze({clientId: value.clientId, slug: value.slug});
}
export function registrationSummary(value) {
  const valid = validateGitHubRegistration(value);
  return {...valid, configured: valid.clientId !== null};
}
