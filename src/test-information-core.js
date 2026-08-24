import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-information-core-'))
process.env.BAILONGMA_USER_DIR = tempRoot
delete process.env.BAILONGMA_INFORMATION_SHADOW

let closeDBForTest = () => {}
try {
  const dbModule = await import('./db.js')
  const {
    getDB,
    upsertInformationRoute,
    listInformationDeliveries,
    leaseInformationDeliveries,
    ackInformationDeliveries,
    nackInformationDeliveries,
  } = dbModule
  closeDBForTest = dbModule.closeDBForTest
  const { createInformationItem } = await import('./information/envelope.js')
  const { createInformationRoute } = await import('./information/route-model.js')
  const {
    informationTopicMatches,
    informationFilterMatches,
    informationRouteMatches,
  } = await import('./information/subscription-matcher.js')
  const { InformationSourceRegistry } = await import('./information/source-registry.js')
  const { publishInformationEvent } = await import('./information/hub.js')
  const { loadInformationDeliveryCandidates } = await import('./information/context-candidates.js')
  const { observeInformationContextShadow } = await import('./information/context-shadow.js')
  const { pushMessage } = await import('./inbound-message.js')
  const { popMessage } = await import('./queue.js')

  const db = getDB()
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name))
  for (const table of ['information_events', 'information_routes', 'information_deliveries']) {
    assert.ok(tables.has(table), `${table} schema exists`)
  }

  const item = createInformationItem({
    id: 'info_test_envelope_0001',
    topic: 'conversation.user_message',
    source: { id: 'channel:test', kind: 'event' },
    subject: { userId: 'ID:test' },
    authorship: 'user',
    semanticKind: 'user_input',
    payload: { contentLength: 5 },
    occurredAt: '2026-08-24T00:00:00.000Z',
    observedAt: '2026-08-24T00:00:00.000Z',
  })
  assert.equal(item.authorship, 'user')
  assert.equal(item.semanticKind, 'user_input')
  assert.throws(() => createInformationItem({
    topic: 'Bad Topic',
    source: { id: 'test', kind: 'event' },
  }), /topic/)
  assert.throws(() => createInformationItem({
    topic: 'test.event',
    source: { id: 'test', kind: 'event' },
    semanticKind: 'pretend_user',
  }), /semanticKind/)

  assert.equal(informationTopicMatches('ui.intent.*', 'ui.intent.select'), true)
  assert.equal(informationTopicMatches('ui.intent.**', 'ui.intent.card.select'), true)
  assert.equal(informationTopicMatches('ui.intent.*', 'ui.intent.card.select'), false)
  assert.equal(informationFilterMatches({
    all: [
      { op: 'eq', path: 'payload.status', value: 'ready' },
      { op: 'in', path: 'subject.userId', values: ['ID:test', 'ID:other'] },
    ],
  }, {
    payload: { status: 'ready' },
    subject: { userId: 'ID:test' },
  }), true)

  const pureRoute = createInformationRoute({
    id: 'route_test_pure_match',
    subscriber: { type: 'agent', id: 'agent:test' },
    topicPattern: 'test.event.*',
    scope: { userId: 'ID:test' },
    filter: { op: 'eq', path: 'payload.status', value: 'ready' },
    activation: { type: 'event' },
    context: { semanticKind: 'runtime_event' },
  })
  assert.equal(informationRouteMatches(pureRoute, {
    topic: 'test.event.ready',
    subject: { userId: 'ID:test' },
    payload: { status: 'ready' },
  }), true)

  const registry = new InformationSourceRegistry()
  registry.register({
    id: 'runtime:test-clock',
    kind: 'snapshot',
    topics: ['runtime.test_clock'],
    collect: () => ({ now: '2026-08-24T00:00:00.000Z' }),
  })
  const collected = await registry.collect('runtime:test-clock', { now: '2026-08-24T00:00:01.000Z' })
  assert.equal(collected.length, 1)
  assert.equal(collected[0].source.kind, 'snapshot')
  assert.equal(collected[0].semanticKind, 'system_fact')
  registry.register({
    id: 'runtime:test-bad-topic',
    kind: 'query',
    topics: ['runtime.allowed'],
    collect: () => ({ topic: 'runtime.not_allowed', payload: { value: true } }),
  })
  await assert.rejects(
    registry.collect('runtime:test-bad-topic'),
    /emitted undeclared topic/,
  )

  upsertInformationRoute({
    id: 'route_test_primary_ready',
    subscriber: { type: 'agent', id: 'agent:primary-test' },
    topicPattern: 'test.event.*',
    scope: { userId: 'ID:test' },
    filter: { op: 'eq', path: 'payload.status', value: 'ready' },
    activation: { type: 'event' },
    wake: { policy: 'always', priority: 80 },
    delivery: { policy: 'immediate_turn', ack: 'after_model_accept' },
    context: { semanticKind: 'runtime_event' },
  })
  upsertInformationRoute({
    id: 'route_test_secondary_ready',
    subscriber: { type: 'agent', id: 'agent:secondary-test' },
    topicPattern: 'test.event.*',
    filter: { op: 'eq', path: 'payload.status', value: 'ready' },
    activation: { type: 'event' },
    wake: { policy: 'never', priority: 20 },
    delivery: { policy: 'next_turn', ack: 'after_model_accept' },
    context: { semanticKind: 'runtime_event' },
  })
  upsertInformationRoute({
    id: 'route_test_disabled',
    subscriber: { type: 'agent', id: 'agent:disabled-test' },
    topicPattern: 'test.event.*',
    activation: { type: 'event' },
    context: { semanticKind: 'runtime_event' },
    enabled: false,
  })

  const firstPublish = publishInformationEvent({
    id: 'info_test_publish_0001',
    topic: 'test.event.ready',
    source: { id: 'test:publisher', kind: 'event' },
    subject: { userId: 'ID:test' },
    authorship: 'system',
    semanticKind: 'runtime_event',
    payload: { status: 'ready' },
    occurredAt: '2026-08-24T01:00:00.000Z',
    observedAt: '2026-08-24T01:00:00.000Z',
    priority: 60,
    dedupeKey: 'event-ready-1',
  })
  assert.equal(firstPublish.created, true)
  assert.deepEqual(new Set(firstPublish.matchedRouteIds), new Set([
    'route_test_primary_ready',
    'route_test_secondary_ready',
  ]))
  assert.equal(firstPublish.deliveries.length, 2)

  const duplicatePublish = publishInformationEvent({
    id: 'info_test_publish_duplicate',
    topic: 'test.event.ready',
    source: { id: 'test:publisher', kind: 'event' },
    subject: { userId: 'ID:test' },
    authorship: 'system',
    semanticKind: 'runtime_event',
    payload: { status: 'ready' },
    dedupeKey: 'event-ready-1',
  })
  assert.equal(duplicatePublish.created, false)
  assert.equal(duplicatePublish.event.id, firstPublish.event.id)
  assert.equal(duplicatePublish.deliveries.length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM information_events WHERE source_id = 'test:publisher'`).get().count, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM information_deliveries`).get().count, 2)

  const leaseBaseMs = Date.now() + 1_000
  const primaryLease = leaseInformationDeliveries({
    subscriberId: 'agent:primary-test',
    now: new Date(leaseBaseMs),
  })
  assert.equal(primaryLease.deliveries.length, 1)
  assert.equal(primaryLease.deliveries[0].attempts, 1)
  assert.equal(ackInformationDeliveries({ leaseId: primaryLease.leaseId }), 1)
  assert.equal(listInformationDeliveries({ subscriberId: 'agent:primary-test' })[0].state, 'acked')

  const secondaryLease1 = leaseInformationDeliveries({
    subscriberId: 'agent:secondary-test',
    now: new Date(leaseBaseMs),
    leaseMs: 1_000,
  })
  assert.equal(secondaryLease1.deliveries.length, 1)
  assert.deepEqual(nackInformationDeliveries({
    leaseId: secondaryLease1.leaseId,
    error: 'retry test',
    retryAt: new Date(leaseBaseMs + 1_000),
    maxAttempts: 2,
  }), { pending: 1, deadLetter: 0, total: 1 })
  const secondaryLease2 = leaseInformationDeliveries({
    subscriberId: 'agent:secondary-test',
    now: new Date(leaseBaseMs + 1_000),
  })
  assert.equal(secondaryLease2.deliveries[0].attempts, 2)
  assert.deepEqual(nackInformationDeliveries({
    leaseId: secondaryLease2.leaseId,
    error: 'terminal test',
    maxAttempts: 2,
  }), { pending: 0, deadLetter: 1, total: 1 })

  const eventCountBeforeDisabledShadow = db.prepare(`SELECT COUNT(*) AS count FROM information_events`).get().count
  process.env.BAILONGMA_INFORMATION_MODE = 'legacy'
  const legacyOff = pushMessage('ID:shadow-off', 'legacy queue remains authoritative', 'TUI', {
    clientMessageId: 'shadow-off-message-0001',
  })
  assert.equal(popMessage(), legacyOff)
  assert.equal(legacyOff.informationEventId, undefined)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM information_events`).get().count, eventCountBeforeDisabledShadow)
  assert.deepEqual(observeInformationContextShadow({ triggerEventId: 'not-created' }), {
    enabled: false,
    observed: false,
  })

  process.env.BAILONGMA_INFORMATION_SHADOW = '1'
  const legacyOn = pushMessage('ID:shadow-on', 'shadow records but does not drive the turn', 'TUI', {
    clientMessageId: 'shadow-on-message-0001',
  })
  assert.equal(popMessage(), legacyOn)
  assert.ok(legacyOn.informationEventId, 'shadow event id is attached to the legacy queue entry for correlation')
  const shadowEvent = db.prepare(`
    SELECT * FROM information_events
    WHERE source_id = 'channel:tui' AND dedupe_key = 'client:shadow-on-message-0001'
  `).get()
  assert.ok(shadowEvent, 'enabled shadow mode records a typed inbound event')
  assert.equal(JSON.parse(shadowEvent.metadata_json).shadow, true)
  assert.equal(Object.hasOwn(JSON.parse(shadowEvent.payload_json), 'content'), false)
  const shadowDelivery = db.prepare(`
    SELECT * FROM information_deliveries
    WHERE event_id = ? AND route_id = 'route_system_user_message_primary'
  `).get(shadowEvent.id)
  assert.equal(shadowDelivery.state, 'pending')
  assert.equal(shadowDelivery.priority, 100)
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM conversations WHERE from_id = 'ID:shadow-on'`).get().count, 1)
  const shadowCandidates = loadInformationDeliveryCandidates({
    eventId: shadowEvent.id,
    subscriberId: 'agent:primary',
  }, { db })
  assert.equal(shadowCandidates.length, 1)
  const contextObservation = observeInformationContextShadow({
    triggerEventId: shadowEvent.id,
    legacyComponents: { runtime: 'legacy runtime context' },
    now: new Date(),
  }, { db })
  assert.equal(contextObservation.observed, true)
  assert.equal(contextObservation.frame.userInputs.current.event.id, shadowEvent.id)
  assert.equal(contextObservation.frame.contextText, '')
  assert.equal(contextObservation.audit.legacyCharsByComponent.runtime, 22)
  assert.equal(db.prepare(`SELECT state FROM information_deliveries WHERE id = ?`).get(shadowDelivery.id).state, 'pending')

  console.log('information core tests passed')
} finally {
  delete process.env.BAILONGMA_INFORMATION_SHADOW
  delete process.env.BAILONGMA_INFORMATION_MODE
  closeDBForTest()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
