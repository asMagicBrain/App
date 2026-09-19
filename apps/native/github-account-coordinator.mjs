/** Named public account operations. Secrets stay inside the auth service. */
export const githubAccountMethods = new Set([
  'getGitHubConnection', 'startGitHubConnection', 'pollGitHubConnection',
  'cancelGitHubConnection', 'cancelPendingGitHubConnection', 'openGitHubVerification', 'disconnectGitHub',
]);
const fail = code => {throw Object.assign(Error({GITHUB_BUSY: 'A GitHub account change is already in progress.', GITHUB_CANCELLED: 'GitHub connection was cancelled.', SERVICE_CLOSED: 'The window is closing.'}[code] ?? 'Invalid GitHub request.'), {code});};
export function createGitHubAccountCoordinator({auth, cloneCoordinator, updateCoordinator}) {
  let mutation = null, paused = false, epoch = 0;
  function change(action) {
    if (mutation) fail('GITHUB_BUSY');
    // Settle authenticated downloads before replacing or forgetting identity.
    // Anonymous work remains independent of the account.
    const task = Promise.resolve().then(() => cloneCoordinator.disconnect(() => updateCoordinator.disconnect(action)));
    mutation = task;
    void task.finally(() => {if (mutation === task) mutation = null;}).catch(() => {});
    return task;
  }
  async function cancelPending() {
    epoch += 1;
    await auth.cancelPending();
    await mutation?.catch(() => {});
  }
  return {
    async request(method, args) {
      if (!githubAccountMethods.has(method)) fail('INVALID_REQUEST');
      if (['getGitHubConnection', 'startGitHubConnection', 'cancelPendingGitHubConnection', 'disconnectGitHub'].includes(method) && args !== undefined) fail('INVALID_REQUEST');
      if (method === 'getGitHubConnection') return auth.getConnection();
      if (method === 'cancelPendingGitHubConnection') return cancelPending();
      if (method === 'cancelGitHubConnection') return auth.cancel(args);
      if (paused) fail('SERVICE_CLOSED');
      if (method === 'startGitHubConnection') {
        if (mutation) fail('GITHUB_BUSY');
        const expected = ++epoch;
        return change(() => {if (paused || epoch !== expected) fail('GITHUB_CANCELLED'); return auth.start();});
      }
      if (method === 'disconnectGitHub') return change(() => auth.disconnect());
      if (method === 'pollGitHubConnection') return auth.poll(args);
      return auth.openVerification(args);
    },
    async prepareClose() {
      paused = true; epoch += 1;
      await auth.prepareClose();
      await mutation?.catch(() => {});
    },
    resume() {paused = false; auth.resume();},
  };
}
