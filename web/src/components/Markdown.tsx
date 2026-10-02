import type { ReactNode } from 'react'

/**
 * A small markdown renderer for the subset the Fabric data agent actually emits:
 * headings, bold/italic, ordered and unordered lists (nested one or more levels),
 * inline code, fenced code, GFM tables and horizontal rules.
 *
 * Hand-rolled rather than pulling in react-markdown because this app otherwise has
 * no runtime dependencies beyond React, and a full remark/micromark tree is ~40
 * transitive packages for one chat bubble.
 *
 * It builds React elements and never touches dangerouslySetInnerHTML, so model
 * output cannot inject markup -- worth keeping that way if this grows.
 */

/**
 * Emphasis is **bold** and *italic* only -- deliberately NOT the _underscore_
 * forms. The agent's answers are dense with SNAKE_CASE identifiers
 * (DOO_HOLDS_HDR_NT_OPEN, QP_PDP_STRATEGY_NOT_FOUND), and underscore emphasis
 * would italicise their middles instead of leaving the code intact.
 *
 * Code is first in the alternation so backticked text wins over emphasis inside it.
 */
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+)\*/g

function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  let match: RegExpExecArray | null

  INLINE.lastIndex = 0
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))

    const [raw, code, bold, italic] = match
    if (code !== undefined) out.push(<code key={`${key}-c${n}`}>{code}</code>)
    else if (bold !== undefined) out.push(<strong key={`${key}-b${n}`}>{bold}</strong>)
    else out.push(<em key={`${key}-i${n}`}>{italic}</em>)

    last = match.index + raw.length
    n += 1
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

type ListItem = { indent: number; text: string; ordered: boolean }

const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/
const OL_ITEM = /^(\s*)\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
/** A rule, not a list bullet: three or more dashes alone on the line. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Split a table row on unescaped pipes, dropping the leading/trailing empties. */
function tableCells(line: string): string[] {
  const cells = line.split('|').map((cell) => cell.trim())
  if (cells.length && cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

/**
 * Nest by indentation: any run of items indented deeper than the current bullet
 * belongs inside it. Fabric's answers use this for sub-points under an error code.
 */
function buildList(items: ListItem[], key: string): ReactNode {
  const children: ReactNode[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]
    const nested: ListItem[] = []
    let j = i + 1
    while (j < items.length && items[j].indent > item.indent) {
      nested.push(items[j])
      j += 1
    }

    children.push(
      <li key={`${key}-li${i}`}>
        {renderInline(item.text, `${key}-li${i}`)}
        {nested.length > 0 ? buildList(nested, `${key}-li${i}-sub`) : null}
      </li>,
    )
    i = j
  }

  const Tag = items[0]?.ordered ? 'ol' : 'ul'
  return <Tag key={key}>{children}</Tag>
}

function renderBlocks(source: string): ReactNode[] {
  // Normalise newlines so a CRLF payload doesn't leave \r on every parsed line.
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    // Fenced code. Unterminated fences run to the end rather than dropping text.
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push(
        <pre key={`b${blocks.length}`}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={`b${blocks.length}`} />)
      i += 1
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      // Clamp to h3..h5: these render inside a chat bubble, so a real h1 would
      // outweigh the page's own headings. The agent's top section level is `##`,
      // which therefore has to land on h3 rather than being pushed down to h4.
      const level = Math.min(5, Math.max(3, heading[1].length + 1))
      const Tag = `h${level}` as 'h3' | 'h4' | 'h5'
      blocks.push(<Tag key={`b${blocks.length}`}>{renderInline(heading[2], `b${blocks.length}`)}</Tag>)
      i += 1
      continue
    }

    // GFM table: a header row followed by a |---|---| divider.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = tableCells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]))
        i += 1
      }
      const key = `b${blocks.length}`
      blocks.push(
        <table key={key}>
          <thead>
            <tr>
              {header.map((cell, c) => (
                <th key={`${key}-h${c}`}>{renderInline(cell, `${key}-h${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={`${key}-r${r}`}>
                {row.map((cell, c) => (
                  <td key={`${key}-r${r}c${c}`}>{renderInline(cell, `${key}-r${r}c${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // A run of list items, ordered or not, at any indent.
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length) {
        const ul = lines[i].match(UL_ITEM)
        const ol = lines[i].match(OL_ITEM)
        if (ul) items.push({ indent: ul[1].length, text: ul[2], ordered: false })
        else if (ol) items.push({ indent: ol[1].length, text: ol[2], ordered: true })
        else if (items.length && /^\s+\S/.test(lines[i])) {
          // An indented line that isn't itself a bullet is a continuation of the
          // one above it -- the agent writes an error code as the bullet and then
          // its explanation on the following indented lines. Without this the
          // explanation breaks the list in two and the next bullet comes back at
          // the wrong nesting level.
          items[items.length - 1].text += ` ${lines[i].trim()}`
        } else if (lines[i].trim() === '' && items.length) {
          // A blank line between bullets is still one list; stop only if the next
          // non-blank line isn't an item.
          const next = lines[i + 1] ?? ''
          if (!UL_ITEM.test(next) && !OL_ITEM.test(next)) break
        } else break
        i += 1
      }
      blocks.push(buildList(items, `b${blocks.length}`))
      continue
    }

    // Paragraph: consecutive lines up to a blank line or the start of another block.
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i]) &&
      !/^\s*```/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    blocks.push(<p key={`b${blocks.length}`}>{renderInline(para.join(' '), `b${blocks.length}`)}</p>)
  }

  return blocks
}

export default function Markdown({ children }: { children: string }) {
  return <div className="md">{renderBlocks(children)}</div>
}
