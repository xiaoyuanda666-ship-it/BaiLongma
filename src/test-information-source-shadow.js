import assert from 'node:assert/strict'

delete process.env.BAILONGMA_INFORMATION_SOURCE_SHADOW

const { InformationSourceRegistry } = await import('./information/source-registry.js')
const {
  collectInformationSources,
  compileInformationSourceFrame,
} = await import('./information/source-collector.js')
const {
  isInformationSourceShadowEnabled,
  observeInformationSourceShadow,
} = await import('./information/source-shadow.js')
const { buildSystemEnvironmentContext } = await import('./context/system-environment-context.js')
const { __setInstalledSoftwareForTest } = await import('./installed-software-scanner.js')

__setInstalledSoftwareForTest([{ name: 'Source Shadow Browser', version: '1.0.0' }])
assert.equal(buildSystemEnvironmentContext('只是普通聊天'), '')
assert.match(buildSystemEnvironmentContext('我的电脑安装了什么软件？'), /Source Shadow Browser/)

const registry = new InformationSourceRegistry()
registry.register({
  id: 'runtime:test-ok',
  kind: 'snapshot',
  domain: 'runtime',
  topics: ['runtime.test_ok'],
  rank: 75,
  collect: ({ now }) => ({
    id: 'info_source_test_ok_0001',
    topic: 'runtime.test_ok',
    authorship: 'system',
    semanticKind: 'system_fact',
    payload: { value: 'stable snapshot' },
    occurredAt: now,
    observedAt: now,
    trust: 'authoritative',
  }),
})
registry.register({
  id: 'runtime:test-invalid-user',
  kind: 'query',
  domain: 'runtime',
  topics: ['runtime.invalid_user'],
  collect: ({ now }) => ({
    id: 'info_source_test_bad_user_0001',
    topic: 'runtime.invalid_user',
    authorship: 'user',
    semanticKind: 'user_input',
    payload: { content: 'must not become user speech' },
    occurredAt: now,
    observedAt: now,
  }),
})
registry.register({
  id: 'environment:test-failure',
  kind: 'snapshot',
  domain: 'environment',
  topics: ['environment.test_failure'],
  collect: () => { throw new Error('source unavailable') },
})

const now = new Date('2026-08-24T12:00:00.000Z')
const collection = await collectInformationSources({
  registry,
  request: { now },
  domains: ['runtime', 'environment'],
})
assert.equal(collection.audit.sourceCount, 3)
assert.equal(collection.audit.succeededSourceCount, 1)
assert.equal(collection.audit.failedSourceCount, 2)
assert.equal(collection.audit.itemCount, 1)
assert.equal(collection.audit.sourceItemsById['runtime:test-ok'], 1)
assert.match(collection.audit.sourceErrorsById['runtime:test-invalid-user'], /cannot emit user input/)
assert.match(collection.audit.sourceErrorsById['environment:test-failure'], /source unavailable/)

const abortRegistry = new InformationSourceRegistry()
abortRegistry.register({
  id: 'runtime:test-abort',
  kind: 'snapshot',
  domain: 'runtime',
  topics: ['runtime.test_abort'],
  timeoutMs: 5_000,
  collect: () => new Promise(() => {}),
})
const abortController = new AbortController()
abortController.abort('newer turn arrived')
const abortedCollection = await collectInformationSources({
  registry: abortRegistry,
  request: { now, signal: abortController.signal },
})
assert.equal(abortedCollection.audit.failedSourceCount, 1)
assert.match(abortedCollection.audit.sourceErrorsById['runtime:test-abort'], /newer turn arrived/)

const frame = compileInformationSourceFrame(collection, { now })
assert.equal(frame.userInputs.current, null)
assert.equal(frame.userInputs.additional.length, 0)
assert.equal(frame.contextItems.length, 1)
assert.equal(frame.contextItems[0].event.source.id, 'runtime:test-ok')
assert.match(frame.contextText, /semantic_kind="system_fact"/)
assert.match(frame.contextText, /stable snapshot/)

