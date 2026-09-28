import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserSkillSession, stopBrowserSkillForContext } from './browserskill-client.js'
import { executeBrowserSkillTool } from './browserskill-tools.js'

async function fixture(added, tool = 'browser_click', key = 'Enter', failList = false, failWait = false, failBefore = false) {
  let acted = false
  const calls = []
  const original = { tab_id: 1, scope: 'agent', active: true, url: 'https://www.bing.com/search?q=test' }
  const session = new BrowserSkillSession({ options: { browser: 'chosen' }, run: async (args, options) => {
    calls.push(args)
    if (args[0] === 'session' && args[1] === 'request') return {state:args.includes('--prepare') ? 'prepared' : args.includes('--cancel') ? 'closed' : 'active', session:{session_id:'popup-test'}}
    if (args[0] === '--version') return {version:'0.3.1'}
    if (args[0] === 'status') return { daemon_version:'0.3.1', protocol_version:'1.3', browsers:[{instance_id:'chosen', browser_name:'chrome', extension_version:'0.3.1', extension_protocol_version:'1.3'}] }
    assert.equal(options.options.browser, 'chosen')
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 'popup-test' }
    if (args[0] === 'session' && args[1] === 'stop') return { stopped: ['popup-test'] }
    if (args[0] === 'tab') {
      assert.deepEqual(args.slice(0, 4), ['tab', 'list', '--scope', 'agent'])
      if (!acted && failBefore) throw new Error('initial tab inspection failed')
      if (acted && failList) throw new Error('lost connection')
      return { tabs: [original, ...(acted ? added : [])] }
    }
    if (args[0] === 'click' || args[0] === 'press') { acted = true; return { tab_id: 1, used_ref: 'e31' } }
    if (args[0] === 'wait-for-navigation') {
      assert.equal(args.at(-1), '2')
      assert.equal(options.timeout, 15000)
      if (failWait) throw new Error('navigation wait timed out')
      return { reached: 'domcontentloaded' }
    }
    if (args[0] === 'observe') return { tab_id: Number(args.at(-1)), text: 'fresh destination' }
    throw new Error(`unexpected command ${args}`)
  } })
  session.tabId = 1
  const context = { browserLeaseState: {} }
  try {
    const result = JSON.parse(await executeBrowserSkillTool(tool, { ref: '@e31', key }, context, { sessionFactory: () => session }))
    return { result, calls, needsObservation: session.needsObservation }
  } finally { await stopBrowserSkillForContext(context) }
}
const destination = { tab_id: 2, scope: 'agent', active: true, url: 'https://www.iana.org/domains/reserved' }

test('old-tab click result follows the unique new owned active tab and exposes its URL', async () => {
  const { result, calls } = await fixture([destination])
  assert.equal(result.ok, true)
  assert.equal(result.structured_content.tab_id, 1)
  assert.equal(result.tab_id, 2)
  assert.equal(result.tab_transition.url, destination.url)
  assert.equal(calls.find(args => args[0] === 'observe').at(-1), '2')
  assert.equal(calls.filter(args => args[0] === 'click').length, 1)
})

test('Enter submission follows a popup, other keys do not inspect or follow popup tabs', async () => {
  const enter = await fixture([destination], 'browser_press_key')
  assert.equal(enter.result.tab_id, 2)
  assert.equal(enter.calls.filter(args => args[0] === 'press').length, 1)
  const tab = await fixture([destination], 'browser_press_key', 'Tab')
  assert.equal(tab.result.tab_id, 1)
  assert.equal(tab.calls.filter(args => args[0] === 'tab').length, 1)
})

test('no new owned tab keeps the current tab and ignores user tabs', async () => {
  for (const added of [[], [{ ...destination, scope: 'user' }]]) {
    const { result, calls } = await fixture(added)
    assert.equal(result.ok, true)
    assert.equal(result.tab_id, 1)
    assert.equal(result.tab_transition, undefined)
    assert.equal(calls.some(args => args[0] === 'wait-for-navigation'), false)
    assert.equal(calls.find(args => args[0] === 'observe').at(-1), '1')
  }
})

test('multiple new tabs or an inactive destination report ambiguity without replaying', async () => {
  for (const added of [[destination, { ...destination, tab_id: 3, active: false }], [{ ...destination, active: false }]]) {
    const { result, calls } = await fixture(added)
    assert.equal(result.code, 'BSK_TAB_AMBIGUOUS')
    assert.equal(result.action_completed, true)
    assert.equal(calls.filter(args => args[0] === 'click').length, 1)
    assert.equal(calls.some(args => args[0] === 'observe'), false)
  }
})

test('failed post-click tab inspection reports committed action without replaying', async () => {
  const { result, calls, needsObservation } = await fixture([], 'browser_click', 'Enter', true)
  assert.equal(needsObservation, true)
  assert.equal(result.code, 'BSK_OBSERVATION_FAILED')
  assert.equal(result.stage, 'tab_discovery')
  assert.equal(result.action_completed, true)
  assert.equal(calls.filter(args => args[0] === 'click').length, 1)
})

test('popup lifecycle timeout preserves destination and committed click for snapshot recovery', async () => {
  const { result, calls } = await fixture([destination], 'browser_click', 'Enter', false, true)
  assert.equal(result.code, 'BSK_OBSERVATION_FAILED')
  assert.equal(result.action_completed, true)
  assert.equal(result.tab_id, 2)
  assert.equal(result.tab_transition.tab_id, 2)
  assert.equal(calls.filter(args => args[0] === 'click').length, 1)
  assert.equal(calls.filter(args => args[0] === 'wait-for-navigation').length, 1)
  assert.equal(calls.some(args => args[0] === 'observe'), false)
})

test('failed pre-action tab inspection does not dispatch or claim a completed action', async () => {
  const { result, calls } = await fixture([], 'browser_click', 'Enter', false, false, true)
  assert.equal(result.ok, false)
  assert.equal(result.action_completed, undefined)
  assert.equal(calls.some(args => args[0] === 'click'), false)
})
