/** Read immutable host configuration before mounting the shared application.
 * Missing or inconsistent configuration must never fall back to developer UI.
 * @param {import('../../../ui-workshop/src/native-types').NativeBridge} bridge
 * @returns {Promise<import('../../../ui-workshop/src/native-types').NativeBuildConfiguration>}
 */
export async function loadNativeBuildConfiguration(bridge) {
  if (typeof bridge?.getBuildConfiguration !== 'function') {
    throw new Error('The application build configuration is unavailable.');
  }
  const value = await bridge.getBuildConfiguration();
  const development = value?.channel === 'development' && value.presentation === 'full-with-grey' &&
    value.canToggleUnavailable === true && value.validationOnly === false;
  const preview = value?.channel === 'preview' && value.presentation === 'implemented-only' &&
    value.canToggleUnavailable === false && value.validationOnly === false;
  if (!development && !preview) throw new Error('The application build configuration could not be verified.');
  return Object.freeze({...value});
}
