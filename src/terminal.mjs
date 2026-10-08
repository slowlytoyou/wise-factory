import { stripVTControlCharacters } from 'node:util';

const DEFAULT_FG = [200, 220, 235];
const DEFAULT_BG = [5, 10, 20];
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const widthCache = new Map();
const mark = /\p{Mark}/u;
const emoji = /\p{Emoji_Presentation}/u;
const pictograph = /\p{Extended_Pictographic}/u;

function safeText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function isWide(code) {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function graphemeWidth(grapheme) {
  if (widthCache.has(grapheme)) return widthCache.get(grapheme);
  let result = 0;
  if (grapheme.includes('\u20e3') ||
      (!grapheme.includes('\ufe0e') && emoji.test(grapheme)) ||
      (grapheme.includes('\ufe0f') && pictograph.test(grapheme))) {
    result = 2;
  } else {
    for (const character of grapheme) {
      const code = character.codePointAt(0);
      if (mark.test(character) || code === 0x200d || code === 0x200c ||
          code === 0x200b || code === 0xfeff ||
          (code >= 0xe0000 && code <= 0xe007f) ||
          (code >= 0x1160 && code <= 0x11ff)) continue;
      result = Math.max(result, isWide(code) ? 2 : 1);
    }
  }
  if (widthCache.size > 4096) widthCache.clear();
  widthCache.set(grapheme, result);
  return result;
}

/** Terminal column width, treating each emoji or Korean grapheme as one unit. */
export function displayWidth(value) {
  let width = 0;
  for (const { segment } of segmenter.segment(safeText(value))) width += graphemeWidth(segment);
  return width;
}

/** Clip without splitting graphemes, then pad to exactly `width` terminal columns. */
export function fitText(value, width) {
  const limit = Math.max(0, Math.floor(Number(width) || 0));
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(safeText(value))) {
    const size = graphemeWidth(segment);
    if (used + size > limit) break;
    if (size > 0) result += segment;
    used += size;
  }
  return result + ' '.repeat(limit - used);
}

function colorKey(value, fallback) {
  const channels = Array.isArray(value) && value.length >= 3 ? value : fallback;
  return channels.slice(0, 3).map(channel => Math.max(0, Math.min(255, Math.round(Number(channel) || 0)))).join(';');
}

function blank(fg, bg) {
  return { glyph: ' ', size: 1, fg, bg };
}

function sameRow(left, right) {
  if (!right || left.length !== right.length) return false;
  for (let x = 0; x < left.length; x++) {
    const a = left[x];
    const b = right[x];
    if (a !== b && (a.glyph !== b.glyph || a.size !== b.size || a.fg !== b.fg || a.bg !== b.bg)) return false;
  }
  return true;
}

/** A terminal cell buffer with RGB color and grapheme-safe drawing. */
export class Canvas {
  #rows;

