import { LoaderCircle, Save, Trash2, X } from 'lucide-react'
import type { DraftSaveStatus } from './useUnsavedDraftGuard'

type UnsavedDraftDialogProps = {
  reason: string
  saveStatus: DraftSaveStatus
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function UnsavedDraftDialog({ reason, saveStatus, onSave, onDiscard, onCancel }: UnsavedDraftDialogProps) {
  const saving = saveStatus === 'saving'
  return (
    <div className="draft-guard-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onCancel()
    }}>
      <section className="draft-guard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="draft-guard-title" aria-describedby="draft-guard-description" onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onCancel()
      }}>
        <header>
          <div><span className="step-label">AUTO-SAVE FAILED</span><h3 id="draft-guard-title">文案自动保存失败</h3></div>
          <button type="button" title="取消离开" aria-label="取消离开" disabled={saving} onClick={onCancel}><X size={18} /></button>
        </header>
        <p id="draft-guard-description">{reason}会离开当前草稿。自动保存未成功，请选择如何处理本次修改。</p>
        {saveStatus === 'error' && <p className="draft-guard-error" role="alert">自动保存失败，当前文本仍保留，请重试或取消离开。</p>}
        <footer>
          <button type="button" className="secondary-button" disabled={saving} onClick={onCancel}><X size={16} />取消操作</button>
          <button type="button" className="secondary-button danger" disabled={saving} onClick={onDiscard}><Trash2 size={16} />放弃修改</button>
          <button type="button" className="primary-button" disabled={saving} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : '保存并继续'}</button>
        </footer>
      </section>
    </div>
  )
}
