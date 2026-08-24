import assert from 'node:assert/strict'

delete process.env.BAILONGMA_INFORMATION_SOURCE_RENDER
delete process.env.BAILONGMA_INFORMATION_MODE

const { InformationSourceRegistry } = await import('./information/source-registry.js')
const { buildLLMMessages } = await import('./runtime/messages.js')
const { buildContextBlock } = await import('./prompt.js')
const {
  listInformationSourceRenderableDomains,
  isInformationSourceRenderEnabled,
  applyInformationSourceRender,
  renderInformationSourceContext,
} = await import('./information/source-renderer.js')

const now = new Date('2026-08-24T12:00:00.000Z')

const allDomains = [
  'runtime',
  'environment',
  'memory',
  'knowledge',
  'task',
  'constraints',
  'prefetch',
  'scene',
  'identity',
  'self',
  'capability',
]
assert.deepEqual(listInformationSourceRenderableDomains(), allDomains)
assert.equal(isInformationSourceRenderEnabled('scene', {}), true)
assert.equal(
  isInformationSourceRenderEnabled('memory', { BAILONGMA_INFORMATION_SOURCE_RENDER: 'all' }),
  true,
)
assert.equal(
  isInformationSourceRenderEnabled('memory', { BAILONGMA_INFORMATION_SOURCE_RENDER: 'none' }),
  false,
)
assert.equal(
  isInformationSourceRenderEnabled('scene', { BAILONGMA_INFORMATION_MODE: 'legacy' }),
  false,
)
const defaultRendered = await renderInformationSourceContext({ request: { now } }, {
  env: {},
  registry: new InformationSourceRegistry(),
})
assert.equal(defaultRendered.enabled, true)
assert.equal(defaultRendered.rendered, true)
assert.deepEqual(defaultRendered.domains, allDomains)
assert.equal(defaultRendered.audit.parityPassedDomainCount, allDomains.length)
assert.equal(defaultRendered.audit.parityFailedDomainCount, 0)
assert.deepEqual(await renderInformationSourceContext({}, {
  env: { BAILONGMA_INFORMATION_MODE: 'legacy' },
  registry: new InformationSourceRegistry(),
}), {
  enabled: false,
  rendered: false,
  domains: [],
  legacyComponentsToSuppress: [],
  contextText: '',
})

const legacyComponents = {
  scene: 'legacy scene manifest',
  prefetch: 'legacy prefetch cache',
  runtime: 'unrelated legacy runtime',
}
const rendered = await renderInformationSourceContext({
  request: {
    sceneProjection: {
      revision: 9,
      manifest: [{ id: 'weather-main', kind: 'weather', intent: 'inform', focus: true }],
    },
    prefetchProjection: [{
      id: 41,
      source: 'weather:test',
      content: 'Shanghai: sunny, 28C',
      fetched_at: '2026-08-24T11:55:00.000Z',
      expires_at: '2026-08-24T13:00:00.000Z',
    }],
    now,
  },
  legacyComponents,
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'scene,prefetch' },
  registry: new InformationSourceRegistry(),
})
assert.equal(rendered.enabled, true)
assert.equal(rendered.rendered, true)
assert.deepEqual(rendered.domains, ['prefetch', 'scene'])
assert.deepEqual(rendered.legacyComponentsToSuppress, ['prefetch', 'scene'])
assert.equal(rendered.audit.sourceCount, 2)
assert.equal(rendered.audit.itemCount, 2)
assert.equal(rendered.audit.legacyCoveredComponentCount, 2)
assert.equal(rendered.audit.legacyUncoveredComponentCount, 1)
assert.equal(rendered.audit.suppressedLegacyComponentCount, 2)
assert.equal(rendered.audit.parityDomainCount, 2)
assert.equal(rendered.audit.parityPassedDomainCount, 2)
assert.equal(rendered.audit.parityFailedDomainCount, 0)
assert.deepEqual(rendered.audit.parityByDomain, { scene: 1, prefetch: 1 })
assert.match(rendered.contextText, /topic="ui\.scene_manifest"/)
assert.match(rendered.contextText, /topic="knowledge\.prefetched"/)
assert.equal(Object.hasOwn(rendered.audit, 'contextText'), false)
assert.equal(legacyComponents.scene, 'legacy scene manifest', 'renderer does not mutate caller-owned legacy data')

