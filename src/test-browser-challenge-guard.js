import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-browser-challenge-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const {
    detectBrowserChallenge,
    isBrowserAccessBlockedAfterChallenge,
  } = await import('./runtime/browser-challenge-guard.js')
  const { callLLM } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const captchaResult = JSON.stringify({
    ok: true,
    content: [{
      type: 'text',
      text: '### Page\n- Page URL: https://wappass.baidu.com/static/captcha/tuxing.html\n- Page Title: 百度安全验证',
    }],
    browser_preview: {
      url: 'https://wappass.baidu.com/static/captcha/tuxing.html',
      title: '百度安全验证',
    },
  })
  assert.equal(detectBrowserChallenge('browser_navigate', captchaResult)?.reason, 'challenge_url')
  assert.equal(isBrowserAccessBlockedAfterChallenge('browser_navigate'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('browser_click'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('web_search'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('model_web_fetch'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('browser_type'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('system_browser_open'), true)
  assert.equal(isBrowserAccessBlockedAfterChallenge('browser_set_display_mode'), false)
  assert.equal(isBrowserAccessBlockedAfterChallenge('send_message'), false)
  assert.equal(
    detectBrowserChallenge('browser_snapshot', JSON.stringify({
      ok: true,
      content: [{
        type: 'text',
        text: 'Page URL: https://example.com/article\nArticle: How CAPTCHA systems work\n- /url: https://example.com/captcha/demo',
      }],
      browser_preview: { url: 'https://example.com/article', title: 'Security engineering article' },
    })),
    null,
    'an ordinary article mentioning and linking to CAPTCHA does not trigger the hard stop',
  )

  let round = 0
  const executedTools = []
  const observedTools = []
  const result = await callLLM({
    systemPrompt: 'Use the browser, but stop and report if a CAPTCHA is shown.',
    message: 'Open Baidu. If a CAPTCHA appears, stop and leave the page open.',
    tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_set_display_mode', 'web_search', 'model_web_fetch'],
    mustReply: false,
    _streamOnceForTest: async () => {
      round += 1
      if (round === 1) {
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [{
            id: 'open_baidu',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://www.baidu.com/' }),
          }],
        }
      }
      if (round === 2) {
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [{
            id: 'switch_provider',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://www.bing.com/search?q=OpenAI' }),
          }, {
            id: 'try_click',
            name: 'browser_click',
            arguments: JSON.stringify({ element: 'Continue', target: 'e99' }),
          }, {
            id: 'api_search', name: 'web_search', arguments: JSON.stringify({ query: 'OpenAI' }),
          }, {
            id: 'api_fetch', name: 'model_web_fetch', arguments: JSON.stringify({ url: 'https://example.com/article' }),
          }],
        }
      }
      return {
        content: 'CAPTCHA appeared, so browser automation stopped and the page was left open for the user.',
        reasoningContent: '',
        aborted: false,
        toolCalls: [],
      }
    },
    _executeToolForTest: async (name) => {
      executedTools.push(name)
      if (name === 'browser_navigate') return captchaResult
      return JSON.stringify({ ok: true })
    },
    onToolCall: (name, args, toolResult) => {
      observedTools.push({ name, args, result: JSON.parse(String(toolResult || '{}')) })
    },
  })

  assert.deepEqual(executedTools, ['browser_navigate'], 'no later browser action reaches the executor after CAPTCHA detection')
  assert.equal(observedTools[0]?.result?.browser_challenge?.detected, true)
  assert.equal(observedTools[1]?.result?.skipped, 'browser_challenge_stop')
  assert.equal(observedTools[2]?.result?.skipped, 'browser_challenge_stop')
  assert.equal(observedTools[3]?.result?.skipped, 'browser_challenge_stop')
  assert.equal(observedTools[4]?.result?.skipped, 'browser_challenge_stop')
  assert.match(result.content, /browser automation stopped/i)

  console.log('PASS browser challenge guard stops navigation, clicking, and provider fallback for the current turn')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
