// Lexical portability checks only. The future native adapter MUST additionally
// validate filesystem identity, symlinks and apply-time containment.
export function portablePathKey(value) { return value.normalize('NFC').toUpperCase(); }
// Read-only intake can preserve locally valid names that are not portable to
// every platform. This never authorizes writing/renaming them or decoding URLs.
export function isInspectableRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.length || value.length > 1024) return false;
  if (value === '.') return allowRoot;
  if (value.startsWith('/') || /[\\\x00-\x1f\x7f]/u.test(value)) return false;
  return value.split('/').every(segment => segment && segment !== '.' && segment !== '..'
    && Buffer.byteLength(segment) <= 255 && segment.toLowerCase() !== '.git');
}
export function isPortableRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024 || !value.length) return false;
  if (value === '.') return allowRoot;
  if (value.startsWith('/') || /[\\\x00-\x1f\x7f:*?"<>|%]/u.test(value)) return false;
  return value.split('/').every(segment => segment && segment !== '.' && segment !== '..'
    && segment.length <= 255 && !/[. ]$/u.test(segment)
    && !/^\s/u.test(segment) && segment.toLowerCase() !== '.git'
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(segment));
}
export function pathsOverlap(left, right) {
  const a = portablePathKey(left), b = portablePathKey(right);
  return a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
