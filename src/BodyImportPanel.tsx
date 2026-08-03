import { useMemo, useRef, useState } from 'react'
import { CalendarDays, Check, CircleAlert, FileJson, LoaderCircle, Play, Upload, Wifi } from 'lucide-react'
import { parseBodyImportText } from './body-import'
import type { BodyImportRecord } from './body-import'

type BodyImportPanelProps = {
  submitting: boolean
  relayReady: boolean
  maxAgeDays: number
  onMaxAgeDays: (days: number) => void
  onStart: (records: BodyImportRecord[], sourceName: string) => void
}

const MAX_FILE_SIZE = 32 * 1024 * 1024

export function BodyImportPanel({ submitting, relayReady, maxAgeDays, onMaxAgeDays, onStart }: BodyImportPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  const [sourceName, setSourceName] = useState('粘贴内容')
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState('')
  const parsed = useMemo(() => {
    if (fileError) return { preview: null, error: fileError }
    if (!text.trim()) return { preview: null, error: '' }
    try {
      return { preview: parseBodyImportText(text), error: '' }
    } catch (error) {
      return { preview: null, error: (error as Error).message }
    }
  }, [fileError, text])

  const chooseFile = async (file?: File) => {
    if (!file) return
    setSourceName(file.name)
    if (file.size > MAX_FILE_SIZE) {
      setText('')
      setFileError('文件超过 32 MB，请拆分后再导入。')
      return
    }
    setReading(true)
    setFileError('')
    try {
      setText(await file.text())
    } catch {
      setText('')
      setFileError('文件读取失败，请重新选择或直接粘贴 JSON。')
    } finally {
      setReading(false)
    }
  }

  return (
    <form className="body-import-form" onSubmit={(event) => {
      event.preventDefault()
      if (parsed.preview && relayReady && !submitting) onStart(parsed.preview.records, sourceName)
    }}>
      <div className="body-import-dropzone">
        <input ref={inputRef} type="file" accept=".json,.txt,application/json,text/plain" onChange={(event) => void chooseFile(event.target.files?.[0])} />
        <FileJson size={28} />
        <span><strong>{reading ? '正在读取文件' : sourceName}</strong><small>JSON / TXT · 最多 5000 条</small></span>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={reading || submitting}><Upload size={16} />选择文件</button>
      </div>

      <label className="field body-import-textarea">
        <span>批量记录 JSON</span>
        <textarea value={text} onChange={(event) => { setText(event.target.value); setSourceName('粘贴内容'); setFileError('') }} placeholder='[{"note_id":"...","note_url":"https://..."}]' spellCheck={false} />
      </label>

      <div className="field recency-field">
        <span>采集时间范围</span>
        <div className="segmented" role="group" aria-label="批量正文采集时间范围">
          {[7, 14, 30, 0].map((days) => <button key={days} type="button" className={maxAgeDays === days ? 'selected' : ''} onClick={() => onMaxAgeDays(days)}>
            <CalendarDays size={15} />{days === 0 ? '不限' : `${days} 天`}
          </button>)}
        </div>
        <small className="field-help">默认近 14 天；未知发布时间保留，已知过期记录不请求正文。</small>
      </div>

      {parsed.preview && <div className="body-import-preview" aria-live="polite">
        <div className="body-import-counts">
          <span><small>文件记录</small><strong>{parsed.preview.receivedCount}</strong></span>
          <span><small>可采正文</small><strong>{parsed.preview.acceptedCount}</strong></span>
          <span><small>重复</small><strong>{parsed.preview.duplicateCount}</strong></span>
          <span className={parsed.preview.rejectedCount ? 'warning' : ''}><small>无效</small><strong>{parsed.preview.rejectedCount}</strong></span>
        </div>
        <div className="body-import-samples">
          {parsed.preview.samples.map((sample) => <span key={sample.noteId}><Check size={14} /><b>{sample.title}</b><small>{sample.noteId}</small></span>)}
        </div>
      </div>}
      {parsed.error && <div className="body-import-error" role="alert"><CircleAlert size={16} />{parsed.error}</div>}

      <div className="body-import-readiness">
        <span className={relayReady ? 'ready' : ''}><Wifi size={15} />{relayReady ? 'Relay 已连接' : 'Relay 等待连接'}</span>
        <small>任务创建后使用当前节奏参数，自动保存断点，并在限流冷却后续跑。</small>
      </div>
      <button className="primary-button body-import-start" type="submit" disabled={!parsed.preview || !relayReady || submitting || reading}>
        {submitting ? <LoaderCircle className="spin" size={18} /> : <Play size={18} fill="currentColor" />}
        {submitting ? '正在创建任务' : `开始采集 ${parsed.preview?.acceptedCount || 0} 条正文`}
      </button>
    </form>
  )
}
