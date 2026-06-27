import { StringDecoder } from 'node:string_decoder';

/**
 * PTY output arrives as arbitrary byte chunks, so a multi-byte UTF-8 character
 * can be split across two SSH 'data' events. Decoding each chunk on its own with
 * Buffer.toString('utf8') turns the split halves into U+FFFD () replacement
 * characters. StringDecoder buffers the incomplete trailing bytes until the next
 * chunk completes the character.
 *
 * Use one decoder per stream: stdout and stderr are independent byte streams, so
 * a partial character on one must never be completed with bytes from the other.
 *
 * @example
 * const decode = createUtf8StreamDecoder();
 * const block = Buffer.from('█', 'utf8'); // E2 96 88
 * decode(block.subarray(0, 2)); // '' (holds the incomplete bytes)
 * decode(block.subarray(2));    // '█'
 */
export function createUtf8StreamDecoder(): (chunk: Buffer | string) => string {
  const decoder = new StringDecoder('utf8');
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk));
}
