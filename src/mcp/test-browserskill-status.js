import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBrowserSkillStatus, runBsk } from './browserskill-client.js'

async function withCli(source, operation) {
  const dir = await mkdtemp(join(tmpdir(), 'bailongma-bsk-status-'))
  const binary = join(dir, 'bsk')
  try {
    await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 })
    await operation(binary)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('disconnected CLI can finish its five-second wait without being killed', async () => {
  await withCli(`
    if (process.argv[2] === '--version') { console.log('bsk 0.3.1'); process.exit(0) }
    if (process.env.BSK_AUTO_START !== '0') process.exit(2)
    if (process.argv.slice(2).join(' ') !== 'status --json') process.exit(3)
    setTimeout(() => console.log(JSON.stringify({ browsers: [], daemon_version: '0.3.1' })), 5200)
  `, async binary => {
    const status = await getBrowserSkillStatus({
      run: (args, options) => runBsk(args, { ...options, options: { binary } }),
    })
    assert.equal(status.ok, true)
    assert.equal(status.ready, false)
    assert.equal(status.state, 'browser_not_connected')
    assert.deepEqual(status.browsers, [])
    assert.equal(status.daemon_version, '0.3.1')
  })
})

test('an unresponsive CLI reports an explicit timeout', async () => {
  await withCli("if (process.argv[2] === '--version') { console.log('bsk 0.3.1'); process.exit(0) }; setInterval(() => {}, 1000)", async binary => {
    const status = await getBrowserSkillStatus({
      run: (args, options) => runBsk(args, { ...options, timeout: args[0] === '--version' ? 5000 : 150, options: { binary } }),
    })
    assert.equal(status.ok, false)
    assert.equal(status.code, 'BSK_TIMEOUT')
    assert.match(status.error, /status timed out after 150 ms/)
  })
})
