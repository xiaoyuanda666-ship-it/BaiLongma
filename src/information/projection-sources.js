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

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function cleanText(value) {
  return String(value || '').trim()
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
      title: String(memory.title || ''),
      eventType: String(memory.event_type || ''),
      importance: Number(memory.importance) || 0,
      salience: Number(memory.salience) || 0,
      tags: safeJsonArray(memory.tags).map(String),
      activationReasons: Array.isArray(memory._policyReasons) ? memory._policyReasons.map(String) : [],
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

function projectConstraint(constraint = {}, request = {}, index = 0) {
  const now = observedAt(request)
  const id = memoryId(constraint, index)
  const tags = safeJsonArray(constraint.tags).map(String)
  const dimension = tags.find(tag => tag.startsWith('dimension:'))?.slice('dimension:'.length) || ''
  return {
    topic: 'policy.behavioral_constraint',
    subject: { constraintId: id, dimension: dimension || undefined },
    authorship: 'system',
    semanticKind: 'policy',
    payload: {
      content: cleanText(constraint.content),
      detail: cleanText(constraint.detail),
      dimension,
      tags,
    },
    payloadRef: constraint.id ? { table: 'memories', id: constraint.id } : {},
    occurredAt: validTime(constraint.timestamp || constraint.created_at, now),
    observedAt: now,
    priority: 95,
    sensitivity: 'private',
    trust: 'authoritative',
    metadata: { canonicalKey: `policy.behavioral_constraint:${id}` },
  }
}

function projectPrefetch(item = {}, request = {}, index = 0) {
  const now = observedAt(request)
  const sourceName = cleanText(item.source) || `prefetch-${index + 1}`
  return {
    topic: 'knowledge.prefetched',
    subject: { cacheId: item.id || undefined, provider: sourceName },
    authorship: 'external',
    semanticKind: 'knowledge',
    payload: {
      provider: sourceName,
      content: cleanText(item.content),
      tags: safeJsonArray(item.tags).map(String),
      fetchedAt: item.fetched_at || '',
      expiresAt: item.expires_at || '',
    },
    payloadRef: item.id ? { table: 'prefetch_cache', id: item.id } : {},
    occurredAt: validTime(item.fetched_at, now),
    observedAt: now,
    expiresAt: validTime(item.expires_at, null) || null,
    priority: 60,
    sensitivity: 'private',
    trust: 'observed',
    metadata: { canonicalKey: `knowledge.prefetched:${sourceName}` },
  }
}

function projectPersonMemory(personMemory = {}, request = {}) {
  const now = observedAt(request)
  const id = memoryId(personMemory)
  return {
    topic: 'memory.person_context',
    subject: {
      memoryId: id,
      userId: request.identityProjection?.userId || undefined,
    },
    authorship: 'system',
    semanticKind: 'memory',
    payload: {
      content: cleanText(personMemory.content),
      detail: cleanText(personMemory.detail),
      entities: safeJsonArray(personMemory.entities).map(String),
    },
    payloadRef: personMemory.id ? { table: 'memories', id: personMemory.id } : {},
    occurredAt: validTime(personMemory.timestamp || personMemory.created_at, now),
    observedAt: now,
    priority: 70,
    sensitivity: 'private',
    trust: 'observed',
    metadata: { canonicalKey: `memory.person_context:${id}` },
  }
}

function projectUserProfile(profile = {}, request = {}) {
  const now = observedAt(request)
  const userId = cleanText(profile.user_id || request.identityProjection?.userId) || 'current-user'
  return {
    topic: 'memory.user_profile',
    subject: { userId },
    authorship: 'system',
    semanticKind: 'memory',
    payload: {
      workingImpression: true,
      summary: cleanText(profile.summary),
      roles: Array.isArray(profile.roles) ? profile.roles : [],
      domains: Array.isArray(profile.domains) ? profile.domains : [],
      expertise: Array.isArray(profile.expertise) ? profile.expertise : [],
      projects: Array.isArray(profile.projects) ? profile.projects : [],
      preferences: Array.isArray(profile.preferences) ? profile.preferences : [],
      communicationStyle: Array.isArray(profile.communication_style) ? profile.communication_style : [],
      confidence: Number(profile.confidence) || 0,
    },
    payloadRef: profile.user_id ? { table: 'user_profiles', id: profile.user_id } : {},
    occurredAt: validTime(profile.updated_at, now),
    observedAt: now,
    priority: 65,
    sensitivity: 'private',
    trust: 'observed',
    metadata: { canonicalKey: `memory.user_profile:${userId}` },
  }
}

function projectSelfState(request = {}) {
  const now = observedAt(request)
  const projection = request.selfProjection || {}
  const items = []
  if (cleanText(projection.snapshot?.snapshotText)) {
    items.push({
      topic: 'runtime.self_snapshot',
      subject: { agent: 'primary' },
      authorship: 'agent',
      semanticKind: 'system_fact',
      payload: { snapshotText: cleanText(projection.snapshot.snapshotText) },
      occurredAt: now,
      observedAt: now,
      priority: 75,
      sensitivity: 'private',
      trust: 'observed',
    })
  }
  if (cleanText(projection.perception?.perceptionText)) {
    items.push({
      topic: 'runtime.self_perception',
      subject: { agent: 'primary' },
      authorship: 'agent',
      semanticKind: 'system_fact',
      payload: {
        perceptionText: cleanText(projection.perception.perceptionText),
        boundaryState: cleanText(projection.perception.boundaryState) || 'normal',
        mirrorScore: Number(projection.perception.mirror?.score) || 0,
        loopDepth: Number(projection.perception.loop) || 0,
      },
      occurredAt: now,
      observedAt: now,
      priority: 80,
      sensitivity: 'private',
      trust: 'observed',
    })
  }
  if (
    cleanText(projection.perception?.boundaryDirective)
    && cleanText(projection.perception?.boundaryState) !== 'normal'
  ) {
    items.push({
      topic: 'policy.boundary_state',
      subject: { agent: 'primary', state: cleanText(projection.perception.boundaryState) },
      authorship: 'system',
      semanticKind: 'policy',
      payload: { directive: cleanText(projection.perception.boundaryDirective) },
      occurredAt: now,
      observedAt: now,
      priority: 95,
      sensitivity: 'private',
      trust: 'authoritative',
    })
  }
  if (cleanText(projection.evolution)) {
    items.push({
      topic: 'memory.self_evolution',
      subject: { agent: 'primary' },
      authorship: 'agent',
      semanticKind: 'memory',
      payload: { contextText: cleanText(projection.evolution) },
      occurredAt: now,
      observedAt: now,
      priority: 70,
      sensitivity: 'private',
      trust: 'observed',
    })
  }
  return items
}

function projectCapabilityPrefeed(entry = {}, request = {}, index = 0) {
  const now = observedAt(request)
  const capabilityId = cleanText(entry.id) || `capability-${index + 1}`
  return {
    topic: 'runtime.capability_prefeed',
    subject: { capabilityId },
    authorship: 'system',
    semanticKind: 'system_fact',
    payload: { capabilityId, contextText: cleanText(entry.text) },
    occurredAt: now,
    observedAt: now,
    priority: 72,
    sensitivity: 'private',
    trust: 'observed',
    metadata: { canonicalKey: `runtime.capability_prefeed:${capabilityId}` },
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
    legacyComponents: ['memories'],
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
    legacyComponents: ['activePolicies'],
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
    legacyComponents: ['knowledgeEvidence'],
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
    legacyComponents: ['task'],
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

  registered.push(registry.register({
    id: 'policy:behavioral-constraints',
    kind: 'query',
    domain: 'constraints',
    topics: ['policy.behavioral_constraint'],
    description: 'Active behavioral constraints selected by the legacy memory repository for this turn.',
    legacyComponents: ['constraints'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 20,
    maxChars: 12_000,
    rank: 98,
    collect: request => (request.constraintsProjection || [])
      .filter(constraint => cleanText(constraint?.content))
      .map((constraint, index) => projectConstraint(constraint, request, index)),
  }))

  registered.push(registry.register({
    id: 'knowledge:prefetch-cache',
    kind: 'snapshot',
    domain: 'prefetch',
    topics: ['knowledge.prefetched'],
    description: 'Valid prefetched knowledge cache entries already collected by the legacy prefetch loop.',
    legacyComponents: ['prefetch'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 30,
    maxChars: 18_000,
    rank: 68,
    collect: request => (request.prefetchProjection || [])
      .filter(item => cleanText(item?.content))
      .map((item, index) => projectPrefetch(item, request, index)),
  }))

  registered.push(registry.register({
    id: 'scene:manifest',
    kind: 'snapshot',
    domain: 'scene',
    topics: ['ui.scene_manifest'],
    description: 'Compact projection of the surfaces currently visible in the Agent UI.',
    legacyComponents: ['scene'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 6_000,
    rank: 55,
    match: request => (request.sceneProjection?.manifest || []).length > 0,
    collect: request => {
      const now = observedAt(request)
      return {
        topic: 'ui.scene_manifest',
        subject: { revision: Number(request.sceneProjection?.revision) || 0 },
        authorship: 'system',
        semanticKind: 'ui_signal',
        payload: {
          surfaces: (request.sceneProjection?.manifest || []).map(surface => ({
            id: cleanText(surface?.id),
            kind: cleanText(surface?.kind),
            intent: cleanText(surface?.intent) || 'inform',
            focus: surface?.focus === true,
          })),
        },
        occurredAt: now,
        observedAt: now,
        priority: 50,
        sensitivity: 'private',
        trust: 'authoritative',
      }
    },
  }))

  registered.push(registry.register({
    id: 'identity:person-memory',
    kind: 'snapshot',
    domain: 'identity',
    topics: ['memory.person_context'],
    description: 'Root person memory for the current conversation participant.',
    legacyComponents: ['personMemory'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 8_000,
    rank: 72,
    match: request => !!request.identityProjection?.personMemory,
    collect: request => projectPersonMemory(request.identityProjection.personMemory, request),
  }))

  registered.push(registry.register({
    id: 'identity:user-profile',
    kind: 'snapshot',
    domain: 'identity',
    topics: ['memory.user_profile'],
    description: 'Inferred working profile of the current user, explicitly represented as an impression rather than fact.',
    legacyComponents: ['userProfile'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 10_000,
    rank: 68,
    match: request => !!request.identityProjection?.userProfile,
    collect: request => projectUserProfile(request.identityProjection.userProfile, request),
  }))

  registered.push(registry.register({
    id: 'self:current-state',
    kind: 'snapshot',
    domain: 'self',
    topics: [
      'runtime.self_snapshot',
      'runtime.self_perception',
      'policy.boundary_state',
      'memory.self_evolution',
    ],
    description: 'Agent proprioception, boundary state, and selected self-evolution context for this turn.',
    legacyComponents: ['selfSnapshot', 'selfPerception', 'selfEvolution'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 4,
    maxChars: 14_000,
    rank: 85,
    collect: request => projectSelfState(request),
  }))

  registered.push(registry.register({
    id: 'capability:prefeed',
    kind: 'query',
    domain: 'capability',
    topics: ['runtime.capability_prefeed'],
    description: 'Compatibility projection of capability-prefetched runtime context selected for the current message.',
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 30,
    maxChars: 18_000,
    rank: 78,
    collect: request => (request.capabilityProjection?.entries || [])
      .filter(entry => cleanText(entry?.text))
      .map((entry, index) => projectCapabilityPrefeed(entry, request, index)),
  }))

  initializedRegistries.add(registry)
  return registered
}
