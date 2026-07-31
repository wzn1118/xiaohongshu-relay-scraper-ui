import type { DraftVersionRef, OutreachDraft } from './types'

export function normalizeDraftContent(content: Partial<OutreachDraft> | null | undefined): OutreachDraft
export function draftContentHash(content: Partial<OutreachDraft> | null | undefined): string
export function draftIsDirty(content: Partial<OutreachDraft> | null | undefined, draftVersion: DraftVersionRef | null | undefined): boolean

export type LatestRequestGate = {
  begin(): number
  isLatest(requestId: number): boolean
  invalidate(): number
}

export function createLatestRequestGate(): LatestRequestGate
