// Modern Hangul in Unicode order, mapped to a Korean two-set keyboard.
const INITIAL = ['r', 'r', 's', 'e', 'e', 'f', 'a', 'q', 'q', 't', 't', 'd', 'w', 'w', 'c', 'z', 'x', 'v', 'g'];
const VOWEL = ['k', 'o', 'i', 'o', 'j', 'p', 'u', 'p', 'h', 'hk', 'ho', 'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l'];
const FINAL = ['r', 'r', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr', 'fa', 'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'qt', 't', 't', 'd', 'w', 'c', 'z', 'x', 'v', 'g'];
// NFKD maps the modern compatibility clusters ㅀ and ㅄ to extended initials.
const COMPATIBILITY_CLUSTERS = { 0x111a: 'fg', 0x1121: 'qt' };

/** Decode committed Hangul only; null leaves ordinary keys and modifiers alone. */
export function hangulShortcutKeys(text, key = {}) {
  if (key.ctrl || key.meta || typeof text !== 'string' || !text) return null;
  let keys = '';
  // NFKD also handles standalone compatibility jamo (ㅈ) and syllables (와).
  for (const character of text.normalize('NFKD')) {
    const code = character.codePointAt(0);
    const mapped = INITIAL[code - 0x1100] ?? VOWEL[code - 0x1161] ?? FINAL[code - 0x11a8] ?? COMPATIBILITY_CLUSTERS[code];
    if (!mapped) return null;
    keys += mapped;
  }
  return keys;
}
