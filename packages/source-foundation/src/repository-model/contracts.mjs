/** Inert Stage-2 model. No filesystem, credentials, network, or runtime migration. */
export const MODEL_VERSION = 1;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/u.test(v);
const id = v => typeof v === 'string' && /^[1-9][0-9]*$/u.test(v);
const sha = v => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const host = v => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(v) && !v.includes('..');
const result = errors => ({ ok: errors.length === 0, errors });
const issue = (errors, valid, field) => { if (!valid) errors.push(field); };
const fieldsByKind = {
  'github-repository': ['host', 'id', 'owner', 'name', 'private', 'defaultBranch'],
  'local-root': ['localRootId', 'localOwnerId', 'label'],
  'local-checkout': ['checkoutId', 'localOwnerId', 'localRootId', 'generation', 'repository', 'head'],
  'private-document-state': ['localOwnerId', 'checkoutId', 'documentId', 'path', 'baseRevision'],
  'remote-browse': ['repository', 'ref', 'commitSha', 'generation'],
  'git-tree-entry': ['path', 'sha', 'mode', 'type'],
  'git-commit': ['sha', 'treeSha', 'parents'],
};
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function base(value, kind) {
  const errors = [];
  if (!record(value)) return ['record'];
  issue(errors, value.schemaVersion === MODEL_VERSION, 'schemaVersion');
  issue(errors, value.kind === kind, 'kind');
  issue(errors, exact(value, ['schemaVersion', 'kind', ...fieldsByKind[kind]]), 'fields');
  return errors;
}
function safe(value, test, kind) {
  if (!record(value)) return result(['record']);
  const errors = base(value, kind);
  test(errors);
  return result(errors);
}
function requiredText(errors, value, fields) {
  for (const field of fields) issue(errors, text(value[field]), field);
}
export function normalizeRepositoryPath(value, { allowRoot = false } = {}) {
  if (value === '' && allowRoot) return '';
  if (!text(value) || value.includes('\\') || value.startsWith('/') || /^[a-z]:/iu.test(value)) throw new TypeError('Expected a safe repository-relative path');
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new TypeError('Unsafe repository path segment');
  // Reject ambiguity instead of repairing it. Never case-fold, trim, decode URLs or normalize Unicode.
  return value;
}
function path(value, allowRoot = false) {
  try { return normalizeRepositoryPath(value, { allowRoot }) === value; } catch { return false; }
}
export function validateGitHubOwner(value) {
  if (!record(value)) return result(['owner']);
  return result([...(!exact(value, ['id', 'login', 'type']) ? ['fields'] : []), ...(!id(value.id) ? ['id'] : []), ...(!text(value.login) ? ['login'] : []), ...(!['User', 'Organization'].includes(value.type) ? ['type'] : [])]);
}
export function validateRepositoryRecord(value) {
  return safe(value, errors => {
    issue(errors, host(value.host), 'host');
    issue(errors, id(value.id), 'id');
    issue(errors, validateGitHubOwner(value.owner).ok, 'owner');
    requiredText(errors, value, ['name']);
    issue(errors, typeof value.private === 'boolean', 'private');
    issue(errors, value.defaultBranch === null || validBranch(value.defaultBranch), 'defaultBranch');
  }, 'github-repository');
}
function remoteId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (id(value)) return value;
  throw new TypeError('GitHub IDs require positive decimal strings or safe integers');
}
export function projectGitHubRepository(value, { host: apiHost = 'github.com' } = {}) {
  if (!record(value) || !record(value.owner)) throw new TypeError('Expected GitHub repository data');
  const projected = {
    schemaVersion: MODEL_VERSION, kind: 'github-repository', host: apiHost,
    id: remoteId(value.id), name: value.name,
    owner: { id: remoteId(value.owner.id), login: value.owner.login, type: value.owner.type },
    private: value.private, defaultBranch: value.default_branch ?? null,
  };
  if (!validateRepositoryRecord(projected).ok) throw new TypeError('Invalid GitHub repository');
  return projected;
}
export function repositoryIdentityKey(value) {
  if (!record(value) || !host(value.host) || !id(value.id)) throw new TypeError('Invalid repository identity');
  return JSON.stringify(['github-repository', value.host, value.id]);
}
export function validateLocalRoot(value) {
  return safe(value, errors => {
    requiredText(errors, value, ['localRootId', 'localOwnerId', 'label']);
    // Private physical location is held separately by the host, not a renderer DTO.
    issue(errors, !('repositoryId' in value) && !('githubUserId' in value) && !('absolutePath' in value), 'localOnly');
  }, 'local-root');
}
export function validateCheckout(value) {
  return safe(value, errors => {
    requiredText(errors, value, ['checkoutId', 'localOwnerId', 'localRootId']);
    issue(errors, Number.isSafeInteger(value.generation) && value.generation >= 0, 'generation');
    issue(errors, value.repository === null || (exact(value.repository, ['host', 'id']) && host(value.repository.host) && id(value.repository.id)), 'repository');
    issue(errors, value.head === null || (exact(value.head, ['commitSha', 'branch']) && sha(value.head.commitSha) && (value.head.branch === null || validBranch(value.head.branch))), 'head');
  }, 'local-checkout');
}
export function validateBaseRevision(value) {
  if (!record(value)) return result(['baseRevision']);
  const errors = [];
  issue(errors, exact(value, ['contentHash', 'commitSha']), 'fields');
  issue(errors, typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(value.contentHash), 'contentHash');
  issue(errors, value.commitSha === null || sha(value.commitSha), 'commitSha');
  return result(errors);
}
export function validateDocumentState(value) {
  return safe(value, errors => {
    requiredText(errors, value, ['localOwnerId', 'checkoutId', 'documentId']);
    issue(errors, path(value.path), 'path');
    issue(errors, validateBaseRevision(value.baseRevision).ok, 'baseRevision');
  }, 'private-document-state');
}
export function privateDocumentKey(value) {
  if (!record(value) || !['localOwnerId', 'checkoutId', 'documentId'].every(field => text(value[field]))) throw new TypeError('Invalid private document identity');
  return JSON.stringify(['private-document', MODEL_VERSION, value.localOwnerId, value.checkoutId, value.documentId]);
}
export function revisionDocumentKey(value) {
  const key = privateDocumentKey(value);
  if (!validateBaseRevision(value.baseRevision).ok) throw new TypeError('Invalid base revision');
  return JSON.stringify([key, value.baseRevision.contentHash, value.baseRevision.commitSha]);
}
function validBranch(value) {
  return text(value) && value !== '@' && !value.startsWith('-') && !/[ ~^:?*\[\\]/u.test(value) && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && value.split('/').every(p => p !== '' && !p.startsWith('.') && !p.endsWith('.lock'));
}
export function validateRemoteSelection(value) {
  return safe(value, errors => {
    issue(errors, exact(value.repository, ['host', 'id']) && host(value.repository.host) && id(value.repository.id), 'repository');
    issue(errors, typeof value.ref === 'string' && value.ref.startsWith('refs/heads/') && validBranch(value.ref.slice(11)), 'ref');
    issue(errors, sha(value.commitSha), 'commitSha');
    issue(errors, Number.isSafeInteger(value.generation) && value.generation >= 0, 'generation');
    issue(errors, !('checkoutId' in value), 'remoteBrowseOnly');
  }, 'remote-browse');
}
export function createRemoteSelection({ repository, ref, commitSha, generation }) {
  const value = { schemaVersion: MODEL_VERSION, kind: 'remote-browse', repository: { host: repository?.host, id: repository?.id }, ref, commitSha, generation };
  if (!validateRemoteSelection(value).ok) throw new TypeError('Invalid remote browse selection');
  return value;
}
export function validateTreeEntry(value) {
  return safe(value, errors => {
    issue(errors, path(value.path), 'path');
    issue(errors, sha(value.sha), 'sha');
    const modes = { '100644': 'blob', '100755': 'blob', '120000': 'blob', '040000': 'tree', '160000': 'commit' };
    issue(errors, Object.hasOwn(modes, value.mode) && modes[value.mode] === value.type, 'mode/type');
  }, 'git-tree-entry');
}
export function validateCommit(value) {
  return safe(value, errors => {
    issue(errors, sha(value.sha), 'sha');
    issue(errors, sha(value.treeSha), 'treeSha');
    issue(errors, Array.isArray(value.parents) && value.parents.every(sha), 'parents');
  }, 'git-commit');
}
export function findPathCollisions(paths, { caseSensitive = true, unicodeNormalization = null } = {}) {
  if (!Array.isArray(paths) || typeof caseSensitive !== 'boolean' || ![null, 'NFC', 'NFD'].includes(unicodeNormalization)) throw new TypeError('Invalid collision policy');
  const groups = new Map();
  for (const original of paths) {
    let key = normalizeRepositoryPath(original);
    if (unicodeNormalization) key = key.normalize(unicodeNormalization);
    if (!caseSensitive) key = key.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(original); groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length > 1);
}
