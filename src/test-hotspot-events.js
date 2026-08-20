import assert from 'node:assert/strict'
import {
  aggregateHotspotPlatformEvents,
  createHotspotEventService,
  normalizeNetworkHotEvents,
} from './hotspot-events.js'

const FETCHED_AT = '2026-08-20T14:02:00.000Z'

const networkEvents = normalizeNetworkHotEvents({
  code: 200,
  result: {
    list: [
      {
        title: '某科技公司发布新款 AI 芯片',
        digest: '新产品今天正式发布。',
        hotnum: 123456,
        url: 'https://example.com/ai-chip',
      },
      {
        title: '某科技公司发布新款 AI 芯片',
        digest: '重复事件不应再次出现。',
      },
      {
        title: '强台风预警升级',
        digest: '',
        hotnum: 9800,
        url: 'javascript:alert(1)',
      },
    ],
  },
}, { fetchedAt: FETCHED_AT })

assert.equal(networkEvents.length, 2, 'TianAPI events should be de-duplicated by normalized title')
assert.equal(networkEvents[0].category, '科技')
assert.equal(networkEvents[0].hotness, '12万')
assert.equal(networkEvents[0].publishedAt, null, 'fetch time must not be presented as publish time')
assert.equal(networkEvents[0].fetchedAt, FETCHED_AT)
assert.equal(networkEvents[1].category, '自然灾害')
assert.equal(networkEvents[1].sourceUrl, '', 'unsafe event URLs must be discarded')
assert.equal(networkEvents[1].hotness, '9800')
assert.equal(
  normalizeNetworkHotEvents({ code: 200, result: { list: [{ title: 'Trail running 新赛季' }] } })[0].category,
  '社会',
  'the AI classifier must not match the letters inside ordinary English words',
)

assert.throws(
  () => normalizeNetworkHotEvents({ code: 160, msg: '当前未申请该API' }),
  /TianAPI 业务错误 160/,
)

const zeroHeatEvent = normalizeNetworkHotEvents({
  code: 200,
  result: { list: [{ title: '零热度不展示', hotnum: 0 }] },
}, { fetchedAt: FETCHED_AT })[0]
assert.equal(zeroHeatEvent.hotness, '')

const fallbackEvents = aggregateHotspotPlatformEvents({
  fetchedAt: FETCHED_AT,
  platforms: {
    douyin: [
      { rank: 1, title: '共同热点', heat: '100万', url: 'https://example.com/shared' },
      { rank: 2, title: '抖音独有热点', heat: '80万' },
    ],
    weibo: [
      { rank: 3, title: '共同热点', heat: '90万' },
      { rank: 1, title: '微博独有热点', heat: '70万', url: 'javascript:alert(1)' },
    ],
    wechat: [
      { rank: 2, title: '没有热度字段的热点', heat: '' },
    ],
  },
})

assert.equal(fallbackEvents.length, 4)
assert.equal(fallbackEvents[0].title, '共同热点', 'cross-platform events should rank first')
assert.deepEqual(fallbackEvents[0].platforms, ['douyin', 'weibo'])
assert.equal(fallbackEvents[0].source, '抖音 / 微博')
assert.equal(fallbackEvents.find(event => event.title === '微博独有热点').sourceUrl, '')
assert.equal(fallbackEvents.find(event => event.title === '没有热度字段的热点').hotness, '')

let nowMs = Date.parse(FETCHED_AT)
let primaryCalls = 0
const primaryEvent = {
  id: 'primary-1',
  title: '主源事件',
  summary: '',
  category: '社会',
  fetchedAt: FETCHED_AT,
  source: '测试主源',
}
const cachedService = createHotspotEventService({
  now: () => nowMs,
  loadPrimary: async () => {
    primaryCalls += 1
    return { events: [primaryEvent], source: 'test-primary', fetchedAt: FETCHED_AT }
  },
  loadFallback: async () => { throw new Error('不应调用降级源') },
})

const first = await cachedService.getHotspotEvents()
const second = await cachedService.getHotspotEvents()
assert.equal(first.source, 'test-primary')
assert.equal(second.events[0].title, '主源事件')
assert.equal(primaryCalls, 1, 'fresh event cache should avoid duplicate upstream calls')

const fallbackService = createHotspotEventService({
  now: () => nowMs,
  loadPrimary: async () => { throw new Error('主源不可用') },
  loadFallback: async () => ({
    events: [{ ...primaryEvent, id: 'fallback-1', title: '真实降级事件' }],
    source: 'test-fallback',
    fetchedAt: FETCHED_AT,
  }),
})
const fallback = await fallbackService.getHotspotEvents()
assert.equal(fallback.source, 'test-fallback')
assert.equal(fallback.status.primary.ok, false)
assert.equal(fallback.status.fallback.ok, true)

let upstreamAvailable = true
const staleService = createHotspotEventService({
  now: () => nowMs,
  loadPrimary: async () => {
    if (!upstreamAvailable) throw new Error('主源离线')
    return { events: [primaryEvent], source: 'test-primary', fetchedAt: FETCHED_AT }
  },
  loadFallback: async () => { throw new Error('降级源离线') },
})
await staleService.getHotspotEvents()
upstreamAvailable = false
nowMs += 16 * 60 * 1000
const stale = await staleService.getHotspotEvents()
assert.equal(stale.stale, true, 'last successful real data should survive a total upstream outage')
assert.equal(stale.events[0].title, '主源事件')
assert.match(stale.error, /主源离线/)

console.log('Hotspot event tests passed')
