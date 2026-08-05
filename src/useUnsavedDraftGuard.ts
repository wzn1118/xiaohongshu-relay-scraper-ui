import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLatestRequestGate, draftContentHash, draftIsDirty } from './draft-state.mjs'
import type { DraftVersionRef, OutreachDraft } from './types'

export type DraftSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export type DraftSaveRequest = {
  requestId: number
  contentHash: string | null
  draftId: string | null
  version: number | null
}

type PendingTransition = {
  reason: string
}

type DeferredTransition = {
  action: () => unknown | Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type UnsavedDraftGuardOptions = {
  content: OutreachDraft | null
  draftVersion: DraftVersionRef | null
  save: (request: DraftSaveRequest) => Promise<boolean>
  discard: (snapshot: { content: OutreachDraft; draftVersion: DraftVersionRef }) => void
}

export function useUnsavedDraftGuard({ content, draftVersion, save, discard }: UnsavedDraftGuardOptions) {
  const currentContentHash = useMemo(() => content ? draftContentHash(content) : null, [
    content?.cover_letter,
    content?.email_body,
    content?.email_subject,
    content?.greeting,
  ])
  const dirty = useMemo(() => draftIsDirty(content, draftVersion), [currentContentHash, draftVersion?.contentHash])
  const dirtyRef = useRef(dirty)
  const saveRef = useRef(save)
  const discardRef = useRef(discard)
  const persistedSnapshotRef = useRef<{ content: OutreachDraft; draftVersion: DraftVersionRef } | null>(null)
  const deferredRef = useRef<DeferredTransition | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const requestGateRef = useRef(createLatestRequestGate())
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null)
  const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>('idle')

  dirtyRef.current = dirty
  saveRef.current = save
  discardRef.current = discard
  if (!dirty && content && draftVersion) {
    persistedSnapshotRef.current = {
      content: { ...content },
      draftVersion: { ...draftVersion },
    }
  }

  useEffect(() => {
    if (dirty && saveStatus === 'saved') setSaveStatus('idle')
  }, [dirty, saveStatus])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  const saveNow = useCallback(() => {
    if (savePromiseRef.current) return savePromiseRef.current
    const requestId = requestGateRef.current.begin()
    const request: DraftSaveRequest = {
      requestId,
      contentHash: currentContentHash,
      draftId: draftVersion?.draftId || null,
      version: draftVersion?.version ?? null,
    }
    setSaveStatus('saving')
    const pendingSave = saveRef.current(request)
      .then((saved) => {
        if (requestGateRef.current.isLatest(requestId)) setSaveStatus(saved ? 'saved' : 'error')
        return saved
      })
      .catch(() => {
        if (requestGateRef.current.isLatest(requestId)) setSaveStatus('error')
        return false
      })
      .finally(() => {
        if (savePromiseRef.current === pendingSave) savePromiseRef.current = null
      })
    savePromiseRef.current = pendingSave
    return pendingSave
  }, [currentContentHash, draftVersion?.draftId, draftVersion?.version])

  const completeTransition = useCallback(async (runAction: boolean) => {
    const deferred = deferredRef.current
    deferredRef.current = null
    setPendingTransition(null)
    if (!deferred) return
    if (!runAction) {
      deferred.resolve(undefined)
      return
    }
    try {
      deferred.resolve(await deferred.action())
    } catch (error) {
      deferred.reject(error)
    }
  }, [])

  const requestTransition = useCallback(<T>(reason: string, action: () => T | Promise<T>): Promise<T | undefined> => {
    if (!dirtyRef.current) return Promise.resolve(action())
    if (deferredRef.current) return Promise.resolve(undefined)
    const transition = new Promise<T | undefined>((resolve, reject) => {
      deferredRef.current = {
        action,
        resolve: (value) => resolve(value as T),
        reject,
      }
    })
    // Draft changes are saved automatically before a navigation or other
    // guarded action. Keep the confirmation dialog as a failure-only escape
    // hatch so a transient API error still leaves the user in control.
    void saveNow().then((saved) => {
      if (saved) {
        void completeTransition(true)
      } else if (deferredRef.current) {
        setPendingTransition({ reason })
      }
    })
    return transition
  }, [completeTransition, saveNow])

  const saveAndContinue = useCallback(async () => {
    if (!deferredRef.current) return
    const saved = await saveNow()
    if (saved) await completeTransition(true)
  }, [completeTransition, saveNow])

  const discardAndContinue = useCallback(() => {
    if (persistedSnapshotRef.current) discardRef.current(persistedSnapshotRef.current)
    return completeTransition(true)
  }, [completeTransition])
  const cancelTransition = useCallback(() => completeTransition(false), [completeTransition])

  return {
    cancelTransition,
    currentContentHash,
    dirty,
    discardAndContinue,
    pendingTransition,
    requestTransition,
    saveAndContinue,
    saveNow,
    saveStatus,
  }
}
