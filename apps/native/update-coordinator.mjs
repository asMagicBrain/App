import {validRepositoryName, validCreationId} from '../../packages/desktop-host/src/repository-import/index.mjs';

const fail = code => {throw Object.assign(new Error(code), {code});};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const phases = new Set(['connecting', 'receiving', 'comparing']);

/** Host-only credentials and cancellation. Completed jobs retain plain DTOs,
 * never Git subprocess output or credentials. No working-tree update is offered. */
export function createUpdateCoordinator({check, getCredential}) {
  const jobs = new Map();
  let active = null, closing = false, paused = false, disconnecting = false;
  function find(input) {
    if (!exact(input, ['requestId']) || !validCreationId(input.requestId)) fail('INVALID_REQUEST');
    const job = jobs.get(input.requestId);
    if (!job) fail('UPDATE_NOT_FOUND');
    return job;
  }
  function checkRepositoryUpdates(input) {
    try {
      if (closing || paused) fail('SERVICE_CLOSED');
      if (!exact(input, ['repo', 'requestId', 'useAccount']) || !validCreationId(input.requestId) || !validRepositoryName(input.repo) || typeof input.useAccount !== 'boolean') fail('INVALID_REQUEST');
      if (input.useAccount && disconnecting) fail('GITHUB_BUSY');
      const request = {repo: input.repo, requestId: input.requestId};
      const signature = JSON.stringify({...request, useAccount: input.useAccount});
      const previous = jobs.get(request.requestId);
      if (previous && previous.signature !== signature) fail('REQUEST_CONFLICT');
      if (previous && (previous.phase === 'complete' || active === previous)) return previous.promise;
      if (active) fail('UPDATE_BUSY');
      while (jobs.size >= 64) jobs.delete(jobs.keys().next().value);
      const controller = new AbortController();
      const job = {requestId: request.requestId, signature, controller, phase: 'connecting', promise: null, authenticated: input.useAccount};
      jobs.set(job.requestId, job); active = job;
      job.promise = (async () => {
        let credential;
        try {
          if (input.useAccount) credential = await getCredential();
          if (controller.signal.aborted) fail('UPDATE_CANCELLED');
          const result = await check(request, {signal: controller.signal, credential,
            onProgress: event => {if (phases.has(event?.phase)) job.phase = event.phase;}});
          job.phase = 'complete';
          return result;
        } catch (error) {
          job.phase = ['UPDATE_CANCELLED', 'UPDATES_CANCELLED'].includes(error?.code) ? 'cancelled' : 'failed';
          throw error;
        } finally {credential = undefined; if (active === job) active = null;}
      })();
      void job.promise.catch(() => {});
      return job.promise;
    } catch (error) {return Promise.reject(error);}
  }
  async function cancelJob(job) {
    if (active === job) job.controller.abort();
    await job.promise.catch(() => {});
  }
  return {
    checkRepositoryUpdates,
    getRepositoryUpdateProgress: input => {const job = find(input); return {requestId: job.requestId, phase: job.phase};},
    cancelRepositoryUpdate: input => cancelJob(find(input)),
    prepareClose: async () => {paused = true; if (active) await cancelJob(active);},
    resume: () => {paused = false;},
    disconnect: async action => {
      if (disconnecting) fail('GITHUB_BUSY');
      disconnecting = true;
      try {if (active?.authenticated) await cancelJob(active); return await action();}
      finally {disconnecting = false;}
    },
    drain: async () => {if (active) await active.promise.catch(() => {});},
    close: async () => {closing = true; if (active) await cancelJob(active);},
  };
}