const applied = applyInformationSourceRender({
  components: legacyComponents,
  informationContextText: '<context-information>existing activation</context-information>',
}, rendered)
assert.equal(applied.components.scene, '')
assert.equal(applied.components.prefetch, '')
assert.equal(applied.components.runtime, 'unrelated legacy runtime')
assert.equal(applied.legacyContextText, 'unrelated legacy runtime')
assert.doesNotMatch(applied.legacyContextText, /legacy scene|legacy prefetch/)
assert.match(applied.informationContextText, /existing activation/)
assert.match(applied.informationContextText, /ui\.scene_manifest/)
assert.match(applied.informationContextText, /knowledge\.prefetched/)

const messages = buildLLMMessages({
  systemPrompt: 'stable system prompt',
  contextBlock: `<context><extra>${applied.legacyContextText}</extra></context>`,
  informationContextBlock: applied.informationContextText,
  input: '现在天气怎么样？',
  msg: { content: '现在天气怎么样？' },
  runtimeLane: 'l1',
})
assert.equal(messages[1].role, 'system')
assert.match(messages[1].content, /ui\.scene_manifest/)
assert.equal(messages.at(-1).role, 'user')
assert.equal(messages.at(-1).content, '现在天气怎么样？')
assert.doesNotMatch(messages.at(-1).content, /scene_manifest|prefetched|legacy/)

const unapplied = applyInformationSourceRender({
  components: legacyComponents,
  informationContextText: 'existing activation',
}, { rendered: false })
assert.deepEqual(unapplied.components, legacyComponents)
assert.equal(unapplied.informationContextText, 'existing activation')

const constraint = {
  id: 71,
  mem_id: 'C:71',
  content: '发布前必须先运行验证',
  detail: '验证失败时不能宣称完成',
  tags: JSON.stringify(['dimension:release-safety', 'kind:constraint']),
  timestamp: '2026-08-24T11:00:00.000Z',
}
const constraintsRendered = await renderInformationSourceContext({
  request: { now, constraintsProjection: [constraint] },
  legacyComponents: { constraints: `- ${constraint.content}` },
  domains: ['constraints'],
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'constraints' },
  registry: new InformationSourceRegistry(),
})
assert.equal(constraintsRendered.rendered, true)
assert.deepEqual(constraintsRendered.legacyComponentsToSuppress, ['constraints'])
assert.equal(constraintsRendered.audit.parityByDomain.constraints, 1)
assert.equal(constraintsRendered.audit.parityExpectedRecordsByDomain.constraints, 1)
assert.equal(constraintsRendered.audit.parityActualRecordsByDomain.constraints, 1)
assert.match(constraintsRendered.contextText, /semantic_kind="policy"/)
assert.match(constraintsRendered.contextText, /发布前必须先运行验证/)

const constraintsApplied = applyInformationSourceRender({
  components: { runtime: 'runtime stays' },
  contextArgs: { constraints: [constraint], extraContext: 'runtime stays' },
  informationContextText: '',
}, constraintsRendered)
assert.deepEqual(constraintsApplied.contextArgs.constraints, [])
assert.equal(constraintsApplied.contextArgs.extraContext, 'runtime stays')
const contextWithoutLegacyConstraint = buildContextBlock(constraintsApplied.contextArgs)
assert.doesNotMatch(contextWithoutLegacyConstraint, /<constraints>/)

