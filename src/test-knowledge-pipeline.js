import assert from 'node:assert/strict'
import {
  normalizeKnowledgeText,
  canonicalizeSourceUri,
  hashContent,
  hashSource,
  chunkText,
  formatKnowledgeEvidence,
  buildKnowledgeQuery,
  shouldRetrieveKnowledge,
  rerankEvidence,
} from './knowledge/index.js'

assert.match(normalizeKnowledgeText('<h1>Plan</h1><p>Ship &amp; verify.</p>', 'text/html'), /# Plan\n+Ship & verify\./)
assert.equal(normalizeKnowledgeText('name,city\nAda,Shenzhen\n', 'text/csv'), 'Row 2: name: Ada | city: Shenzhen')
assert.equal(canonicalizeSourceUri('https://alice:secret@example.com/doc?a=signed#section'), 'https://example.com/doc')
assert.equal(hashContent('one'), hashContent('one'))
assert.equal(hashSource('https://example.com/doc?a=one'), hashSource('https://example.com/doc?a=two'))

const chunks = chunkText('# Installation\n\nFirst install the package.\n\n## Verify\n\nRun the verification command.', {
  title: 'Guide', sourceUri: 'file:///guide.md', maxChars: 80,
})
assert.equal(chunks.length, 2)
assert.equal(chunks[1].ordinal, 1)
assert.match(chunks[1].context, /Guide/)
assert.deepEqual(chunks[1].locator.heading_path, ['Installation', 'Verify'])
assert.ok(chunks[0].tokenCount > 0)

const evidence = formatKnowledgeEvidence([{
  document_title: 'Guide', document_version: '2', source_uri: 'file:///guide.md',
  chunk_id: 'chunk-7', context: 'Document: Guide', chunk_text: 'Run verification before release.',
  locator_json: { heading_path: ['Installation', 'Verify'], start_line: 5, end_line: 6 },
}], { maxChars: 800 })
assert.match(evidence, /citation="chunk-7"/)
assert.match(evidence, /Guide · v2/)
assert.match(evidence, /context: Document: Guide/)
assert.match(evidence, /Installation &gt; Verify/)

assert.match(buildKnowledgeQuery({ query: 'How do I verify?', task: 'Release guide' }), /Release guide/)
assert.equal(shouldRetrieveKnowledge({ query: '你好', hasActiveRegion: true }), false)
assert.equal(shouldRetrieveKnowledge({ query: '根据文档如何验证？', hasActiveRegion: true }), true)
assert.equal(shouldRetrieveKnowledge({ query: '根据文档如何验证？', hasActiveRegion: false }), false)

const ranked = rerankEvidence([
  { chunk_text: 'Deploy first.', score: 0.95 },
  { chunk_text: 'Verify the release before deployment.', score: 0.8 },
], { query: 'release verify' })
assert.match(ranked[0].chunk_text, /Verify/)

console.log('knowledge pipeline tests passed')
