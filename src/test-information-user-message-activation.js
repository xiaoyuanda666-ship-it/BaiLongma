import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-information-user-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
delete process.env.BAILONGMA_INFORMATION_ACTIVATION
delete process.env.BAILONGMA_INFORMATION_SHADOW
delete process.env.BAILONGMA_INFORMATION_MODE

let closeDBForTest = () => {}
try {
  const dbModule = await import('./db.js')
  const { getDB, listInformationDeliveries } = dbModule
  closeDBForTest = dbModule.closeDBForTest
  const { pushMessage, persistInboundMessage } = await import('./inbound-message.js')
  const { popMessage, getQueueSnapshot } = await import('./queue.js')
  const {
    compileInformationActivationFrame,
    ackInformationLease,
    nackInformationLease,
    publishInformationEventForMigration,
    resumePendingInformationActivations,
  } = await import('./information/activation-bridge.js')
  const { enqueueInboundMessageForMigration } = await import('./information/user-message-activation.js')
  const { buildLLMMessages } = await import('./runtime/messages.js')

  const db = getDB()
  while (popMessage()) {}

  const passive = publishInformationEventForMigration({
    id: 'info_user_hosted_ui_passive_0001',
    topic: 'ui.observation.dwell',
    source: { id: 'ui:user-activation-test', kind: 'event' },
    subject: { surface: 'chat', userId: 'ID:000001' },
    authorship: 'system',
    semanticKind: 'ui_signal',
    payload: { durationMs: 1200 },
    occurredAt: new Date(),
    priority: 30,
    sensitivity: 'private',
    trust: 'observed',
    dedupeKey: 'user-hosted-ui-passive-0001',
  }, {
    domain: 'ui',
    env: process.env,
    db,
    enqueue: () => { throw new Error('passive information must not wake') },
  })
  assert.equal(passive.handled, true)
  assert.equal(passive.activated, false)

  const activated = pushMessage('ID:000001', '请解释当前页面状态', 'TUI', {
    clientId: 'user-activation-client',
    clientMessageId: 'user-activation-message-0001',
    strictEvaluation: true,
    forbiddenTools: ['write_file'],
  })
  assert.equal(activated.informationActivation, true)
  assert.equal(activated.informationActivationDomain, 'user')
  assert.equal(activated.runtimeLane, 'l1')
  assert.equal(activated.queueName, 'user')
  assert.equal(activated.fromId, 'ID:000001')
  assert.equal(activated.content, '请解释当前页面状态')
  assert.equal(activated.clientId, 'user-activation-client')
  assert.deepEqual(activated.forbiddenTools, ['write_file'])
  assert.equal(activated.informationDeliveryIds.length, 2, 'the user turn hosts enabled passive UI context')
  assert.equal(popMessage(), activated)

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(activated.conversationId)
  assert.equal(conversation.content, activated.content)
  assert.equal(conversation.timestamp, activated.timestamp)
  const event = db.prepare('SELECT * FROM information_events WHERE id = ?').get(activated.informationEventId)
  assert.ok(event)
  assert.equal(event.topic, 'conversation.user_message')
  assert.equal(event.authorship, 'user')
  assert.equal(event.semantic_kind, 'user_input')
  assert.equal(Object.hasOwn(JSON.parse(event.payload_json), 'content'), false, 'event journal keeps the body behind payloadRef')
  assert.deepEqual(JSON.parse(event.payload_ref_json), { table: 'conversations', id: activated.conversationId })

  const frame = compileInformationActivationFrame(activated, { db })
  assert.equal(frame.userInputs.current.event.id, activated.informationEventId)
  assert.equal(frame.userInputs.current.event.payloadRef.id, activated.conversationId)
  assert.equal(frame.contextItems.length, 1)
  assert.equal(frame.contextItems[0].event.topic, 'ui.observation.dwell')
  assert.match(frame.contextText, /semantic_kind="ui_signal"/)
  assert.equal(frame.contextText.includes(activated.content), false)

  const messages = buildLLMMessages({
    systemPrompt: 'stable system prompt',
    informationContextBlock: frame.contextText,
    conversationWindow: [conversation],
    input: activated.content,
    msg: activated,
    runtimeLane: 'l1',
  })
  assert.deepEqual(messages.at(-1), { role: 'user', content: activated.content })
  assert.equal(messages.filter(message => message.role === 'user' && message.content === activated.content).length, 1)
  assert.equal(messages.some(message => message.role === 'system' && message.content.includes('<context-information>')), true)
  assert.equal(ackInformationLease(activated, { db }), 2)

  publishInformationEventForMigration({
    id: 'info_user_supersede_ui_passive_0001',
    topic: 'ui.observation.dwell',
    source: { id: 'ui:user-activation-test', kind: 'event' },
    subject: { surface: 'chat', userId: 'ID:000001' },
    authorship: 'system',
    semanticKind: 'ui_signal',
    payload: { durationMs: 2400 },
    occurredAt: new Date(),
    priority: 30,
    sensitivity: 'private',
    trust: 'observed',
    dedupeKey: 'user-supersede-ui-passive-0001',
  }, {
    domain: 'ui',
    env: process.env,
    db,
    enqueue: () => { throw new Error('passive information must not wake') },
  })
  const first = pushMessage('ID:000001', '第一条待处理消息', 'TUI', {
    clientMessageId: 'user-supersede-0001',
  })
  assert.equal(first.informationDeliveryIds.length, 2)
  const second = pushMessage('ID:000001', '第二条待处理消息', 'TUI', {
    clientMessageId: 'user-supersede-0002',
  })
  assert.equal(getQueueSnapshot().user, 1)
  assert.equal(popMessage(), second)
  assert.equal(second.informationDeliveryIds.length, 2, 'the replacement re-leases the passive companion')
  const supersededStates = listInformationDeliveries({ deliveryIds: first.informationDeliveryIds }, { db })
    .map(delivery => delivery.state).sort()
  assert.deepEqual(supersededStates, ['acked', 'leased'])
  assert.equal(
    listInformationDeliveries({ deliveryIds: second.informationDeliveryIds }, { db })
      .every(delivery => delivery.state === 'leased'),
    true,
  )

  const retryResult = nackInformationLease(second, 'simulate process restart', {
    db,
    retryAt: new Date(0),
    maxAttempts: 100,
  })
  assert.equal(retryResult.pending, 2)
  const recovered = []
  const resumed = resumePendingInformationActivations({
    env: process.env,
    db,
    enqueue: entry => recovered.push(entry),
    now: new Date(),
  })
  assert.equal(resumed.some(result => result.activated), true)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].runtimeLane, 'l1')
  assert.equal(recovered[0].content, second.content)
  assert.equal(recovered[0].timestamp, second.timestamp)
  assert.equal(ackInformationLease(recovered[0], { db }), 2)

  const staged = persistInboundMessage('ID:000001', '[resource only]', 'RESOURCE', {
    resourceState: 'pending',
  })
  assert(staged.conversationId > 0)
  assert.equal(getQueueSnapshot().user, 0, 'persist-only resources remain non-waking with user activation enabled')
  assert.equal(staged.informationActivation, undefined)
  assert.ok(staged.informationEventId, 'persist-only resources are durable wake=never information events')
  assert.equal(listInformationDeliveries({ eventId: staged.informationEventId }, { db })[0].state, 'pending')

  const localizedChannel = pushMessage('ID:000001', '中文渠道消息', '语音识别', {
    clientMessageId: 'user-localized-channel-0001',
  })
  assert.equal(localizedChannel.informationActivation, true)
  assert.equal(localizedChannel.informationDeliveryIds.length, 2, 'the next user turn leases its staged resource')
  assert.match(
    db.prepare('SELECT source_id FROM information_events WHERE id = ?').get(localizedChannel.informationEventId).source_id,
    /^channel:encoded-[a-f0-9]{12}$/,
  )
  assert.equal(popMessage(), localizedChannel)
  const localizedFrame = compileInformationActivationFrame(localizedChannel, { db })
  assert.equal(localizedFrame.userInputs.additional[0].event.topic, 'conversation.user_resource')
  assert.equal(ackInformationLease(localizedChannel, { db }), 2)

  const missingRow = pushMessage('ID:000001', 'recovery requires its conversation row', 'TUI', {
    clientMessageId: 'user-missing-conversation-0001',
  })
  assert.equal(popMessage(), missingRow)
  assert.equal(nackInformationLease(missingRow, 'simulate restart before row loss', {
    db,
    retryAt: new Date(0),
    maxAttempts: 100,
  }).pending, 1)
  db.prepare('DELETE FROM conversations WHERE id = ?').run(missingRow.conversationId)
  const missingRecoveryQueue = []
  const recoveryWarn = console.warn
  console.warn = () => {}
  try {
    resumePendingInformationActivations({
      env: process.env,
      db,
      enqueue: entry => missingRecoveryQueue.push(entry),
      now: new Date(),
    })
  } finally {
    console.warn = recoveryWarn
  }
  assert.equal(missingRecoveryQueue.length, 0)
  assert.equal(
    listInformationDeliveries({ deliveryIds: missingRow.informationDeliveryIds }, { db })[0].state,
    'dead_letter',
  )

  const systemSignal = pushMessage('SYSTEM', 'compatibility signal', 'APP_SIGNAL', {
    queue: 'background',
    persist: false,
    silent: true,
  })
  assert.equal(systemSignal.informationActivation, undefined)
  assert.equal(popMessage(), systemSignal)

  const fallbackSource = persistInboundMessage('ID:000001', 'activation enqueue fallback', 'TUI', {
    clientMessageId: 'user-activation-fallback-0001',
  })
  // persistInboundMessage is intentionally persist-only; remove its optional
  // shadow correlation before exercising the queued migration boundary.
  delete fallbackSource.informationEventId
  let enqueueCalls = 0
  const legacyFallback = []
  const originalWarn = console.warn
  let fallback
  console.warn = () => {}
  try {
    fallback = enqueueInboundMessageForMigration(fallbackSource, {
      env: process.env,
      db,
      enqueue: entry => {
        enqueueCalls += 1
        if (entry.informationActivation) throw new Error('simulated activation queue failure')
        legacyFallback.push(entry)
        return entry
      },
    })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(enqueueCalls, 2)
  assert.equal(fallback, fallbackSource)
  assert.equal(legacyFallback[0], fallbackSource)
  assert.equal(fallback.informationActivation, undefined)
  const failedDelivery = db.prepare(`
    SELECT d.state
    FROM information_deliveries d
    JOIN information_events e ON e.id = d.event_id
    WHERE e.dedupe_key = 'activation:user:client:user-activation-fallback-0001'
  `).get()
  assert.equal(failedDelivery.state, 'dead_letter')

  console.log('PASS user messages use information delivery by default without changing L1 semantics')
} finally {
  delete process.env.BAILONGMA_INFORMATION_ACTIVATION
  delete process.env.BAILONGMA_INFORMATION_SHADOW
  delete process.env.BAILONGMA_INFORMATION_MODE
  closeDBForTest?.()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
