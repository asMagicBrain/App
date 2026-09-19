import { randomUUID } from 'node:crypto';

// Accept the hyphenated UUID layout with versions 1–8 and the 10xx variant.
// Existing spelling is validated and retained; no label or path is an ID seed.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Create a new opaque UUID v4 once, when an object is explicitly created. */
export function createIdentity() {
  return randomUUID();
}

/** Validate an existing identifier without repairing or regenerating it. */
export function isIdentity(value) {
  return typeof value === 'string' && value.length === 36 && UUID_PATTERN.test(value);
}

/** Return the exact valid identifier, or reject it instead of inventing one. */
export function requireIdentity(value) {
  if (!isIdentity(value)) {
    throw new TypeError('Identity must be a hyphenated UUID with a supported version and variant.');
  }
  return value;
}
