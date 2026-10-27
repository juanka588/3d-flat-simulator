import { randomFillSync } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** 26-character ULID: 48-bit millisecond time + 80 random bits, lexicographically sortable. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32]! + time;
  const bytes = randomFillSync(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}
