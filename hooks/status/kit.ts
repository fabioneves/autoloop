// The kit (docs/specs/SPEC-central.md, item 15): the palette, the glyphs and
// small pure builders over the surface's element table. Status is carried by
// a glyph and a word, never by color alone: text wears the theme's text
// colors, and the status colors go on glyphs and on the words ON, UP, OFF
// and needs you. Every builder returns a plain element tree and holds no `$`.
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

/** Theme keys only, so the drawing follows the person's theme (light or dark). */
export const PALETTE = Object.freeze({
  ink: 'text',
  ink2: 'subtle',
  ink3: 'inactive',
  /** The needs-you strip's background. */
  card: 'inactive',
  accent: 'claude',
  good: 'success',
  warn: 'warning',
  crit: 'error',
})

export const GLYPH = Object.freeze({
  /** The band's own mark, before the word autoloop. */
  brand: '◆',
  active: '●',
  waiting: '◷',
  needsYou: '!',
  done: '✓',
  failed: '✗',
  /** Not yet; also OFF and stale, which draw hollow. */
  notYet: '○',
  /** Half: a proxy that answers without a status. */
  half: '◐',
  /** Running, resumed, a control that resumes. */
  play: '▶',
  /** A reasoning tick. */
  thinking: '⋯',
  /** Between the band's cells. */
  rule: '│',
  /** A step announced, in the log. */
  step: '→',
  /** The run paused. */
  paused: '⏸',
  /** A log event with no state of its own: a label, a control. */
  dot: '·',
})

// What the text it draws may not carry (an operand of an event, a stream
// line, an issue title: none is the mod's own): the escape sequences a
// terminal would act on, and the controls that move or hide text.
const STRINGS = /\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu
const BIDI = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu

/**
 * The text with its control sequences removed, nothing in their place: the
 * OSC, DCS, APC, PM and SOS strings, the CSI sequences, the C0 set but the
 * tab, DEL, the C1 set, and the bidi and zero-width controls. Applied where
 * a text from outside the mod reaches a Text or a toast.
 */
export function plain(text: string): string {
  return text.replace(STRINGS, '').replace(CSI, '').replace(CONTROLS, '').replace(BIDI, '')
}

/** The three elements every builder draws with, as `$.ui.resolve(e)` hands them out. */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** A header row: `left` at the edge, `right` dim at the other, one row. */
export function header(k: Kit, left: RenderChildren, right: RenderChildren | null = null): RenderElement {
  return k.Box({ justifyContent: 'space-between', children: [
    k.Text({ color: PALETTE.ink, wrap: 'truncate-end', children: left }),
    right === null ? null : k.Text({ color: PALETTE.ink2, children: right }),
  ] })
}

/** A dim upper-case label row. */
export function label(k: Kit, text: string): RenderElement {
  return k.Text({ color: PALETTE.ink2, dimColor: true, children: text.toUpperCase() })
}

/** A section: its dim label over its rows; stack sections in a column with `gap={1}`. */
export function section(k: Kit, title: string, rows: RenderChildren[]): RenderElement {
  return k.Box({ flexDirection: 'column', children: [label(k, title), ...rows] })
}

export type Tab = { label: string; hotkey: string; active: boolean; onPress: () => void }

/** A row of plain digit-hotkey buttons, the active one primary. */
export function tabs(k: Kit, items: Tab[]): RenderElement {
  return k.Box({ gap: 1, children: items.map((tab) => k.Button({
    key: `tab-${tab.hotkey}`, label: tab.label, hotkey: tab.hotkey, plain: true,
    ...(tab.active ? { variant: 'primary' as const } : {}), onPress: tab.onPress,
  })) })
}

/** A number (or a short text) right-aligned in a fixed width. */
export function num(k: Kit, value: number | string, width: number): RenderElement {
  return k.Text({ color: PALETTE.ink, children: String(value).padStart(width) })
}

/** What an empty section or tab says, dim. */
export function empty(k: Kit, text: string): RenderElement {
  return k.Text({ color: PALETTE.ink2, children: text })
}

/** A padded, labelled cell of a fixed width: the label row over the body rows; no label row when `title` is null. */
export function cell(k: Kit, title: string | null, body: RenderChildren[], width: number): RenderElement {
  return k.Box({ flexDirection: 'column', width, paddingX: 1, children: [title === null ? null : label(k, title), ...body] })
}

/** The rule between two cells: one `│` per row of the tallest neighbour. */
export function rule(k: Kit, rows: number): RenderElement {
  return k.Box({ flexDirection: 'column', width: 1, children: Array.from({ length: rows }, () => k.Text({ color: PALETTE.ink3, children: GLYPH.rule })) })
}

/** A full-width row with its own background: `left` at the edge, `right` dim at the other. */
export function strip(k: Kit, left: RenderChildren, right: RenderChildren | null = null): RenderElement {
  return k.Box({ justifyContent: 'space-between', backgroundColor: PALETTE.card, paddingX: 1, children: [
    k.Text({ color: PALETTE.ink, wrap: 'truncate-end', children: left }),
    right === null ? null : k.Text({ color: PALETTE.ink2, children: right }),
  ] })
}
