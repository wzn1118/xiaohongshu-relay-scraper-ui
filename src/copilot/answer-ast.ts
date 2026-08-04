export type AnswerBlockKind =
  | 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'quote'
  | 'callout' | 'chart' | 'citation' | 'artifact' | 'checklist'
  | 'diff' | 'tool_summary' | 'error'

export type AnswerBlock = {
  id: string
  kind: AnswerBlockKind
  content: unknown
  level?: number
  ordered?: boolean
  claimIds?: string[]
  sourceRefs?: string[]
}

export type AnswerAst = {
  schemaVersion: number
  answerId: string
  blocks: AnswerBlock[]
  citations?: unknown[]
  artifacts?: unknown[]
}

function block(kind: AnswerBlockKind, content: unknown, index: number, extra: Partial<AnswerBlock> = {}): AnswerBlock {
  return { id: `block-${index + 1}`, kind, content, ...extra }
}

export function parseAnswerAst(value: unknown): AnswerAst {
  if (value && typeof value === 'object' && 'blocks' in value && Array.isArray((value as { blocks?: unknown }).blocks)) {
    const ast = value as Partial<AnswerAst>
    return { schemaVersion: Number(ast.schemaVersion || 1), answerId: String(ast.answerId || 'answer'), blocks: ast.blocks as AnswerBlock[], citations: ast.citations || [], artifacts: ast.artifacts || [] }
  }
  const text = String(value ?? '').replace(/\r\n?/gu, '\n')
  const lines = text.split('\n')
  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []
  const flush = () => {
    const content = paragraph.join('\n').trim()
    if (content) blocks.push(block('paragraph', content, blocks.length))
    paragraph = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```\s*([\w-]*)\s*$/u.exec(line)
    if (fence) {
      flush(); i += 1
      const code: string[] = []
      while (i < lines.length && !/^\s*```\s*$/u.test(lines[i])) { code.push(lines[i]); i += 1 }
      blocks.push(block('code', { language: fence[1] || '', code: code.join('\n') }, blocks.length)); i += 1; continue
    }
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (heading) { flush(); blocks.push(block('heading', heading[2], blocks.length, { level: heading[1].length })); i += 1; continue }
    if (/^\s*>/u.test(line)) {
      flush(); const quote: string[] = []
      while (i < lines.length && /^\s*>/u.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/u, '')); i += 1 }
      blocks.push(block('quote', quote.join('\n'), blocks.length)); continue
    }
    const item = /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/u.exec(line)
    if (item) {
      flush(); const list: Array<{ text: string; checked?: boolean }> = []; const ordered = /^\d/u.test(item[1]); const checklist = /^\[/u.test(item[1])
      while (i < lines.length) {
        const next = /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/u.exec(lines[i]); if (!next) break
        list.push({ text: next[2], ...(checklist ? { checked: /^\[[xX]\]/u.test(next[1]) } : {}) }); i += 1
      }
      blocks.push(block(checklist ? 'checklist' : 'list', list, blocks.length, { ordered })); continue
    }
    if (/^\s*\|/u.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/u.test(lines[i + 1])) {
      flush(); const parse = (row: string) => row.replace(/^\s*\||\|\s*$/gu, '').split('|').map((cell) => cell.trim()); const headers = parse(line); i += 2; const rows: string[][] = []
      while (i < lines.length && /^\s*\|/u.test(lines[i])) { rows.push(parse(lines[i])); i += 1 }
      blocks.push(block('table', { headers, rows }, blocks.length)); continue
    }
    if (!line.trim()) flush(); else paragraph.push(line)
    i += 1
  }
  flush()
  return { schemaVersion: 1, answerId: 'answer', blocks }
}