const fullRequest = {
  message: '检查完整信息上下文',
  currentTime: '2026-08-24T20:00:00+08:00',
  existenceDesc: '10 days',
  currentChannel: 'WECHAT',
  channelSwitched: true,
  securityProjection: { fileSandbox: true, execSandbox: false, updatedAt: '2026-08-24T10:00:00.000Z' },
  systemEnvironmentContext: '## Host Environment\nOS: test-only',
  runtimeComponents: {
    presence: '<presence>online</presence>',
    runtime: '<runtime-extra>stable</runtime-extra>',
  },
  memoryProjection: {
    memories: [{ id: 11, mem_id: 'M:11', content: '用户喜欢简洁回答', detail: 'observed preference' }],
    recallMemories: [],
    activePolicies: [{ id: 21, mem_id: 'P:21', content: '发布前必须验证', detail: 'active policy' }],
  },
  knowledgeProjection: {
    evidence: [{
      citation_id: 'K:3:7',
      document_id: 3,
      chunk_id: 7,
      document_title: 'Release handbook',
      source_uri: 'file:///release.md',
      chunk_text: 'Verification is required before release.',
    }],
  },
  taskProjection: {
    task: '发布新版本',
    steps: [{ text: '运行验证', status: 'pending' }],
  },
  constraintsProjection: [constraint],
  prefetchProjection: [{
    id: 41,
    source: 'weather:test',
    content: 'Shanghai: sunny, 28C',
    tags: JSON.stringify(['weather']),
    fetched_at: '2026-08-24T11:55:00.000Z',
    expires_at: '2026-08-24T13:00:00.000Z',
  }],
  sceneProjection: {
    revision: 7,
    manifest: [{ id: 'weather-main', kind: 'weather', intent: 'inform', focus: true }],
  },
  identityProjection: {
    userId: 'ID:test-user',
    personMemory: {
      id: 51,
      mem_id: 'PERSON:51',
      content: '长期合作中的产品负责人',
      detail: '偏好先看结论',
      entities: JSON.stringify(['ID:test-user']),
    },
    userProfile: {
      user_id: 'ID:test-user',
      summary: '熟悉 agent 系统设计',
      roles: [{ label: '产品负责人', confidence: 0.9 }],
      domains: ['agent architecture'],
      communication_style: [{ label: '结论优先', confidence: 0.8 }],
      confidence: 0.85,
      updated_at: '2026-08-24T10:00:00.000Z',
    },
  },
  selfProjection: {
    snapshot: { snapshotText: '你是小白龙，最近保持了简洁表达。' },
    perception: {
      perceptionText: '检测到当前输入与上一轮输出高度相似。',
      boundaryState: 'mirror',
      boundaryDirective: '先确认对方意图，不要继续复述。',
      mirror: { score: 0.92 },
      loop: 1,
    },
    evolution: '最近学到：发布前先验证。',
  },
  capabilityProjection: {
    entries: [{ id: 'weather', text: 'Weather capability context for Shanghai.' }],
  },
  now,
}
const fullLegacyComponents = {
  presence: '<presence>online</presence>',
  runtime: '<runtime-extra>stable</runtime-extra>',
  capability: 'Weather capability context for Shanghai.',
  prefetch: 'legacy prefetch',
  scene: 'legacy scene',
  currentTime: 'Current time: 2026-08-24T20:00:00+08:00',
  existence: '10 days',
  security: 'legacy sandbox status',
  systemEnvironment: '## Host Environment\nOS: test-only',
  channel: 'WECHAT',
  memories: 'legacy memories',
  activePolicies: 'legacy active policies',
  knowledgeEvidence: 'legacy evidence',
  task: 'legacy task state',
  constraints: constraint.content,
  personMemory: 'legacy person memory',
  userProfile: 'legacy user profile',
  selfSnapshot: 'legacy self snapshot',
  selfPerception: 'legacy self perception',
  selfEvolution: 'legacy self evolution',
}
const fullRendered = await renderInformationSourceContext({
  request: fullRequest,
  legacyComponents: fullLegacyComponents,
}, {
  env: {},
  registry: new InformationSourceRegistry(),
})
assert.equal(fullRendered.rendered, true)
assert.deepEqual(fullRendered.domains, allDomains)
assert.equal(fullRendered.audit.parityDomainCount, allDomains.length)
assert.equal(fullRendered.audit.parityPassedDomainCount, allDomains.length)
assert.equal(fullRendered.audit.parityFailedDomainCount, 0)
assert.deepEqual(Object.values(fullRendered.audit.parityByDomain), allDomains.map(() => 1))
assert.deepEqual(fullRendered.legacyComponentsToSuppress, Object.keys(fullLegacyComponents).sort())

