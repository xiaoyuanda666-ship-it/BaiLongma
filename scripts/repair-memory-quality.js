// Conservative memory-quality repair for older Bailongma databases.
//
// Default mode is dry-run. Use --apply to write:
//   electron ./scripts/repair-memory-quality.js --apply

import crypto from 'crypto'
import { getDB } from '../src/db.js'

const USER_ID = 'ID:000001'
const APPLY = process.argv.includes('--apply')

function parseArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.map(x => String(x || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function unique(items) {
  return [...new Set((items || []).map(x => String(x || '').trim()).filter(Boolean))]
}

function hash8(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8)
}

function normalizeTag(tag) {
  return String(tag || '').trim()
}

function isOpaqueIdPart(part) {
  return /^[a-f0-9]{6,}$/i.test(String(part || '').trim())
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

function inferUserEntity(row) {
  const memId = String(row.mem_id || '')
  const eligible = row.event_type === 'fact' || row.event_type === 'person' || /^fact_user/i.test(memId)
  if (!eligible) return false
  const text = [row.mem_id, row.title, row.content, row.detail, row.tags]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (text.includes('id:000001')) return true
  if (/^fact_user/i.test(memId)) return true
  if (String(row.title || '').includes('用户')) return true
  if (String(row.content || '').includes('用户')) return true
  return false
}

function inferFocusMemId(row) {
  const day = String(row.timestamp || row.created_at || '').slice(0, 10).replaceAll('-', '') || 'unknown'
  const seed = [row.id, row.timestamp, row.title, row.content].join('|')
  return `focus_conclusion_${day}_${hash8(seed)}`
}

function inferConcepts(row, tags) {
  const current = parseArray(row.concepts).filter(part => !isOpaqueIdPart(part))
  const candidates = []

  for (const tag of tags) {
    const t = normalizeTag(tag)
    if (!t || t.startsWith('body_path:') || t.startsWith('hash:') || t.startsWith('topic:')) continue
    candidates.push(t)
  }

  const memId = String(row.mem_id || '')
  for (const part of memId.split(/[_:\-]+/)) {
    if (part.length >= 3 && !/^\d+$/.test(part) && !isOpaqueIdPart(part)) candidates.push(part)
  }

  if (row.event_type === 'focus_conclusion') candidates.push('focus_conclusion')
  if (inferUserEntity(row)) candidates.push('user_profile')

  return unique([...current, ...candidates]).slice(0, 12)
}

function buildPatch(row) {
  const entities = parseArray(row.entities)
  const tags = parseArray(row.tags)
  const currentConcepts = parseArray(row.concepts)
  const patch = {}

  if (entities.length === 0 && inferUserEntity(row)) {
    patch.entities = [USER_ID]
  }

  if (!row.mem_id && row.event_type === 'focus_conclusion') {
    patch.mem_id = inferFocusMemId(row)
  }

  const concepts = inferConcepts({ ...row, mem_id: patch.mem_id || row.mem_id }, tags)
  if (!arraysEqual(concepts, currentConcepts)) {
    patch.concepts = concepts
  }

  return patch
}

function main() {
  const db = getDB()
  const rows = db.prepare(`
    SELECT id, event_type, title, mem_id, content, detail, entities, concepts, tags, timestamp, created_at
    FROM memories
    WHERE visibility = 1
    ORDER BY id ASC
  `).all()

  const patches = []
  for (const row of rows) {
    const patch = buildPatch(row)
    if (Object.keys(patch).length > 0) patches.push({ row, patch })
  }

  console.log(`[repair-memory-quality] mode=${APPLY ? 'apply' : 'dry-run'} candidates=${patches.length}`)
  for (const { row, patch } of patches) {
    console.log(JSON.stringify({
      id: row.id,
      mem_id: row.mem_id || null,
      event_type: row.event_type,
      title: row.title || '',
      patch,
    }, null, 2))
  }

  if (!APPLY || patches.length === 0) {
    console.log('[repair-memory-quality] no writes performed')
    return
  }

  const update = db.prepare(`
    UPDATE memories
    SET
      mem_id = COALESCE(@mem_id, mem_id),
      entities = COALESCE(@entities, entities),
      concepts = COALESCE(@concepts, concepts)
    WHERE id = @id
  `)

  const tx = db.transaction((items) => {
    for (const { row, patch } of items) {
      update.run({
        id: row.id,
        mem_id: patch.mem_id || null,
        entities: patch.entities ? JSON.stringify(patch.entities) : null,
        concepts: patch.concepts ? JSON.stringify(patch.concepts) : null,
      })
    }
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
  })
  tx(patches)

  console.log(`[repair-memory-quality] applied=${patches.length}; memories_fts rebuilt`)
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('[repair-memory-quality] failed:', err?.stack || err?.message || err)
  process.exit(1)
}
