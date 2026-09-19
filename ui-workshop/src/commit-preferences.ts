export type CommitAuthorMode = 'asmagicbrain' | 'github' | 'manual';
export type CommitIdentity = {name: string; email: string};
export type CommitPreferences = {
  revision: number;
  mode: CommitAuthorMode;
  asmagicbrain: CommitIdentity;
  github: CommitIdentity;
};
export type CommitPreferencesInput = Omit<CommitPreferences, 'revision'> & {expectedRevision: number};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

/** These fields become Git author metadata, not account authentication. */
export function authorFieldError(value: string, field: 'name' | 'email'): string | null {
  const label = field === 'name' ? 'name' : 'email address';
  if (!value.trim()) return `Enter an author ${label}.`;
  if (/[\x00-\x1f\x7f-\x9f<>]/.test(value)) return `The author ${label} cannot contain control characters or < >.`;
  const bytes = encoder.encode(value);
  if (decoder.decode(bytes) !== value) return `The author ${label} contains invalid text.`;
  if (value.length > 256 || bytes.length > 1024) return `Keep the author ${label} within 256 characters.`;
  if (field === 'email' && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)) return 'Enter an email address such as name@example.com.';
  return null;
}

export function authorValid(name: string, email: string): boolean {
  return !authorFieldError(name, 'name') && !authorFieldError(email, 'email');
}

/** Manual mode deliberately ignores previously saved identities. */
export function resolveCommitAuthor(preferences: CommitPreferences | null): CommitIdentity & {source: CommitAuthorMode} {
  if (!preferences || preferences.mode === 'manual') return {name: '', email: '', source: 'manual'};
  const identity = preferences[preferences.mode];
  return {name: identity.name.trim(), email: identity.email.trim(), source: preferences.mode};
}
