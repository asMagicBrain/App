import {canonicalGitHubUrl} from '../../packages/desktop-host/src/local-git/github-clone.mjs';
import {validRepositoryName, validCreationId} from '../../packages/desktop-host/src/repository-import/index.mjs';

const fail = code => {throw Object.assign(new Error(code), {code});};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const phases = new Set(['connecting', 'receiving', 'checking', 'publishing']);

/** In-memory job status contains no credentials or provider output. */
export function createCloneCoordinator({clone, getCredential}) {
  const jobs = new Map();
  let active = null, closing = false, paused = false, disconnecting = false;
  function find(input) {
    if (!exact(input, ['requestId']) || !validCreationId(input.requestId)) fail('INVALID_REQUEST');
    const job = jobs.get(input.requestId);
    if (!job) fail('CLONE_NOT_FOUND');
    return job;
  }
  function cloneRepository(input) {
    try {
      if (closing || paused) fail('SERVICE_CLOSED');
      if (!exact(input, ['url', 'name', 'requestId', 'useAccount']) || !validCreationId(input.requestId) || typeof input.useAccount !== 'boolean') fail('INVALID_REQUEST');
      if (input.useAccount && disconnecting) fail('GITHUB_BUSY');
      if (!validRepositoryName(input.name)) fail('INVALID_REPOSITORY_NAME');
      const request = {url: canonicalGitHubUrl(input.url), name: input.name, requestId: input.requestId};
      const signature = JSON.stringify({...request, useAccount: input.useAccount});
      const previous = jobs.get(request.requestId);
      if (previous && previous.signature !== signature) fail('REQUEST_CONFLICT');
      if (previous && (previous.phase === 'complete' || active === previous)) return previous.promise;
      if (active) fail('CLONE_BUSY');
      while (jobs.size >= 64) jobs.delete(jobs.keys().next().value);
      const controller = new AbortController();
      const job = {requestId: request.requestId, signature, controller, phase: 'connecting', promise: null, authenticated: input.useAccount};
      jobs.set(job.requestId, job); active = job;
      job.promise = (async () => {
        let credential;
        try {
          if (input.useAccount) credential = await getCredential();
          if (controller.signal.aborted) fail('CLONE_CANCELLED');
          const result = await clone(request, {signal: controller.signal, credential,
            onProgress: event => {if (phases.has(event?.phase)) job.phase = event.phase;}});
          // Cancellation after durable publication cannot undo a managed repo.
          job.phase = 'complete';
          return result;
        } catch (error) {
          job.phase = error?.code === 'CLONE_CANCELLED' ? 'cancelled' : 'failed';
          throw error;
        } finally {credential = undefined; if (active === job) active = null;}
      })();
      // A caller may navigate away, but a rejected job must stay observed.
      void job.promise.catch(() => {});
      return job.promise;
    } catch (error) {return Promise.reject(error);}
  }
  async function cancelJob(job) {
    if (active === job) job.controller.abort();
    await job.promise.catch(() => {});
  }
  return {
    cloneRepository,
    getCloneProgress: input => {const job = find(input); return {requestId: job.requestId, phase: job.phase};},
    cancelClone: input => cancelJob(find(input)),
    cancelAuthenticated: async () => {if (active?.authenticated) await cancelJob(active);},
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
