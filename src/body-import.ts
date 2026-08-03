export type BodyImportRecord = Record<string, unknown>

export type BodyImportPreview = {
  records: BodyImportRecord[]
  receivedCount: number
  acceptedCount: number
  duplicateCount: number
  rejectedCount: number
  samples: Array<{ noteId: string; title: string; url: string }>
}

const NOTE_ID = /^[A-Za-z0-9_-]{8,80}$/

export function parseBodyImportText(text: string): BodyImportPreview {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('请选择文件或粘贴 JSON。')
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`JSON 格式错误：${error instanceof Error ? error.message : String(error)}`)
  }
  const rows = extractRows(payload)
  if (rows.length < 1) throw new Error('JSON 中没有可处理的记录。')
  if (rows.length > 5_000) throw new Error('单次最多导入 5000 条记录。')

  const records: BodyImportRecord[] = []
  const seen = new Set<string>()
  let duplicateCount = 0
  let rejectedCount = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      rejectedCount += 1
      continue
    }
    const record = row as BodyImportRecord
    const urls = ['note_url', 'search_result_url', 'explore_url']
      .map((field) => validNoteUrl(record[field]))
      .filter(Boolean)
    const noteId = stringValue(record.note_id || record.noteId) || noteIdFromUrls(urls)
    if (!NOTE_ID.test(noteId) || urls.length < 1) {
      rejectedCount += 1
      continue
    }
    if (seen.has(noteId)) {
      duplicateCount += 1
      continue
    }
    seen.add(noteId)
    records.push({ ...record, note_id: noteId })
  }
  if (records.length < 1) throw new Error('没有识别到有效的笔记链接。')
  return {
    records,
    receivedCount: rows.length,
    acceptedCount: records.length,
    duplicateCount,
    rejectedCount,
    samples: records.slice(0, 3).map((record) => ({
      noteId: stringValue(record.note_id),
      title: stringValue(record.title) || '未命名笔记',
      url: validNoteUrl(record.note_url) || validNoteUrl(record.search_result_url) || validNoteUrl(record.explore_url),
    })),
  }
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const object = payload as Record<string, unknown>
    for (const field of ['records', 'cards', 'items']) {
      if (Array.isArray(object[field])) return object[field] as unknown[]
    }
  }
  throw new Error('JSON 顶层需要是数组，或包含 records/cards/items 数组。')
}

function noteIdFromUrls(urls: string[]) {
  for (const value of urls) {
    const match = new URL(value).pathname.match(/\/(?:explore|search_result)\/([^/?#]+)/i)
    if (match?.[1]) return decodeURIComponent(match[1])
  }
  return ''
}

function validNoteUrl(value: unknown) {
  const raw = stringValue(value)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    const hostname = parsed.hostname.toLowerCase()
    return parsed.protocol === 'https:' && (hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com'))
      ? parsed.toString()
      : ''
  } catch {
    return ''
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}
