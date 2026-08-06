import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-information-subscriptions-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_RESOURCES_DIR = path.resolve('.')

let closeDBForTest = () => {}
try {
  const db = await import('./db.js')
  closeDBForTest = db.closeDBForTest
  const { __setInstalledSoftwareForTest } = await import('./installed-software-scanner.js')
  const { __setDeviceInformationForTest } = await import('./device-information-scanner.js')
  const {
    commitScheduledInformationDeliveries,
    planInformationInjection,
    resolveInformationSubscriptions,
  } = await import('./injectors/information-subscription-engine.js')
  const { execManageInformationSubscription } = await import('./capabilities/tools/information-subscriptions.js')
  const { runContextRuleEngine } = await import('./context/rule-engine.js')

  __setInstalledSoftwareForTest([
    { name: 'Visual Studio Code' },
    { name: 'Clash Verge Rev', version: '2.0.0' },
  ])
  __setDeviceInformationForTest({
    platform: 'darwin',
    host: { name: 'Test Mac', battery_percent: 76, charging: false, power_source: 'battery' },
    devices: [
      { name: 'Test Mouse', kind: 'mouse', transport: 'bluetooth', connected: true, battery_percent: 18 },
      { name: 'Test Keyboard', kind: 'keyboard', transport: 'usb', connected: true, battery_percent: null },
    ],
  })

  const ordinaryPlan = planInformationInjection({ message: '你好', userId: 'ID:000001' })
  assert.deepEqual(ordinaryPlan.map(item => item.providerId), ['system_time'])

  const onDemand = await resolveInformationSubscriptions({
    message: '我的电脑安装了哪些软件？',
    userId: 'ID:000001',
  })
  assert.deepEqual(onDemand.providerIds, ['system_time', 'installed_software'])
  assert.match(onDemand.contextText, /Current System Time/)
  assert.match(onDemand.contextText, /Visual Studio Code/)
  const dedupedLegacyContext = await runContextRuleEngine('我的电脑安装了哪些软件？', {
    excludedProviders: onDemand.providerIds,
  })
  assert.doesNotMatch(dedupedLegacyContext, /Installed Software Snapshot/)

  const deviceOnDemand = await resolveInformationSubscriptions({
    message: '我希望你关注我的鼠标键盘的电量信息，电量比较低的时候你提醒我充电',
    userId: 'ID:000001',
  })
  assert.ok(deviceOnDemand.providerIds.includes('device_peripherals'))
  assert.match(deviceOnDemand.contextText, /Test Mouse/)

  const subscribeResult = JSON.parse(execManageInformationSubscription({
    action: 'subscribe',
    provider_id: 'installed_software',
    subscriber: 'agent',
    mode: 'scheduled',
    interval_minutes: 60,
    reason: 'Periodically refresh local app awareness',
  }, {
    autonomous: true,
  }))
  assert.equal(subscribeResult.ok, true)
  assert.equal(subscribeResult.subscription.subscriber, 'agent')

  const firstDueAt = Date.now() + 61 * 60_000
  const firstScheduled = await resolveInformationSubscriptions({
    message: 'ordinary autonomous thought',
    userId: 'ID:000001',
    nowMs: firstDueAt,
  })
  assert.ok(firstScheduled.providerIds.includes('installed_software'))
  assert.equal(firstScheduled.scheduledSubscriptionIds.length, 1)
  assert.equal(commitScheduledInformationDeliveries(
    firstScheduled.scheduledSubscriptionIds,
    new Date(firstDueAt).toISOString(),
  ), 1)

  const notDue = await resolveInformationSubscriptions({
    message: 'ordinary autonomous thought',
    userId: 'ID:000001',
    nowMs: firstDueAt + 30 * 60_000,
  })
  assert.deepEqual(notDue.providerIds, ['system_time'])

  const dueAgain = await resolveInformationSubscriptions({
    message: 'ordinary autonomous thought',
    userId: 'ID:000001',
    nowMs: firstDueAt + 61 * 60_000,
  })
  assert.ok(dueAgain.providerIds.includes('installed_software'))

  const deviceSubscribeResult = JSON.parse(execManageInformationSubscription({
    action: 'subscribe',
    provider_id: 'device_peripherals',
    subscriber: 'agent',
    mode: 'scheduled',
    interval_minutes: 15,
    reason: 'User requested peripheral battery monitoring',
    instruction: '关注鼠标和键盘电量；电量比较低且值得打扰时提醒用户充电，是否提醒由 Agent 根据实际状态判断。',
  }, {
    autonomous: false,
    currentTargetId: 'ID:000001',
  }))
  assert.equal(deviceSubscribeResult.ok, true)
  assert.equal(deviceSubscribeResult.subscription.instruction.includes('提醒用户充电'), true)
  const deviceNotDueImmediately = await resolveInformationSubscriptions({
    message: 'TICK',
    userId: 'ID:000001',
    nowMs: Date.now() + 60_000,
  })
  assert.equal(deviceNotDueImmediately.providerIds.includes('device_peripherals'), false)
  const deviceScheduled = await resolveInformationSubscriptions({
    message: 'TICK',
    userId: 'ID:000001',
    nowMs: firstDueAt + 62 * 60_000,
  })
  assert.ok(deviceScheduled.providerIds.includes('device_peripherals'))
  assert.match(deviceScheduled.contextText, /<subscription-intents>/)
  assert.match(deviceScheduled.contextText, /电量比较低且值得打扰时提醒用户充电/)

  const forbiddenUserMutation = JSON.parse(execManageInformationSubscription({
    action: 'subscribe',
    provider_id: 'installed_software',
    subscriber: 'user',
    mode: 'default',
  }, {
    autonomous: true,
  }))
  assert.equal(forbiddenUserMutation.ok, false)
  assert.match(forbiddenUserMutation.error, /Agent's own subscriptions/)

  const catalog = JSON.parse(execManageInformationSubscription({ action: 'providers' }, {}))
  assert.ok(catalog.providers.some(provider => provider.id === 'system_time'))
  assert.ok(catalog.providers.some(provider => provider.id === 'installed_software'))
  assert.ok(catalog.providers.some(provider => provider.id === 'device_peripherals'))

  console.log('information subscription tests passed')
} finally {
  closeDBForTest()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
