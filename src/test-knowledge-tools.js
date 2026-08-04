import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('knowledge-tools', async () => {
  const {
    execImportKnowledge,
    execInspectKnowledgeSource,
    execManageKnowledgeRegion,
    execSearchKnowledge,
  } = await import('./capabilities/tools/knowledge.js')
  const { handleKnowledgeRoutes } = await import('./api/routes/knowledge.js')

  const region = JSON.parse(await execManageKnowledgeRegion({
    action: 'create',
    region_id: 'release-docs',
    name: 'Release docs',
    description: 'Versioned release documentation',
  }))
  assert.equal(region.ok, true)
  assert.equal(region.region.id, 'release-docs')

  const imported = JSON.parse(await execImportKnowledge({
    region_id: 'release-docs',
    title: 'Release guide',
    source_type: 'markdown',
    content: '# Verify\n\nVerify the release before deployment.\n\n## Rollback\n\nRollback requires an approved incident.',
  }))
  assert.equal(imported.ok, true)
  assert.equal(imported.result.document.version, 1)
  assert.equal(imported.result.chunks.length, 2)

  const search = JSON.parse(await execSearchKnowledge({
    query: 'release verify',
    region_id: 'release-docs',
  }))
  assert.equal(search.ok, true)
  assert.ok(search.count >= 1)
  assert.ok(search.hits.some(hit => hit.document_title === 'Release guide'))

  const inspected = JSON.parse(await execInspectKnowledgeSource({
    chunk_id: String(search.hits.find(hit => hit.chunk_text.includes('Verify the release'))?.chunk_id),
  }))
  assert.equal(inspected.ok, true)
  assert.equal(inspected.chunk.locator.heading_path[0], 'Verify')

  const disabled = JSON.parse(await execManageKnowledgeRegion({
    action: 'disable',
    region_id: 'release-docs',
  }))
  assert.equal(disabled.ok, true)
  assert.equal(disabled.region.status, 'disabled')
  assert.equal(JSON.parse(await execSearchKnowledge({ query: 'rollback' })).count, 0)

  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  req.destroy = () => {}
  const res = {
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(body) { this.body = JSON.parse(body) },
  }
  const handled = handleKnowledgeRoutes(req, res, new URL('http://localhost/knowledge/documents'))
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify({
      region_id: 'release-docs', title: 'Incident guide',
      content: 'Use a rollback plan during an incident.', source_type: 'text',
    })))
    req.emit('end')
  })
  assert.equal(await handled, true)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
})
