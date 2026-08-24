import assert from 'node:assert/strict'

delete process.env.BAILONGMA_INFORMATION_SOURCE_RENDER

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

assert.deepEqual(listInformationSourceRenderableDomains(), ['scene', 'prefetch', 'constraints'])
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

console.log('PASS source renderer parity-gates scene/prefetch/constraints without duplicate legacy context and fails open')
