import {validRepositoryName, validCreationId} from '../../packages/desktop-host/src/repository-import/index.mjs';

const fail = code => {throw Object.assign(new Error(code), {code});};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** An accepted local publication drains to a durable result before close.
 * Unlike acquisition, it cannot be cancelled halfway through file publication. */
export function createApplyCoordinator({apply}) {
  const jobs = new Map();
  let active = null, paused = false, closing = false;
  function applyRepositoryUpdate(input) {
    try {
      if (paused || closing) fail('SERVICE_CLOSED');
      if (!exact(input, ['repo', 'checkId', 'reviewId', 'requestId']) || !validRepositoryName(input.repo) ||
          !['checkId', 'reviewId', 'requestId'].every(key => validCreationId(input[key]))) fail('INVALID_REQUEST');
      const request = {repo: input.repo, checkId: input.checkId, reviewId: input.reviewId, requestId: input.requestId};
      const signature = JSON.stringify(request), previous = jobs.get(request.requestId);
      if (previous) {
        if (previous.signature !== signature) fail('REQUEST_CONFLICT');
        return previous.promise;
      }
      if (active) fail('APPLY_BUSY');
      while (jobs.size >= 64) jobs.delete(jobs.keys().next().value);
      const job = {requestId: request.requestId, signature, phase: 'preparing', promise: null};
      jobs.set(job.requestId, job); active = job;
      job.promise = Promise.resolve().then(() => apply(request, {onProgress: event => {
        if (event?.phase === 'preparing' || event?.phase === 'applying') job.phase = event.phase;
      }})).then(result => {job.phase = 'complete'; return result;}, error => {job.phase = 'failed'; throw error;})
        .finally(() => {if (active === job) active = null;});
      void job.promise.catch(() => {});
      return job.promise;
    } catch (error) {return Promise.reject(error);}
  }
  const drain = async () => {if (active) await active.promise.catch(() => {});};
  return {
    applyRepositoryUpdate,
    getRepositoryApplyProgress(input) {
      if (!exact(input, ['requestId']) || !validCreationId(input.requestId)) fail('INVALID_REQUEST');
      const job = jobs.get(input.requestId); if (!job) fail('APPLY_NOT_FOUND');
      return {requestId: job.requestId, phase: job.phase};
    },
    prepareClose: async () => {paused = true; await drain();},
    resume: () => {paused = false;},
    drain,
    close: async () => {closing = true; await drain();},
  };
}
