import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('knowledge-repository', async () => {
  const knowledge = await import('./db/repositories/knowledge.js')

  const region = knowledge.upsertKnowledgeRegion({
    id: 'product-docs',
    name: 'Product docs',
    description: 'Versioned product material',
    metadata: { team: 'test' },
  })
  assert.equal(region.id, 'product-docs')
  assert.equal(knowledge.getKnowledgeRegion(region.id).metadata.team, 'test')
  assert.equal(knowledge.listKnowledgeRegions().length, 1)

  const first = knowledge.ingestKnowledgeDocument({
    regionId: region.id,
    sourceUri: 'file:///docs/retrieval.md',
    title: 'Retrieval guide',
    mimeType: 'text/markdown',
    contentHash: 'hash-v1',
    metadata: { document: { language: 'en' } },
    chunks: [
      { text: 'Hybrid retrieval combines lexical and semantic search.', context: 'Search architecture', locator: { heading: 'Overview' } },
      { text: '短词也可以通过备用检索命中。', locator: { heading: 'CJK' } },
    ],
  })
  assert.equal(first.document.version, 1)
  assert.equal(first.chunks.length, 2)
  assert.equal(knowledge.getKnowledgeDocument(first.document.id).metadata.language, 'en')
  assert.equal(knowledge.getKnowledgeChunk(first.chunks[0].id).locator.heading, 'Overview')
  const listed = knowledge.listKnowledgeDocuments({ regionId: region.id })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, first.document.id)
  assert.equal(listed[0].region_name, 'Product docs')

  const ftsResults = knowledge.searchKnowledge({ query: 'hybrid retrieval', regionIds: [region.id] })
  assert.equal(ftsResults.length, 1)
  assert.equal(ftsResults[0].document_title, 'Retrieval guide')
  assert.equal(ftsResults[0].source_uri, 'file:///docs/retrieval.md')
  assert.match(ftsResults[0].citation_id, /^K:\d+:\d+$/)

  const likeResults = knowledge.searchKnowledge({ query: '短词', regionIds: [region.id] })
  assert.equal(likeResults.length, 1)
  assert.equal(likeResults[0].retrieval_method, 'like')

  const sameVersion = knowledge.ingestKnowledgeDocument({
    regionId: region.id,
    sourceUri: 'file:///docs/retrieval.md',
    title: 'Retrieval guide',
    contentHash: 'hash-v1',
    chunks: [{ text: 'Hybrid retrieval was reparsed without a new version.' }],
  })
  assert.equal(sameVersion.document.id, first.document.id)
  assert.equal(sameVersion.document.version, 1)

  const second = knowledge.ingestKnowledgeDocument({
    regionId: region.id,
    sourceUri: 'file:///docs/retrieval.md',
    title: 'Retrieval guide v2',
    contentHash: 'hash-v2',
    chunks: [{ text: 'New evidence belongs to version two.' }],
  })
  assert.equal(second.document.version, 2)
  assert.equal(knowledge.getKnowledgeDocument(first.document.id).active, 0)
  assert.equal(knowledge.listKnowledgeDocuments({ regionId: region.id })[0].id, second.document.id)
  assert.equal(knowledge.searchKnowledge({ query: 'reparsed' }).length, 0)
  assert.equal(knowledge.searchKnowledge({ query: 'version two' })[0].document_version, 2)

  const commandRegion = knowledge.upsertKnowledgeRegion({ id: 'command-manual', name: 'Command manual' })
  knowledge.ingestKnowledgeDocument({
    regionId: commandRegion.id,
    sourceUri: 'file:///docs/ls.md',
    title: 'ls - List directory contents',
    mimeType: 'text/markdown',
    contentHash: 'ls-v1',
    metadata: { filename: 'ls.md' },
    chunks: [{ text: 'ls lists directory contents. ls -la includes hidden files.' }],
  })
  knowledge.ingestKnowledgeDocument({
    regionId: commandRegion.id,
    sourceUri: 'file:///docs/chown.md',
    title: 'chown - Change ownership',
    mimeType: 'text/markdown',
    contentHash: 'chown-v1',
    metadata: { filename: 'chown.md' },
    chunks: [{ text: 'Use ls -l to inspect ownership before changing it.' }],
  })
  const lsResults = knowledge.searchKnowledge({ query: 'ls命令怎么用', regionIds: [commandRegion.id] })
  assert.equal(lsResults[0].document_title, 'ls - List directory contents')
  assert.equal(lsResults[0].retrieval_method, 'command_alias')

  const audit = knowledge.recordKnowledgeRetrievalAudit({
    query: 'version two',
    regionIds: [region.id],
    matchedChunkIds: [second.chunks[0].id],
    selectedCitationIds: [`K:${second.document.id}:${second.chunks[0].id}`],
    latencyMs: 12,
    source: 'test',
  })
  assert.equal(audit.matched_count, 1)
  assert.equal(audit.chosen_count, 1)
})
