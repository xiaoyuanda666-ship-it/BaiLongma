import { informationSourceRegistry } from './source-registry.js'

const initializedRegistries = new WeakSet()

function observedAt(request = {}) {
  const value = request.now instanceof Date ? request.now : new Date(request.now || Date.now())
  return Number.isFinite(value.getTime()) ? value : new Date()
}

function validTime(value, fallback) {
  const parsed = value ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback
}

function memoryId(memory = {}, index = 0) {
  return String(memory.mem_id || memory.id || `projection-${index + 1}`)
}

function projectMemory(memory = {}, request = {}, index = 0, topic = 'memory.relevant') {
  const now = observedAt(request)
  const id = memoryId(memory, index)
  return {
    topic,
    subject: { memoryId: id },
    authorship: 'system',
    semanticKind: topic === 'policy.active_memory' ? 'policy' : 'memory',
    payload: {
      content: String(memory.content || ''),
      detail: String(memory.detail || ''),
      eventType: String(memory.event_type || ''),
      importance: Number(memory.importance) || 0,
    },
    payloadRef: memory.id ? { table: 'memories', id: memory.id } : {},
    occurredAt: validTime(memory.timestamp || memory.created_at, now),
    observedAt: now,
    priority: topic === 'policy.active_memory' ? 80 : 55,
    sensitivity: 'private',
    trust: topic === 'policy.active_memory' ? 'authoritative' : 'observed',
    metadata: { canonicalKey: `${topic}:${id}` },
  }
}

function uniqueMemories(groups = []) {
  const unique = new Map()
  for (const [lane, memories] of groups) {
    for (const memory of Array.isArray(memories) ? memories : []) {
      const key = memoryId(memory, unique.size)
      if (!unique.has(key)) unique.set(key, { ...memory, retrievalLane: lane })
    }
  }
  return [...unique.values()]
}

function projectKnowledgeEvidence(evidence = {}, request = {}, index = 0) {
  const now = observedAt(request)
  const citationId = String(evidence.citation_id || evidence.chunk_id || evidence.id || `K:${index + 1}`)
  return {
    topic: 'knowledge.evidence',
    subject: {
      citationId,
      documentId: evidence.document_id || undefined,
      chunkId: evidence.chunk_id || evidence.id || undefined,
    },
    authorship: 'external',
    semanticKind: 'knowledge',
    payload: {
      citationId,
      documentTitle: String(evidence.document_title || evidence.title || ''),
      documentVersion: String(evidence.document_version || ''),
      sourceUri: String(evidence.source_uri || evidence.sourceUri || ''),
      context: String(evidence.context || ''),
      locator: evidence.locator || evidence.locator_json || {},
      content: String(evidence.chunk_text || evidence.text || evidence.content || ''),
    },
    payloadRef: evidence.chunk_id || evidence.id
      ? { table: 'knowledge_chunks', id: evidence.chunk_id || evidence.id }
      : {},
    occurredAt: validTime(evidence.updated_at || evidence.created_at, now),
    observedAt: now,
    priority: 65,
    sensitivity: 'private',
    trust: 'verified',
    metadata: { canonicalKey: `knowledge.evidence:${citationId}` },
  }
}

export function ensureBuiltinProjectionInformationSources({ registry = informationSourceRegistry } = {}) {
  if (initializedRegistries.has(registry)) return []
  const registered = []

  registered.push(registry.register({
    id: 'memory:relevant',
    kind: 'query',
    domain: 'memory',
    topics: ['memory.relevant'],
    description: 'Relevant and explicitly recalled autobiographical memories selected by the legacy retriever.',
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 40,
    maxChars: 16_000,
    rank: 65,
    collect: request => uniqueMemories([
      ['relevant', request.memoryProjection?.memories],
      ['recall', request.memoryProjection?.recallMemories],
    ]).map((memory, index) => {
      const item = projectMemory(memory, request, index)
      return {
        ...item,
        payload: { ...item.payload, retrievalLane: memory.retrievalLane || '' },
      }
    }),
  }))

  registered.push(registry.register({
    id: 'memory:active-policy',
    kind: 'query',
    domain: 'memory',
    topics: ['policy.active_memory'],
    description: 'Policy memories selected as active constraints for the current turn.',
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 20,
    maxChars: 12_000,
    rank: 95,
    collect: request => (request.memoryProjection?.activePolicies || [])
      .map((memory, index) => projectMemory(memory, request, index, 'policy.active_memory')),
  }))

  registered.push(registry.register({
    id: 'knowledge:evidence',
    kind: 'query',
    domain: 'knowledge',
    topics: ['knowledge.evidence'],
    description: 'Cited document evidence selected by Knowledge Cortex for the current turn.',
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 20,
    maxChars: 16_000,
    rank: 80,
    collect: request => (request.knowledgeProjection?.evidence || [])
      .map((evidence, index) => projectKnowledgeEvidence(evidence, request, index)),
  }))

  registered.push(registry.register({
    id: 'task:current-state',
    kind: 'snapshot',
    domain: 'task',
    topics: ['task.current_state'],
    description: 'Compatibility projection of the current task and execution steps; it is information, not a matter lifecycle.',
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 8_000,
    rank: 75,
    match: request => !!String(request.taskProjection?.task || '').trim()
      || (request.taskProjection?.steps || []).length > 0,
    collect: request => {
      const now = observedAt(request)
      return {
        topic: 'task.current_state',
        subject: { taskId: String(request.taskProjection?.taskId || '') || undefined },
        authorship: 'system',
        semanticKind: 'task_state',
        payload: {
          task: String(request.taskProjection?.task || ''),
          steps: (request.taskProjection?.steps || []).map(step => ({
            text: String(step?.text || ''),
            status: String(step?.status || 'pending'),
            note: String(step?.note || ''),
          })),
        },
        occurredAt: now,
        observedAt: now,
        priority: 70,
        sensitivity: 'private',
        trust: 'authoritative',
      }
    },
  }))

  initializedRegistries.add(registry)
  return registered
}