  constructor(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError('Canvas dimensions must be finite nonnegative numbers');
    }
    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.clear();
  }

  clear(bg = DEFAULT_BG) {
    const cell = blank(colorKey(DEFAULT_FG, DEFAULT_FG), colorKey(bg, DEFAULT_BG));
    this.#rows = Array.from({ length: this.height }, () => Array(this.width).fill(cell));
    return this;
  }

  #eraseWide(row, x) {
    const cell = row[x];
    if (cell.size === 0 && x > 0) {
      const lead = row[x - 1];
      row[x - 1] = blank(lead.fg, lead.bg);
      row[x] = blank(cell.fg, cell.bg);
    } else if (cell.size === 2) {
      row[x] = blank(cell.fg, cell.bg);
      if (x + 1 < this.width) row[x + 1] = blank(cell.fg, cell.bg);
    }
  }

  #paint(x, y, glyph, size, fg, bg) {
    if (!size || y < 0 || y >= this.height || x < 0 || x + size > this.width) return 0;
    const row = this.#rows[y];
    const background = bg ?? row[x].bg;
    for (let offset = 0; offset < size; offset++) this.#eraseWide(row, x + offset);
    row[x] = { glyph, size, fg, bg: background };
    if (size === 2) row[x + 1] = { glyph: '', size: 0, fg, bg: background };
    return size;
  }

  /** Paint the first grapheme. Returns the number of columns actually painted. */
  set(x, y, character, fg = DEFAULT_FG, bg) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const glyph = segmenter.segment(safeText(character))[Symbol.iterator]().next().value?.segment;
    if (!glyph) return 0;
    return this.#paint(Math.floor(x), Math.floor(y), glyph, graphemeWidth(glyph),
      colorKey(fg, DEFAULT_FG), bg === undefined ? undefined : colorKey(bg, DEFAULT_BG));
  }

  /** Paint one line. maxWidth limits columns from x; returns columns painted. */
  text(x, y, value, fg = DEFAULT_FG, bg, maxWidth = Infinity) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    x = Math.floor(x);
    y = Math.floor(y);
    if (y < 0 || y >= this.height || x >= this.width) return 0;
    const foreground = colorKey(fg, DEFAULT_FG);
    const background = bg === undefined ? undefined : colorKey(bg, DEFAULT_BG);
    const limit = Math.min(this.width, x + Math.max(0, Math.floor(maxWidth)));
    let cursor = x;
    let painted = 0;
    for (const { segment } of segmenter.segment(safeText(value))) {
      const size = graphemeWidth(segment);
      if (cursor + size > limit) break;
      painted += this.#paint(cursor, y, segment, size, foreground, background);
      cursor += size;
    }
    return painted;
  }

  fill(x, y, width, height, character = ' ', fg = DEFAULT_FG, bg) {
    if (![x, y, width, height].every(Number.isFinite)) return this;
    const glyph = segmenter.segment(safeText(character))[Symbol.iterator]().next().value?.segment ?? ' ';
    const size = graphemeWidth(glyph);
    if (!size) return this;
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.min(this.width, left + Math.max(0, Math.floor(width)));
    const bottom = Math.min(this.height, top + Math.max(0, Math.floor(height)));
    const foreground = colorKey(fg, DEFAULT_FG);
    const background = bg === undefined ? undefined : colorKey(bg, DEFAULT_BG);
    const start = left < 0 ? left + Math.ceil(-left / size) * size : left;
    for (let row = Math.max(0, top); row < bottom; row++) {
      for (let col = start; col + size <= right; col += size) {
        this.#paint(col, row, glyph, size, foreground, background);
      }
    }
    return this;
  }

  box(x, y, width, height, { fg = DEFAULT_FG, bg, title } = {}) {
    if (![x, y, width, height].every(Number.isFinite)) return this;
    x = Math.floor(x);
    y = Math.floor(y);
    width = Math.floor(width);
    height = Math.floor(height);
    if (width < 2 || height < 2) return this;
    if (bg !== undefined) this.fill(x, y, width, height, ' ', fg, bg);
    this.fill(x + 1, y, width - 2, 1, '─', fg, bg);
    this.fill(x + 1, y + height - 1, width - 2, 1, '─', fg, bg);
    this.fill(x, y + 1, 1, height - 2, '│', fg, bg);
    this.fill(x + width - 1, y + 1, 1, height - 2, '│', fg, bg);
    this.set(x, y, '┌', fg, bg);
    this.set(x + width - 1, y, '┐', fg, bg);
    this.set(x, y + height - 1, '└', fg, bg);
    this.set(x + width - 1, y + height - 1, '┘', fg, bg);
    if (title && width > 4) this.text(x + 2, y, ` ${title} `, fg, bg, width - 4);
    return this;
  }

  plain() {
    return this.#rows.map(row => row.map(cell => cell.glyph).join('')).join('\n');
  }

  /** Render only changed rows with absolute cursor positions and no newlines. */
  render(previousCanvas = null, { color = true } = {}) {
    const previous = previousCanvas instanceof Canvas ? previousCanvas : null;
    const comparable = previous?.width === this.width && previous?.height === this.height;
    let output = '';
    for (let y = 0; y < this.height; y++) {
      const row = this.#rows[y];
      if (comparable && sameRow(row, previous.#rows[y])) continue;
      output += `\x1b[${y + 1};1H`;
      let foreground;
      let background;
      for (const cell of row) {
        if (cell.size === 0) continue;
        if (color) {
          const codes = [];
          if (foreground !== cell.fg) codes.push(`38;2;${cell.fg}`);
          if (background !== cell.bg) codes.push(`48;2;${cell.bg}`);
          if (codes.length) output += `\x1b[${codes.join(';')}m`;
          foreground = cell.fg;
          background = cell.bg;
        }
        output += cell.glyph;
      }
    }
    return color && output ? output + '\x1b[0m' : output;
  }
}
