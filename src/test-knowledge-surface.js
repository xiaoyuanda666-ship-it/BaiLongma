// Knowledge-surface contract tests. They stay independent of the concrete
// knowledge repository implementation, which is covered by db tests.
import assert from 'node:assert/strict'
import { TOOL_SCHEMAS } from './capabilities/builtin-tools.js'
import {
  execImportKnowledge,
  execInspectKnowledgeSource,
  execManageKnowledgeRegion,
  execSearchKnowledge,
} from './capabilities/tools/knowledge.js'
import { handleKnowledgeRoutes } from './api/routes/knowledge.js'

for (const name of ['manage_knowledge_region', 'import_knowledge', 'search_knowledge', 'inspect_knowledge_source']) {
  assert.equal(TOOL_SCHEMAS[name]?.function?.name, name, `${name} has a registered schema`)
}

assert.equal(JSON.parse(await execImportKnowledge({})).ok, false)
assert.equal(JSON.parse(await execImportKnowledge({ region_id: 'r', title: 'doc' })).error, 'provide content or uri')
assert.equal(JSON.parse(await execSearchKnowledge({})).error, 'missing query')
assert.equal(JSON.parse(await execInspectKnowledgeSource({})).error, 'provide document_id or chunk_id')
assert.equal(JSON.parse(await execManageKnowledgeRegion({ action: 'create' })).error, 'missing name')

function makeResponse() {
  return {
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(body) { this.body = JSON.parse(body) },
  }
}

{
  const res = makeResponse()
  const handled = await handleKnowledgeRoutes({ method: 'GET' }, res, new URL('http://localhost/knowledge/search'))
  assert.equal(handled, true)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'missing q or query')
}

{
  const res = makeResponse()
  const handled = await handleKnowledgeRoutes({ method: 'GET' }, res, new URL('http://localhost/not-knowledge'))
  assert.equal(handled, false)
}

console.log('test-knowledge-surface passed')
