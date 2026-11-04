import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

// Exercise the real HTTP server in an isolated project; stub external probes only.
test('running console reloads package version and rejects stale release requests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-refresh-'))
  const dir = path.join(root, 'tools/release-console')
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['server.mjs', 'core.mjs']) {
    await fs.copyFile(new URL(`../${name}`, import.meta.url), path.join(dir, name))
  }
  await fs.writeFile(path.join(dir, 'japlos-console.mjs'), 'export const japlosJob=()=>null, startJaplosJob=()=>null')
  await fs.writeFile(path.join(dir, 'release-engine.mjs'), `
    export const historyDirectory=()=>${JSON.stringify(path.join(root, 'history'))};
    export const readGitState=async()=>({});
    export const getSystemStatus=async({version})=>({version});
    export const scanMacArtifacts=async({version})=>({version, records:[]});
    export const createMacReleasePlan=async(request)=>request;
    export const runMacPreflight=async({version})=>({version, stableEligible:true});
  `)
  const setVersion = version => fs.writeFile(path.join(root, 'package.json'), JSON.stringify({version, productName:'Bailongma'}))
  await setVersion('2.2.160')
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs'), '--no-open'], {stdio:['ignore','pipe','pipe']})
  t.after(async () => {
    const closed = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await closed
    await fs.rm(root, {recursive:true, force:true})
  })
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', data => {
      output += data
      const match = output.match(/listening on (http:\/\/127.0.0.1:\d+)/)
      if (match) resolve(match[1])
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`server exited ${code}`)))
  })
  const get = route => fetch(origin+route).then(r=>r.json())
  const boot = await get('/api/bootstrap')
  const post = (route, body={}) => fetch(origin+route, {method:'POST', headers:{Origin:origin,'Content-Type':'application/json','X-Release-Session-Token':boot.token},body:JSON.stringify(body)})
  assert.equal(boot.version, '2.2.160')
  assert.equal((await get('/api/status')).system.version, '2.2.160')
  const request = {version:'2.2.160', archs:['x64','arm64'], channel:'stable', stagingPercentage:100, mode:'upload', dryRun:true}
  assert.equal((await post('/api/preflight', request)).status, 200)
  await setVersion('2.2.162')
  const refreshed = await (await post('/api/refresh')).json()
  assert.equal(refreshed.system.version, '2.2.162')
  assert.equal(refreshed.artifacts.version, '2.2.162')
  assert.equal((await get('/api/bootstrap')).version, '2.2.162')
  assert.equal((await get('/api/status')).preflight, null)
  assert.equal((await post('/api/plan', request)).status, 400)
  assert.equal((await post('/api/tasks', request)).status, 400)
  const plan = await (await post('/api/plan', {...request,version:'2.2.162'})).json()
  assert.equal(plan.plan.version, '2.2.162')
})
