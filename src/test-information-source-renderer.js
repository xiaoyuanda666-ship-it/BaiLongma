import assert from 'node:assert/strict'

delete process.env.BAILONGMA_INFORMATION_SOURCE_RENDER

const { InformationSourceRegistry } = await import('./information/source-registry.js')
const { buildLLMMessages } = await import('./runtime/messages.js')
const {
  listInformationSourceRenderableDomains,
  isInformationSourceRenderEnabled,
  applyInformationSourceRender,
  renderInformationSourceContext,
} = await import('./information/source-renderer.js')

const now = new Date('2026-08-24T12:00:00.000Z')

assert.deepEqual(listInformationSourceRenderableDomains(), ['scene', 'prefetch'])
assert.equal(isInformationSourceRenderEnabled('scene', {}), false)
assert.equal(
  isInformationSourceRenderEnabled('memory', { BAILONGMA_INFORMATION_SOURCE_RENDER: 'all' }),
  false,
  'domains are not renderable until explicitly admitted to the canary allowlist',
)
assert.deepEqual(await renderInformationSourceContext({}, {
  env: {},
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
assert.deepEqual(rendered.domains, ['scene', 'prefetch'])
assert.deepEqual(rendered.legacyComponentsToSuppress, ['prefetch', 'scene'])
assert.equal(rendered.audit.sourceCount, 2)
assert.equal(rendered.audit.itemCount, 2)
assert.equal(rendered.audit.legacyCoveredComponentCount, 2)
assert.equal(rendered.audit.legacyUncoveredComponentCount, 1)
assert.equal(rendered.audit.suppressedLegacyComponentCount, 2)
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

console.log('PASS source renderer canary switches scene/prefetch without duplicate legacy context and fails open')
