import { createHash } from 'node:crypto';
import { types } from 'node:util';

const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;

/**
 * Inspect already-read bytes without parsing, normalizing or writing source.
 * Input and returned byte arrays never share the private snapshot's storage.
 * Text and line-ending counts are derived views; original bytes are authority.
 */
export function inspectSourceBytes(input) {
  if (!types.isUint8Array(input)) {
    throw new TypeError('Source must be a Uint8Array or Buffer of original bytes.');
  }
  if (types.isSharedArrayBuffer(typedArrayBuffer.call(input))) {
    throw new TypeError('Shared source memory cannot provide a stable snapshot.');
  }

  // Buffer.slice() and TypedArray.subarray() would retain aliases to the input.
  const originalBytes = new Uint8Array(input);
  const sha256 = createHash('sha256').update(originalBytes).digest('hex');
  let text = null;
  let encoding = 'utf-8';
  try {
    // ignoreBOM means do not consume the BOM: U+FEFF remains in derived text.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    encoding = 'invalid-utf-8';
  }

  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let index = 0; index < originalBytes.length; index += 1) {
    if (originalBytes[index] === 13) {
      if (originalBytes[index + 1] === 10) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (originalBytes[index] === 10) {
      lf += 1;
    }
  }

  return Object.freeze({
    byteLength: originalBytes.byteLength,
    sha256,
    readOnly: true,
    encoding,
    text,
    hasUtf8Bom: originalBytes[0] === 0xef
      && originalBytes[1] === 0xbb
      && originalBytes[2] === 0xbf,
    lineEndings: Object.freeze({ lf, crlf, cr }),
    issues: Object.freeze(encoding === 'invalid-utf-8' ? ['invalid-utf8'] : []),
    get originalBytes() {
      return new Uint8Array(originalBytes);
    },
  });
}