const fullApplied = applyInformationSourceRender({
  components: {
    presence: fullLegacyComponents.presence,
    runtime: fullLegacyComponents.runtime,
    capability: fullLegacyComponents.capability,
    prefetch: fullLegacyComponents.prefetch,
    scene: fullLegacyComponents.scene,
  },
  contextArgs: {
    currentTime: fullRequest.currentTime,
    existenceDesc: fullRequest.existenceDesc,
    security: fullRequest.securityProjection,
    systemEnv: fullRequest.systemEnvironmentContext,
    currentChannel: fullRequest.currentChannel,
    channelSwitched: true,
    memories: fullLegacyComponents.memories,
    activePolicies: fullLegacyComponents.activePolicies,
    knowledgeEvidence: fullLegacyComponents.knowledgeEvidence,
    task: fullRequest.taskProjection.task,
    hasActiveTask: true,
    constraints: [constraint],
    personMemory: fullRequest.identityProjection.personMemory,
    userProfile: fullRequest.identityProjection.userProfile,
    selfSnapshot: fullRequest.selfProjection.snapshot,
    selfPerception: fullRequest.selfProjection.perception,
    selfEvolution: fullRequest.selfProjection.evolution,
    extraContext: 'legacy aggregate',
  },
}, fullRendered)
assert.equal(fullApplied.legacyContextText, '')
assert.equal(fullApplied.contextArgs.currentTime, '')
assert.equal(fullApplied.contextArgs.existenceDesc, '')
assert.equal(fullApplied.contextArgs.includeSecurityStatus, false)
assert.equal(fullApplied.contextArgs.systemEnv, '')
assert.equal(fullApplied.contextArgs.currentChannel, '')
assert.equal(fullApplied.contextArgs.memories, '')
assert.equal(fullApplied.contextArgs.activePolicies, '')
assert.equal(fullApplied.contextArgs.knowledgeEvidence, '')
assert.equal(fullApplied.contextArgs.includeTaskState, false)
assert.equal(fullApplied.contextArgs.includePersonMemoryContext, false)
assert.equal(fullApplied.contextArgs.userProfile, null)
assert.equal(fullApplied.contextArgs.selfSnapshot, null)
assert.equal(fullApplied.contextArgs.selfPerception, null)
assert.equal(fullApplied.contextArgs.selfEvolution, '')
const fullContextWithoutLegacy = buildContextBlock(fullApplied.contextArgs)
for (const legacyText of [
  'legacy memories',
  'legacy active policies',
  'legacy evidence',
  'legacy task state',
  constraint.content,
  '长期合作中的产品负责人',
  '熟悉 agent 系统设计',
  'Sandbox Status',
]) {
  assert.doesNotMatch(fullContextWithoutLegacy, new RegExp(legacyText))
}
assert.match(fullApplied.informationContextText, /topic="runtime\.clock"/)
assert.match(fullApplied.informationContextText, /topic="task\.current_state"/)
assert.match(fullApplied.informationContextText, /topic="memory\.person_context"/)
assert.match(fullApplied.informationContextText, /topic="runtime\.capability_prefeed"/)

const refreshRendered = await renderInformationSourceContext({
  request: {
    memoryProjection: {
      refreshMemories: [{ id: 81, mem_id: 'M:81', content: '刷新阶段找回的记忆' }],
    },
    knowledgeProjection: { refreshResults: '刷新阶段获得的外部结果' },
    now,
  },
  domains: ['memory', 'knowledge'],
}, {
  env: {},
  registry: new InformationSourceRegistry(),
})
assert.equal(refreshRendered.rendered, true)
assert.equal(refreshRendered.audit.parityFailedDomainCount, 0)
assert.match(refreshRendered.contextText, /topic="memory\.refresh"/)
assert.match(refreshRendered.contextText, /topic="knowledge\.refresh_results"/)

const inactiveTaskRendered = await renderInformationSourceContext({
  request: { taskProjection: { task: '', steps: [] }, now },
  legacyComponents: { task: JSON.stringify({ active: false, task: '', steps: [] }) },
  domains: ['task'],
}, {
  env: {},
  registry: new InformationSourceRegistry(),
})
assert.equal(inactiveTaskRendered.audit.parityByDomain.task, 1)
assert.deepEqual(inactiveTaskRendered.legacyComponentsToSuppress, ['task'])
const inactiveTaskApplied = applyInformationSourceRender({
  contextArgs: { hasActiveTask: false, task: null },
}, inactiveTaskRendered)
assert.equal(inactiveTaskApplied.contextArgs.includeTaskState, false)
assert.doesNotMatch(buildContextBlock(inactiveTaskApplied.contextArgs), /<task active="false">/)

const mismatchRegistry = new InformationSourceRegistry()
mismatchRegistry.register({
  id: 'constraints:test-mismatch',
  kind: 'query',
  domain: 'constraints',
  topics: ['policy.behavioral_constraint'],
  legacyComponents: ['constraints'],
  rank: 99,
  collect: request => ({
    id: 'info_constraints_mismatch_0001',
    topic: 'policy.behavioral_constraint',
    subject: { constraintId: 'C:wrong' },
    authorship: 'system',
    semanticKind: 'policy',
    payload: {
      content: '不相等的约束',
      detail: '',
      dimension: 'wrong',
      tags: [],
    },
    occurredAt: request.now,
    observedAt: request.now,
    trust: 'authoritative',
  }),
})
const mismatch = await renderInformationSourceContext({
  request: { now, constraintsProjection: [constraint] },
  legacyComponents: { constraints: `- ${constraint.content}` },
  domains: ['constraints'],
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'constraints' },
  registry: mismatchRegistry,
})
assert.equal(mismatch.rendered, false)
assert.equal(mismatch.contextText, '')
assert.deepEqual(mismatch.legacyComponentsToSuppress, [])
assert.equal(mismatch.audit.parityByDomain.constraints, 0)
assert.equal(mismatch.audit.parityFailedDomainCount, 1)
assert.equal(mismatch.parity.byDomain.constraints.reason, 'semantic_mismatch')

