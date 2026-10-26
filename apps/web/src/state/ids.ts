const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_CHARS);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b % 32);
}

/**
 * A ULID: 26 Crockford-base32 characters, a 48-bit millisecond timestamp followed by randomness.
 * Ids sort by creation time, and are strictly increasing within one page even inside the same
 * millisecond (the random part is incremented). `now` is injectable for tests.
 */
export function newId(now: number = Date.now()): string {
  let time = now;
  if (time > lastTime) {
    lastRandom = randomDigits();
  } else {
    time = lastTime;
    let i = RANDOM_CHARS - 1;
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
    if (i >= 0) lastRandom[i]!++;
  }
  lastTime = time;
  let t = '';
  let rest = time;
  for (let i = 0; i < 10; i++) {
    t = ALPHABET[rest % 32]! + t;
    rest = Math.floor(rest / 32);
  }
  return t + lastRandom.map((d) => ALPHABET[d]).join('');
}
