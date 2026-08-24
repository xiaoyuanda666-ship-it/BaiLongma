import crypto from 'node:crypto'
import { buildSystemEnvironmentContext } from '../context/system-environment-context.js'

function cleanText(value) {
  return String(value || '').trim()
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function sortedRecords(records = []) {
  return [...records].sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
}

function envelopeFields(event = {}) {
  return {
    authorship: cleanText(event.authorship),
    semanticKind: cleanText(event.semanticKind),
    trust: cleanText(event.trust),
  }
}

function expectedEnvelope(authorship, semanticKind, trust) {
  return { authorship, semanticKind, trust }
}

function normalizedNow(request = {}) {
  const value = request.now instanceof Date ? request.now : new Date(request.now || Date.now())
  return Number.isFinite(value.getTime()) ? value : new Date()
}

function memoryId(memory = {}, index = 0) {
  return String(memory.mem_id || memory.id || `projection-${index + 1}`)
}

function memoryRecord(memory = {}, index = 0, {
  topic = 'memory.relevant',
  retrievalLane = '',
} = {}) {
  const policy = topic === 'policy.active_memory'
  return {
    topic,
    id: memoryId(memory, index),
    content: String(memory.content || ''),
    detail: String(memory.detail || ''),
    title: String(memory.title || ''),
    eventType: String(memory.event_type || ''),
    importance: Number(memory.importance) || 0,
    salience: Number(memory.salience) || 0,
    tags: safeJsonArray(memory.tags).map(String),
    activationReasons: Array.isArray(memory._policyReasons) ? memory._policyReasons.map(String) : [],
    retrievalLane,
    ...expectedEnvelope('system', policy ? 'policy' : 'memory', policy ? 'authoritative' : 'observed'),
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

function expectedRuntime(request = {}) {
  const now = normalizedNow(request)
  const records = [{
    topic: 'runtime.clock',
    localTimestamp: cleanText(request.currentTime) || now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local',
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now),
    ...expectedEnvelope('system', 'system_fact', 'authoritative'),
  }]

  if (cleanText(request.existenceDesc)) {
    records.push({
      topic: 'runtime.existence',
      description: cleanText(request.existenceDesc),
      ...expectedEnvelope('system', 'system_fact', 'authoritative'),
    })
  }
  if (request.securityProjection) {
    records.push({
      topic: 'runtime.security',
      fileSandboxEnabled: request.securityProjection.fileSandbox !== false,
      execSandboxEnabled: request.securityProjection.execSandbox !== false,
      changedAt: cleanText(request.securityProjection.updatedAt),
      ...expectedEnvelope('system', 'system_fact', 'authoritative'),
    })
  }
  if (cleanText(request.currentChannel)) {
    records.push({
      topic: 'runtime.channel',
      channel: String(request.currentChannel || ''),
      switched: request.channelSwitched === true,
      ...expectedEnvelope('system', 'system_fact', 'observed'),
    })
  }
  for (const [component, value] of Object.entries(request.runtimeComponents || {})) {
    if (!cleanText(value)) continue
    records.push({
      topic: 'runtime.legacy_component',
      component,
      contextText: String(value),
      ...expectedEnvelope('system', 'system_fact', 'observed'),
    })
  }
  return records
}

function actualRuntime(events = []) {
  return events.flatMap(event => {
    const common = envelopeFields(event)
    if (event.topic === 'runtime.clock') {
      return [{
        topic: event.topic,
        localTimestamp: cleanText(event.payload?.localTimestamp),
        timezone: cleanText(event.payload?.timezone),
        weekday: cleanText(event.payload?.weekday),
        ...common,
      }]
    }
    if (event.topic === 'runtime.existence') {
      return [{ topic: event.topic, description: cleanText(event.payload?.description), ...common }]
    }
    if (event.topic === 'runtime.security') {
      return [{
        topic: event.topic,
        fileSandboxEnabled: event.payload?.fileSandboxEnabled === true,
        execSandboxEnabled: event.payload?.execSandboxEnabled === true,
        changedAt: cleanText(event.payload?.changedAt),
        ...common,
      }]
    }
    if (event.topic === 'runtime.channel') {
      return [{
        topic: event.topic,
        channel: String(event.payload?.channel || ''),
        switched: event.payload?.switched === true,
        ...common,
      }]
    }
    if (event.topic === 'runtime.legacy_component') {
      return [{
        topic: event.topic,
        component: cleanText(event.subject?.component),
        contextText: String(event.payload?.contextText || ''),
        ...common,
      }]
    }
    return []
  })
}

function expectedEnvironment(request = {}) {
  const contextText = request.systemEnvironmentContext
    ?? buildSystemEnvironmentContext(request.message || '')
  if (!cleanText(contextText)) return []
  return [{
    topic: 'environment.host_context',
    contextText: String(contextText),
    ...expectedEnvelope('system', 'system_fact', 'observed'),
  }]
}

function actualEnvironment(events = []) {
  return events
    .filter(event => event.topic === 'environment.host_context')
    .map(event => ({
      topic: event.topic,
      contextText: String(event.payload?.contextText || ''),
      ...envelopeFields(event),
    }))
}

function expectedMemory(request = {}) {
  const relevant = uniqueMemories([
    ['relevant', request.memoryProjection?.memories],
    ['recall', request.memoryProjection?.recallMemories],
  ]).map((memory, index) => memoryRecord(memory, index, {
    topic: 'memory.relevant',
    retrievalLane: cleanText(memory.retrievalLane),
  }))
  const policies = (request.memoryProjection?.activePolicies || [])
    .map((memory, index) => memoryRecord(memory, index, { topic: 'policy.active_memory' }))
  const refresh = (request.memoryProjection?.refreshMemories || [])
    .map((memory, index) => memoryRecord(memory, index, {
      topic: 'memory.refresh',
      retrievalLane: 'refresh',
    }))
  return [...relevant, ...policies, ...refresh]
}

function actualMemory(events = []) {
  return events
    .filter(event => ['memory.relevant', 'policy.active_memory', 'memory.refresh'].includes(event.topic))
    .map(event => ({
      topic: event.topic,
      id: cleanText(event.subject?.memoryId),
      content: String(event.payload?.content || ''),
      detail: String(event.payload?.detail || ''),
      title: String(event.payload?.title || ''),
      eventType: String(event.payload?.eventType || ''),
      importance: Number(event.payload?.importance) || 0,
      salience: Number(event.payload?.salience) || 0,
      tags: safeJsonArray(event.payload?.tags).map(String),
      activationReasons: safeJsonArray(event.payload?.activationReasons).map(String),
      retrievalLane: cleanText(event.payload?.retrievalLane),
      ...envelopeFields(event),
    }))
}

function expectedKnowledge(request = {}) {
  const evidence = (request.knowledgeProjection?.evidence || []).map((item, index) => ({
    topic: 'knowledge.evidence',
    citationId: String(item.citation_id || item.chunk_id || item.id || `K:${index + 1}`),
    documentId: item.document_id ?? '',
    chunkId: item.chunk_id ?? item.id ?? '',
    documentTitle: String(item.document_title || item.title || ''),
    documentVersion: String(item.document_version || ''),
    sourceUri: String(item.source_uri || item.sourceUri || ''),
    context: String(item.context || ''),
    locator: item.locator || item.locator_json || {},
    content: String(item.chunk_text || item.text || item.content || ''),
    ...expectedEnvelope('external', 'knowledge', 'verified'),
  }))
  const refresh = cleanText(request.knowledgeProjection?.refreshResults)
    ? [{
        topic: 'knowledge.refresh_results',
        content: cleanText(request.knowledgeProjection.refreshResults),
        ...expectedEnvelope('external', 'knowledge', 'observed'),
      }]
    : []
  return [...evidence, ...refresh]
}

function actualKnowledge(events = []) {
  return events.flatMap(event => {
    if (event.topic === 'knowledge.evidence') {
      return [{
        topic: event.topic,
        citationId: cleanText(event.payload?.citationId),
        documentId: event.subject?.documentId ?? '',
        chunkId: event.subject?.chunkId ?? '',
        documentTitle: String(event.payload?.documentTitle || ''),
        documentVersion: String(event.payload?.documentVersion || ''),
        sourceUri: String(event.payload?.sourceUri || ''),
        context: String(event.payload?.context || ''),
        locator: event.payload?.locator || {},
        content: String(event.payload?.content || ''),
        ...envelopeFields(event),
      }]
    }
    if (event.topic === 'knowledge.refresh_results') {
      return [{
        topic: event.topic,
        content: cleanText(event.payload?.content),
        ...envelopeFields(event),
      }]
    }
    return []
  })
}

function taskSteps(value = []) {
  return (Array.isArray(value) ? value : []).map(step => ({
    text: String(step?.text || ''),
    status: String(step?.status || 'pending'),
    note: String(step?.note || ''),
  }))
}

function expectedTask(request = {}) {
  const task = String(request.taskProjection?.task || '')
  const steps = taskSteps(request.taskProjection?.steps)
  return [{
    topic: 'task.current_state',
    taskId: cleanText(request.taskProjection?.taskId),
    active: !!task.trim() || steps.length > 0,
    task,
    steps,
    ...expectedEnvelope('system', 'task_state', 'authoritative'),
  }]
}

function actualTask(events = []) {
  return events
    .filter(event => event.topic === 'task.current_state')
    .map(event => ({
      topic: event.topic,
      taskId: cleanText(event.subject?.taskId),
      active: event.payload?.active === true,
      task: String(event.payload?.task || ''),
      steps: taskSteps(event.payload?.steps),
      ...envelopeFields(event),
    }))
}

function expectedConstraints(request = {}) {
  return (request.constraintsProjection || [])
    .filter(constraint => cleanText(constraint?.content))
    .map((constraint, index) => {
      const tags = safeJsonArray(constraint.tags).map(String)
      return {
        topic: 'policy.behavioral_constraint',
        id: String(constraint.mem_id || constraint.id || `projection-${index + 1}`),
        content: cleanText(constraint.content),
        detail: cleanText(constraint.detail),
        dimension: tags.find(tag => tag.startsWith('dimension:'))?.slice('dimension:'.length) || '',
        tags,
        ...expectedEnvelope('system', 'policy', 'authoritative'),
      }
    })
}

function actualConstraints(events = []) {
  return events
    .filter(event => event.topic === 'policy.behavioral_constraint')
    .map(event => ({
      topic: event.topic,
      id: cleanText(event.subject?.constraintId),
      content: cleanText(event.payload?.content),
      detail: cleanText(event.payload?.detail),
      dimension: cleanText(event.payload?.dimension),
      tags: safeJsonArray(event.payload?.tags).map(String),
      ...envelopeFields(event),
    }))
}

function expectedPrefetch(request = {}) {
  return (request.prefetchProjection || [])
    .filter(item => cleanText(item?.content))
    .map((item, index) => ({
      topic: 'knowledge.prefetched',
      id: item.id == null ? '' : String(item.id),
      provider: cleanText(item.source) || `prefetch-${index + 1}`,
      content: cleanText(item.content),
      tags: safeJsonArray(item.tags).map(String),
      fetchedAt: cleanText(item.fetched_at),
      expiresAt: cleanText(item.expires_at),
      ...expectedEnvelope('external', 'knowledge', 'observed'),
    }))
}

function actualPrefetch(events = []) {
  return events
    .filter(event => event.topic === 'knowledge.prefetched')
    .map(event => ({
      topic: event.topic,
      id: event.subject?.cacheId == null ? '' : String(event.subject.cacheId),
      provider: cleanText(event.payload?.provider),
      content: cleanText(event.payload?.content),
      tags: safeJsonArray(event.payload?.tags).map(String),
      fetchedAt: cleanText(event.payload?.fetchedAt),
      expiresAt: cleanText(event.payload?.expiresAt),
      ...envelopeFields(event),
    }))
}

function sceneRecord(surface = {}, event = null) {
  return {
    topic: 'ui.scene_manifest',
    id: cleanText(surface.id),
    kind: cleanText(surface.kind),
    intent: cleanText(surface.intent) || 'inform',
    focus: surface.focus === true,
    ...(event
      ? envelopeFields(event)
      : expectedEnvelope('system', 'ui_signal', 'authoritative')),
  }
}

function expectedScene(request = {}) {
  return (request.sceneProjection?.manifest || []).map(surface => sceneRecord(surface))
}

function actualScene(events = []) {
  return events
    .filter(event => event.topic === 'ui.scene_manifest')
    .flatMap(event => (event.payload?.surfaces || []).map(surface => sceneRecord(surface, event)))
}

function expectedIdentity(request = {}) {
  const projection = request.identityProjection || {}
  const records = []
  if (projection.personMemory) {
    const memory = projection.personMemory
    records.push({
      topic: 'memory.person_context',
      id: memoryId(memory),
      userId: cleanText(projection.userId),
      content: cleanText(memory.content),
      detail: cleanText(memory.detail),
      entities: safeJsonArray(memory.entities).map(String),
      ...expectedEnvelope('system', 'memory', 'observed'),
    })
  }
  if (projection.userProfile) {
    const profile = projection.userProfile
    records.push({
      topic: 'memory.user_profile',
      userId: cleanText(profile.user_id || projection.userId) || 'current-user',
      workingImpression: true,
      summary: cleanText(profile.summary),
      roles: Array.isArray(profile.roles) ? profile.roles : [],
      domains: Array.isArray(profile.domains) ? profile.domains : [],
      expertise: Array.isArray(profile.expertise) ? profile.expertise : [],
      projects: Array.isArray(profile.projects) ? profile.projects : [],
      preferences: Array.isArray(profile.preferences) ? profile.preferences : [],
      communicationStyle: Array.isArray(profile.communication_style) ? profile.communication_style : [],
      confidence: Number(profile.confidence) || 0,
      ...expectedEnvelope('system', 'memory', 'observed'),
    })
  }
  return records
}

function actualIdentity(events = []) {
  return events.flatMap(event => {
    if (event.topic === 'memory.person_context') {
      return [{
        topic: event.topic,
        id: cleanText(event.subject?.memoryId),
        userId: cleanText(event.subject?.userId),
        content: cleanText(event.payload?.content),
        detail: cleanText(event.payload?.detail),
        entities: safeJsonArray(event.payload?.entities).map(String),
        ...envelopeFields(event),
      }]
    }
    if (event.topic === 'memory.user_profile') {
      return [{
        topic: event.topic,
        userId: cleanText(event.subject?.userId),
        workingImpression: event.payload?.workingImpression === true,
        summary: cleanText(event.payload?.summary),
        roles: Array.isArray(event.payload?.roles) ? event.payload.roles : [],
        domains: Array.isArray(event.payload?.domains) ? event.payload.domains : [],
        expertise: Array.isArray(event.payload?.expertise) ? event.payload.expertise : [],
        projects: Array.isArray(event.payload?.projects) ? event.payload.projects : [],
        preferences: Array.isArray(event.payload?.preferences) ? event.payload.preferences : [],
        communicationStyle: Array.isArray(event.payload?.communicationStyle) ? event.payload.communicationStyle : [],
        confidence: Number(event.payload?.confidence) || 0,
        ...envelopeFields(event),
      }]
    }
    return []
  })
}

function expectedSelf(request = {}) {
  const projection = request.selfProjection || {}
  const records = []
  if (cleanText(projection.snapshot?.snapshotText)) {
    records.push({
      topic: 'runtime.self_snapshot',
      snapshotText: cleanText(projection.snapshot.snapshotText),
      ...expectedEnvelope('agent', 'system_fact', 'observed'),
    })
  }
  if (cleanText(projection.perception?.perceptionText)) {
    records.push({
      topic: 'runtime.self_perception',
      perceptionText: cleanText(projection.perception.perceptionText),
      boundaryState: cleanText(projection.perception.boundaryState) || 'normal',
      mirrorScore: Number(projection.perception.mirror?.score) || 0,
      loopDepth: Number(projection.perception.loop) || 0,
      ...expectedEnvelope('agent', 'system_fact', 'observed'),
    })
  }
  if (
    cleanText(projection.perception?.boundaryDirective)
    && cleanText(projection.perception?.boundaryState) !== 'normal'
  ) {
    records.push({
      topic: 'policy.boundary_state',
      state: cleanText(projection.perception.boundaryState),
      directive: cleanText(projection.perception.boundaryDirective),
      ...expectedEnvelope('system', 'policy', 'authoritative'),
    })
  }
  if (cleanText(projection.evolution)) {
    records.push({
      topic: 'memory.self_evolution',
      contextText: cleanText(projection.evolution),
      ...expectedEnvelope('agent', 'memory', 'observed'),
    })
  }
  return records
}

function actualSelf(events = []) {
  return events.flatMap(event => {
    const common = envelopeFields(event)
    if (event.topic === 'runtime.self_snapshot') {
      return [{ topic: event.topic, snapshotText: cleanText(event.payload?.snapshotText), ...common }]
    }
    if (event.topic === 'runtime.self_perception') {
      return [{
        topic: event.topic,
        perceptionText: cleanText(event.payload?.perceptionText),
        boundaryState: cleanText(event.payload?.boundaryState),
        mirrorScore: Number(event.payload?.mirrorScore) || 0,
        loopDepth: Number(event.payload?.loopDepth) || 0,
        ...common,
      }]
    }
    if (event.topic === 'policy.boundary_state') {
      return [{
        topic: event.topic,
        state: cleanText(event.subject?.state),
        directive: cleanText(event.payload?.directive),
        ...common,
      }]
    }
    if (event.topic === 'memory.self_evolution') {
      return [{ topic: event.topic, contextText: cleanText(event.payload?.contextText), ...common }]
    }
    return []
  })
}

function expectedCapability(request = {}) {
  return (request.capabilityProjection?.entries || [])
    .filter(entry => cleanText(entry?.text))
    .map((entry, index) => {
      const capabilityId = cleanText(entry.id) || `capability-${index + 1}`
      return {
        topic: 'runtime.capability_prefeed',
        capabilityId,
        contextText: cleanText(entry.text),
        ...expectedEnvelope('system', 'system_fact', 'observed'),
      }
    })
}

function actualCapability(events = []) {
  return events
    .filter(event => event.topic === 'runtime.capability_prefeed')
    .map(event => ({
      topic: event.topic,
      capabilityId: cleanText(event.payload?.capabilityId || event.subject?.capabilityId),
      contextText: cleanText(event.payload?.contextText),
      ...envelopeFields(event),
    }))
}

const DOMAIN_PARITY = Object.freeze({
  runtime: { expected: expectedRuntime, actual: actualRuntime },
  environment: { expected: expectedEnvironment, actual: actualEnvironment },
  memory: { expected: expectedMemory, actual: actualMemory },
  knowledge: { expected: expectedKnowledge, actual: actualKnowledge },
  task: { expected: expectedTask, actual: actualTask },
  constraints: { expected: expectedConstraints, actual: actualConstraints },
  prefetch: { expected: expectedPrefetch, actual: actualPrefetch },
  scene: { expected: expectedScene, actual: actualScene },
  identity: { expected: expectedIdentity, actual: actualIdentity },
  self: { expected: expectedSelf, actual: actualSelf },
  capability: { expected: expectedCapability, actual: actualCapability },
})

function eventsByDomain(frame = {}, collection = {}) {
  const domainsBySourceId = new Map((collection.results || []).map(result => (
    [result.source.id, result.source.domain]
  )))
  const byDomain = new Map()
  for (const item of frame.contextItems || []) {
    const event = item.event || {}
    const domain = domainsBySourceId.get(event.source?.id) || ''
    if (!domain) continue
    const events = byDomain.get(domain) || []
    events.push(event)
    byDomain.set(domain, events)
  }
  return byDomain
}

export function evaluateInformationSourceParity({
  domains = [],
  request = {},
  frame = {},
  collection = {},
} = {}) {
  const domainEvents = eventsByDomain(frame, collection)
  const byDomain = {}
  const passedDomains = []
  const failedDomains = []

  for (const domain of [...new Set(domains.map(value => cleanText(value).toLowerCase()).filter(Boolean))]) {
    const adapter = DOMAIN_PARITY[domain]
    if (!adapter) {
      byDomain[domain] = {
        passed: false,
        reason: 'missing_parity_adapter',
        expectedRecordCount: 0,
        actualRecordCount: 0,
        expectedHash: '',
        actualHash: '',
      }
      failedDomains.push(domain)
      continue
    }
    const expected = sortedRecords(adapter.expected(request))
    const actual = sortedRecords(adapter.actual(domainEvents.get(domain) || []))
    const expectedHash = hash(expected)
    const actualHash = hash(actual)
    const passed = expectedHash === actualHash
    byDomain[domain] = {
      passed,
      reason: passed ? 'semantic_match' : 'semantic_mismatch',
      expectedRecordCount: expected.length,
      actualRecordCount: actual.length,
      expectedHash,
      actualHash,
    }
    if (passed) passedDomains.push(domain)
    else failedDomains.push(domain)
  }

  return {
    passed: failedDomains.length === 0,
    passedDomains,
    failedDomains,
    byDomain,
    audit: {
      parityDomainCount: Object.keys(byDomain).length,
      parityPassedDomainCount: passedDomains.length,
      parityFailedDomainCount: failedDomains.length,
      parityByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.passed ? 1 : 0]
      ))),
      parityExpectedRecordsByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.expectedRecordCount]
      ))),
      parityActualRecordsByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.actualRecordCount]
      ))),
    },
  }
}