assert.equal(isInformationSourceShadowEnabled('runtime', {}), false)
assert.deepEqual(await observeInformationSourceShadow({}, { env: {}, registry: new InformationSourceRegistry() }), {
  enabled: false,
  observed: false,
})

const runtimeShadow = await observeInformationSourceShadow({
  request: {
    message: '普通聊天',
    currentTime: '2026-08-24T20:00:00+08:00',
    currentChannel: 'TUI',
    channelSwitched: false,
    runtimeComponents: {
      presence: '<presence>online</presence>',
      terminal: '<terminal>idle</terminal>',
    },
    now,
  },
  legacyComponents: {
    currentTime: 'Current time: 2026-08-24T20:00:00+08:00',
    presence: '<presence>online</presence>',
    terminal: '<terminal>idle</terminal>',
  },
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_SHADOW: 'runtime' },
  registry: new InformationSourceRegistry(),
})
assert.equal(runtimeShadow.enabled, true)
assert.equal(runtimeShadow.observed, true)
assert.equal(runtimeShadow.audit.sourceCount, 3)
assert.equal(runtimeShadow.audit.failedSourceCount, 0)
assert.equal(runtimeShadow.audit.itemCount, 4)
assert.equal(runtimeShadow.frame.contextItems.some(item => item.event.topic === 'runtime.clock'), true)
assert.equal(runtimeShadow.frame.contextItems.some(item => item.event.topic === 'runtime.channel'), true)
assert.equal(
  runtimeShadow.frame.contextItems.filter(item => item.event.topic === 'runtime.legacy_component').length,
  2,
)
assert.equal(Object.hasOwn(runtimeShadow.audit, 'contextText'), false, 'audit never exposes source payload bodies')

const environmentShadow = await observeInformationSourceShadow({
  request: {
    message: '我的主机环境是什么？',
    systemEnvironmentContext: '## Host Environment\nOS: test-only',
    now,
  },
  legacyComponents: { systemEnvironment: '## Host Environment\nOS: test-only' },
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_SHADOW: 'environment' },
  registry: new InformationSourceRegistry(),
})
assert.equal(environmentShadow.audit.sourceCount, 1)
assert.equal(environmentShadow.audit.itemCount, 1)
assert.equal(environmentShadow.frame.contextItems[0].event.topic, 'environment.host_context')
assert.match(environmentShadow.frame.contextText, /Host Environment/)

const cognitiveShadow = await observeInformationSourceShadow({
  request: {
    memoryProjection: {
      memories: [{ id: 11, mem_id: 'M:11', content: '用户喜欢简洁回答', detail: 'observed preference' }],
      recallMemories: [{ id: 11, mem_id: 'M:11', content: '用户喜欢简洁回答', detail: 'duplicate recall' }],
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
    now,
  },
  legacyComponents: {
    memories: 'legacy memories text',
    policies: 'legacy policy text',
    knowledge: 'legacy evidence text',
  },
  domains: ['memory', 'knowledge', 'task'],
}, {
  env: { BAILONGMA_INFORMATION_SOURCE_SHADOW: 'memory,knowledge,task' },
  registry: new InformationSourceRegistry(),
})
assert.equal(cognitiveShadow.audit.sourceCount, 4)
assert.equal(cognitiveShadow.audit.failedSourceCount, 0)
assert.equal(cognitiveShadow.audit.itemCount, 4, 'duplicate relevant/recall memory is projected once')
assert.deepEqual(
  cognitiveShadow.frame.contextItems.map(item => item.event.semanticKind),
  ['policy', 'knowledge', 'task_state', 'memory'],
)
assert.equal(cognitiveShadow.frame.contextItems[1].event.authorship, 'external')
assert.equal(cognitiveShadow.frame.contextItems[1].event.payload.citationId, 'K:3:7')
assert.ok(
  cognitiveShadow.frame.contextText.indexOf('semantic_kind="task_state"')
    < cognitiveShadow.frame.contextText.indexOf('semantic_kind="knowledge"'),
)
assert.equal(cognitiveShadow.frame.userInputs.current, null)

console.log('PASS pull Information Sources compile fail-open runtime, memory, knowledge, and task shadow frames')
