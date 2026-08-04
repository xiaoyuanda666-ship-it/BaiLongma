import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('knowledge-injector', async () => {
  const knowledge = await import('./db/repositories/knowledge.js')
  const { runKnowledgeInjector } = await import('./knowledge/injector.js')

  knowledge.upsertKnowledgeRegion({ id: 'handbook', name: 'Engineering handbook' })
  knowledge.ingestKnowledgeDocument({
    regionId: 'handbook',
    sourceUri: 'file:///handbook/retrieval.md',
    title: 'Retrieval handbook',
    mimeType: 'text/markdown',
    contentHash: 'injector-v1',
    chunks: [{
      text: '版本化证据检索用于回答文档问题，并且每个结果都必须保留可引用的来源。',
      context: 'Document: Retrieval handbook',
      locator: { heading_path: ['Evidence retrieval'], start_line: 8, end_line: 11 },
    }],
  })

  const result = await runKnowledgeInjector({ query: '根据文档，怎样进行证据检索？', source: 'test' })
  assert.equal(result.skipped, false)
  assert.equal(result.reason, 'retrieved')
  assert.equal(result.evidence.length, 1)
  assert.match(result.evidence[0].citation_id, /^K:\d+:\d+$/)
  assert.match(result.evidenceText, /<knowledge-evidence>/)
  assert.match(result.evidenceText, /file:\/\/\/handbook\/retrieval\.md/)
  assert.match(result.evidenceText, /Document: Retrieval handbook/)

  knowledge.ingestKnowledgeDocument({
    regionId: 'handbook',
    sourceUri: 'file:///handbook/release.md',
    title: 'Release verification handbook',
    mimeType: 'text/markdown',
    contentHash: 'injector-v2',
    chunks: [{ text: '发布验证完成后才能进入正式发布流程。' }],
  })
  const reordered = await runKnowledgeInjector({ query: '根据文档如何验证发布', source: 'test' })
  assert.ok(reordered.evidence.some(item => item.document_title === 'Release verification handbook'))

  const greeting = await runKnowledgeInjector({ query: '你好' })
  assert.equal(greeting.skipped, true)
  assert.equal(greeting.reason, 'query_not_eligible')
})
