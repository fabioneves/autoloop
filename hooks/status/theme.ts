// The band's palette and glyphs (docs/specs/SPEC-status-mod.md, Code style).
// Status is carried by a glyph and a word, never by color alone: text wears
// the ink colors, and the status colors go on glyphs and on the words ON,
// OFF and needs you.

export const PALETTE = Object.freeze({
  background: '#1b1c20',
  panel: '#22242a',
  card: '#282a31',
  line: '#363942',
  ink: '#e6e6e3',
  ink2: '#a3a6ad',
  ink3: '#6f737c',
  accent: '#d97b4f',
  good: '#5fb37a',
  warn: '#d9a441',
  info: '#6fa3e0',
  crit: '#e06c6c',
})

export const GLYPH = Object.freeze({
  /** The band's own mark, before the word autoloop. */
  brand: '◆',
  active: '●',
  waiting: '◷',
  needsYou: '!',
  done: '✓',
  /** Not yet; also OFF and stale, which draw hollow. */
  notYet: '○',
})