const partialRegistry = new InformationSourceRegistry()
partialRegistry.register({
  id: 'scene:test-partial',
  kind: 'snapshot',
  domain: 'scene',
  topics: ['ui.scene_test_partial'],
  legacyComponents: ['scene'],
  maxChars: 2_000,
  rank: 100,
  collect: request => [1, 2].map(index => ({
    id: `info_scene_test_partial_${index}`,
    topic: 'ui.scene_test_partial',
    authorship: 'system',
    semanticKind: 'ui_signal',
    payload: { index, contextText: `surface-${index}-${'x'.repeat(700)}` },
    occurredAt: request.now,
    observedAt: request.now,
  })),
})
const partial = await renderInformationSourceContext({
  request: { now, sceneProjection: { manifest: [] } },
  legacyComponents: { scene: 'legacy scene manifest' },
  domains: ['scene'],
  maxContextChars: 512,
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'scene' },
  registry: partialRegistry,
})
assert.equal(partial.audit.itemCount, 2)
assert.equal(partial.rendered, false)
assert.equal(partial.contextText, '')
assert.equal(partial.audit.selectedContextCount, 0)
assert.deepEqual(partial.legacyComponentsToSuppress, [])
assert.equal(partial.audit.legacyCoverageByComponent.scene, 0)
const partialApplied = applyInformationSourceRender({
  components: { scene: 'legacy scene manifest' },
  informationContextText: '',
}, partial)
assert.equal(partialApplied.legacyContextText, 'legacy scene manifest')
assert.equal(partialApplied.informationContextText, '')

const truncatedRegistry = new InformationSourceRegistry()
truncatedRegistry.register({
  id: 'scene:test-truncated',
  kind: 'snapshot',
  domain: 'scene',
  topics: ['ui.scene_test_truncated'],
  legacyComponents: ['scene'],
  maxItems: 1,
  collect: request => [1, 2].map(index => ({
    id: `info_scene_test_truncated_${index}`,
    topic: 'ui.scene_test_truncated',
    authorship: 'system',
    semanticKind: 'ui_signal',
    payload: { index },
    occurredAt: request.now,
    observedAt: request.now,
  })),
})
const truncated = await renderInformationSourceContext({
  request: { now, sceneProjection: { manifest: [] } },
  legacyComponents: { scene: 'legacy full scene manifest' },
  domains: ['scene'],
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'scene' },
  registry: truncatedRegistry,
})
assert.equal(truncated.audit.itemCount, 1)
assert.equal(truncated.audit.truncatedSourceCount, 1)
assert.equal(truncated.audit.truncatedItemCount, 1)
assert.equal(truncated.audit.sourceTruncatedItemsById['scene:test-truncated'], 1)
assert.equal(truncated.rendered, false)
assert.deepEqual(truncated.legacyComponentsToSuppress, [])
assert.equal(truncated.contextText, '')

const failedRegistry = new InformationSourceRegistry()
failedRegistry.register({
  id: 'scene:test-failure',
  kind: 'snapshot',
  domain: 'scene',
  topics: ['ui.scene_test_failure'],
  legacyComponents: ['scene'],
  collect: () => { throw new Error('scene source unavailable') },
})
const failed = await renderInformationSourceContext({
  request: { now, sceneProjection: { manifest: [] } },
  legacyComponents: { scene: 'must remain on source failure' },
  domains: ['scene'],
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_RENDER: 'scene' },
  registry: failedRegistry,
})
assert.equal(failed.enabled, true)
assert.equal(failed.rendered, false)
assert.deepEqual(failed.legacyComponentsToSuppress, [])
assert.equal(failed.audit.failedSourceCount, 1)
assert.match(failed.audit.sourceErrorsById['scene:test-failure'], /source unavailable/)

console.log('PASS source renderer defaults to parity-gated full cutover, suppresses equivalent legacy context, and fails open')
