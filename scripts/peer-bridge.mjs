#!/usr/bin/env node

const DEFAULT_LOCAL = 'http://127.0.0.1:3721'
const DEFAULT_TURNS = 6
const BRIDGE_CHANNEL = 'PEER_BRIDGE'

function parseArgs(argv) {
  const args = {
    local: DEFAULT_LOCAL,
    peer: '',
    turns: DEFAULT_TURNS,
    timeoutMs: 180000,
    start: '',
    localName: '本机Jarvis',
    peerName: '远端Jarvis',
    token: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i] || ''
    if (arg === '--local') args.local = next()
    else if (arg === '--peer') args.peer = next()
    else if (arg === '--turns') args.turns = Math.max(1, Number.parseInt(next(), 10) || DEFAULT_TURNS)
    else if (arg === '--timeout-ms') args.timeoutMs = Math.max(10000, Number.parseInt(next(), 10) || args.timeoutMs)
    else if (arg === '--start') args.start = next()
    else if (arg === '--local-name') args.localName = next()
    else if (arg === '--peer-name') args.peerName = next()
    else if (arg === '--token') args.token = next()
    else if (!args.peer) args.peer = arg
  }

  args.local = normalizeBase(args.local)
  args.peer = normalizeBase(args.peer)
  return args
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readStatus(base, token) {
  const res = await fetchWithTimeout(`${base}/status`, { headers: authHeaders(token) }, 5000)
  const text = await res.text()
  if (!res.ok) throw new Error(`${base}/status -> HTTP ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return { ok: true, raw: text } }
}

async function postMessage(base, content, fromId, token) {
  const res = await fetchWithTimeout(`${base}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      from_id: fromId,
      channel: BRIDGE_CHANNEL,
      content,
    }),
  }, 10000)
  const text = await res.text()
  if (!res.ok) throw new Error(`${base}/message -> HTTP ${res.status}: ${text}`)
  try { return JSON.parse(text) } catch { return { ok: true, raw: text } }
}

function createEventClient(base, label, token) {
  const controller = new AbortController()
  const queue = []
  const waiters = []

  function pushMessage(message) {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(message)
    else queue.push(message)
  }

  const ready = (async () => {
    const res = await fetch(`${base}/events`, {
      headers: authHeaders(token),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${label} events HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    async function pump() {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split(/\n\n/)
        buffer = frames.pop() || ''
        for (const frame of frames) {
          const dataLine = frame.split(/\r?\n/).find(line => line.startsWith('data: '))
          if (!dataLine) continue
          try {
            const event = JSON.parse(dataLine.slice('data: '.length))
            if (event.type === 'message' && event.data?.content) pushMessage(event)
          } catch {}
        }
      }
    }

    pump().catch(err => {
      if (err?.name !== 'AbortError') {
        while (waiters.length) waiters.shift().reject(err)
      }
    })
  })()

  return {
    ready,
    waitMessage(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(waiter => waiter.resolve === resolve)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`${label} reply timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        waiters.push({
          resolve(value) {
            clearTimeout(timer)
            resolve(value)
          },
          reject(error) {
            clearTimeout(timer)
            reject(error)
          },
        })
      })
    },
    close() {
      controller.abort()
    },
  }
}

function buildIntro(args) {
  return args.start || [
    '你正在通过局域网和另一只Jarvis进行一次受控对话。',
    `对方地址是 ${args.peer}。`,
    '请用一小段话向对方打招呼，介绍你是谁，并问一个适合两只Jarvis互相认识的问题。',
    '每次回复保持简短，不要调用工具，不要给用户发送额外消息。',
  ].join('\n')
}

function formatPeerMessage(fromName, text) {
  return [
    `[来自 ${fromName} 的Jarvis消息]`,
    text,
    '',
    '请只回复对方，不要向用户解释桥接过程。回复保持简短。',
  ].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.peer) {
    console.error('Usage: node scripts/peer-bridge.mjs --peer http://192.168.1.7:3721 [--local http://192.168.1.4:3721] [--turns 6]')
    process.exit(2)
  }

  console.log(`[peer-bridge] local=${args.local}`)
  console.log(`[peer-bridge] peer=${args.peer}`)
  await Promise.all([
    readStatus(args.local, args.token).then(s => console.log(`[peer-bridge] local status ok: memories=${s.memory_count ?? 'unknown'}`)),
    readStatus(args.peer, args.token).then(s => console.log(`[peer-bridge] peer status ok: memories=${s.memory_count ?? 'unknown'}`)),
  ])

  const localEvents = createEventClient(args.local, 'local', args.token)
  const peerEvents = createEventClient(args.peer, 'peer', args.token)
  await Promise.all([localEvents.ready, peerEvents.ready])

  let nextSide = 'local'
  let content = buildIntro(args)

  try {
    for (let turn = 1; turn <= args.turns; turn += 1) {
      if (nextSide === 'local') {
        console.log(`[peer-bridge] -> local turn ${turn}`)
        await postMessage(args.local, content, 'peer:bridge', args.token)
        const event = await localEvents.waitMessage(args.timeoutMs)
        const reply = event.data.content
        console.log(`[${args.localName}] ${reply}`)
        content = formatPeerMessage(args.localName, reply)
        nextSide = 'peer'
      } else {
        console.log(`[peer-bridge] -> peer turn ${turn}`)
        await postMessage(args.peer, content, 'peer:bridge', args.token)
        const event = await peerEvents.waitMessage(args.timeoutMs)
        const reply = event.data.content
        console.log(`[${args.peerName}] ${reply}`)
        content = formatPeerMessage(args.peerName, reply)
        nextSide = 'local'
      }
    }
    console.log('[peer-bridge] done')
  } finally {
    localEvents.close()
    peerEvents.close()
  }
}

main().catch(err => {
  console.error(`[peer-bridge] ${err.message}`)
  process.exit(1)
})
