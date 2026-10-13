// What the five test files share: the producer's text as a projection, the
// host's answer shapes, the band drawn through the engine, and the drawn
// tree read back as rows and colors. The hosts themselves stay in each file:
// each test file doubles what it exercises.
import type { Engine } from 'claude-code/testing'
import type { ProcessRunResult, RenderElement } from 'claude-code'
import type { StatusProjection } from '../../../types'

import { parseProjection } from '../read'

/** The mod's tick period, as register.tsx holds it. */
export const PERIOD_MS = 3000

export function projection(text: string): StatusProjection {
  const parsed = parseProjection(text)
  if (parsed === null) throw new Error('the fixture is not a projection')
  return parsed
}

export function ran(stdout: string, exitCode = 0): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

export async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

export function band($: Engine, bodyColumns = 160, hasSurvey = false) {
  return $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey, isWorking: false, maxRows: 8, bodyColumns, scroll: { offset: 0, bodyRows: 7 }, view: {} },
  })
}

export function texts(tree: RenderElement): string {
  if (tree.type === 'Button') return `[${tree.props.label}]`
  const children = 'children' in tree ? tree.children ?? [] : []
  return children.map((child) => (typeof child === 'string' ? child : texts(child))).join('')
}

/** A rule between two cells (kit `rule`): `│` glyphs and nothing else; left out of the rows. */
function isRule(tree: RenderElement): boolean {
  return tree.type === 'Box' && /^│+$/u.test(texts(tree))
}

/** The drawing's rows: a column Box, or a row Box of Boxes, lists its children's rows; a row Box of texts is one row; rules are skipped. */
export function rows(tree: RenderElement): string[] {
  const children = 'children' in tree ? tree.children ?? [] : []
  const column = tree.type === 'Box' && tree.props?.['flexDirection'] === 'column'
  const holdsBoxes = children.some((child) => typeof child !== 'string' && child.type === 'Box')
  if (tree.type !== 'Box' || (!column && !holdsBoxes)) return [texts(tree)]
  return children.flatMap((child) => (typeof child === 'string' ? [child] : isRule(child) ? [] : rows(child)))
}

/** The Buttons anywhere in the tree. */
export function buttons(tree: RenderElement): Extract<RenderElement, { type: 'Button' }>[] {
  if (tree.type === 'Button') return [tree]
  const children = 'children' in tree ? tree.children ?? [] : []
  return children.flatMap((child) => (typeof child === 'string' ? [] : buttons(child)))
}

type TextElement = Extract<RenderElement, { type: 'Text' }>

/** The Text element that holds `text` as one of its own children. */
export function findText(tree: RenderElement, text: string): TextElement | undefined {
  if (tree.type === 'Text' && (tree.children ?? []).includes(text)) return tree
  const children = 'children' in tree ? tree.children ?? [] : []
  for (const child of children) {
    if (typeof child === 'string') continue
    const found = findText(child, text)
    if (found !== undefined) return found
  }
  return undefined
}

export function findColor(tree: RenderElement, text: string): string | undefined {
  return findText(tree, text)?.props?.['color'] as string | undefined
}
