import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createLatestRequestGate, draftContentHash, draftIsDirty, normalizeDraftContent } from '../src/draft-state.mjs'

function serverHash(content) {
  const fields = ['greeting', 'email_subject', 'email_body', 'cover_letter']
  const normalized = normalizeDraftContent(content)
  const canonical = JSON.stringify(fields.map((field) => [field, normalized[field]]))
  return createHash('sha256').update(`draft-content:v1\n${canonical}`).digest('hex')
}

test('draft content hash matches the server v1 normalization contract', () => {
  const content = {
    greeting: '\uFEFF 你好\r\n团队 ',
    email_subject: '  申请岗位  ',
    email_body: '第一行\r第二行',
    cover_letter: 'Cafe\u0301',
  }
  assert.equal(draftContentHash(content), serverHash(content))
})

test('dirty state is derived from the persisted content hash', () => {
  const content = { greeting: 'A', email_subject: 'B', email_body: 'C', cover_letter: 'D' }
  const draftVersion = { draftId: 'draft-1', version: 4, contentHash: draftContentHash(content) }
  assert.equal(draftIsDirty(content, draftVersion), false)
  assert.equal(draftIsDirty({ ...content, email_body: 'changed' }, draftVersion), true)
  assert.equal(draftIsDirty({ ...content, email_body: ' C\r\n' }, draftVersion), false)
})

test('latest request gate rejects an older response arriving last', () => {
  const gate = createLatestRequestGate()
  const older = gate.begin()
  const newer = gate.begin()
  assert.equal(gate.isLatest(newer), true)
  assert.equal(gate.isLatest(older), false)
})
