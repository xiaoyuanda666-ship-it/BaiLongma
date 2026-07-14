import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { execManageToolFactory } from './capabilities/tool-factory.js'
import { executeInstalledTool, getInstalledToolSchema, uninstallTool } from './capabilities/marketplace/index.js'

const checks = []
const cleanupProposalIds = new Set()
const cleanupToolNames = new Set()

function assert(condition, label, detail = '') {
  checks.push({ ok: !!condition, label, detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}${condition ? '' : (detail ? `\n  ${detail}` : '')}`)
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

async function proposeTool(args) {
  const proposed = parseJson(await execManageToolFactory({ action: 'propose', ...args }))
  if (proposed?.proposal_id) cleanupProposalIds.add(proposed.proposal_id)
  return proposed
}

async function deleteProposal(id) {
  if (!id) return
  await execManageToolFactory({ action: 'delete', proposal_id: id })
  cleanupProposalIds.delete(id)
}

function runIsolatedNode(script, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script,
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
}

function parseMarker(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find(l => l.startsWith('@@RESULT@@'))
  if (!line) return null
  return parseJson(line.slice('@@RESULT@@'.length))
}

const suffix = Date.now().toString(36)
const goodName = `factory_echo_${suffix}`
const badName = `factory_bad_${suffix}`
const execPermissionName = `factory_exec_perm_${suffix}`
const fetchName = `factory_fetch_${suffix}`
const networkName = `factory_network_${suffix}`
const networkCallName = `factory_netcall_${suffix}`
const noTestsName = `factory_notests_${suffix}`
const persistName = `factory_persist_${suffix}`
const legacyName = `factory_legacy_${suffix}`
const directExecName = `factory_direct_exec_${suffix}`
const directNetworkName = `factory_direct_net_${suffix}`
const directRejectName = `factory_direct_reject_${suffix}`

// Rejected proposal: dangerous global access.
{
  const proposed = await proposeTool({
    name: badName,
    description: 'Bad test tool that should fail review.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    code: 'return String(process.cwd())',
    tests: [{ name: 'runs', args: {}, expect_contains: '' }],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'bad proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === false && reviewed.status === 'rejected', 'review rejects dangerous proposal', JSON.stringify(reviewed))
  assert((reviewed?.issues || []).some(i => /global runtime access|process/.test(i)), 'review explains dangerous global access', JSON.stringify(reviewed?.issues))

  const installAttempt = parseJson(await execManageToolFactory({
    action: 'install',
    proposal_id: proposed.proposal_id,
  }))
  assert(installAttempt?.ok === false, 'rejected proposal cannot be installed', JSON.stringify(installAttempt))

  await deleteProposal(proposed.proposal_id)
}

// Managed v1 rejects exec permission even when code itself is harmless.
{
  const proposed = await proposeTool({
    name: execPermissionName,
    description: 'Requests exec permission and should be rejected by the managed gate.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permissions: { exec: true },
    code: 'return "ok"',
    tests: [{ name: 'runs', args: {}, expect: 'ok' }],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'exec permission proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === false && reviewed.status === 'rejected', 'managed review rejects requested exec permission', JSON.stringify(reviewed))
  assert((reviewed?.issues || []).some(i => /may not request exec permission/.test(i)), 'review explains managed exec permission rejection', JSON.stringify(reviewed?.issues))

  await deleteProposal(proposed.proposal_id)
}

// helpers.fetch requires explicit network permission.
{
  const proposed = await proposeTool({
    name: fetchName,
    description: 'Attempts network access without declaring network permission.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    code: 'return await helpers.fetch("https://example.com")',
    tests: [{ name: 'runs', args: {}, expect_contains: 'Example' }],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'fetch proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === false && reviewed.status === 'rejected', 'review rejects helpers.fetch without network permission', JSON.stringify(reviewed))
  assert((reviewed?.issues || []).some(i => /network access requires permissions\.network=true/.test(i)), 'review explains missing network permission', JSON.stringify(reviewed?.issues))

  await deleteProposal(proposed.proposal_id)
}

// Declared network permission is visible as a warning, while tests remain deterministic.
{
  const proposed = await proposeTool({
    name: networkName,
    description: 'Declares network permission but does not use it in deterministic tests.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permissions: { network: true },
    code: 'return "network declared"',
    tests: [{ name: 'runs', args: {}, expect: 'network declared' }],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'network permission proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === true && reviewed.status === 'approved', 'network permission proposal can pass deterministic review', JSON.stringify(reviewed))
  assert((reviewed?.warnings || []).some(i => /network permission requested/.test(i)), 'review warns that network tests are disabled', JSON.stringify(reviewed?.warnings))

  await deleteProposal(proposed.proposal_id)
}

// Even with network permission, proposal tests cannot make real network calls.
{
  const proposed = await proposeTool({
    name: networkCallName,
    description: 'Uses network during proposal tests and should fail deterministically.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permissions: { network: true },
    code: 'await helpers.fetch("https://example.com"); return "ok"',
    tests: [{ name: 'runs', args: {}, expect: 'ok' }],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'network call proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === false && reviewed.status === 'rejected', 'review rejects real network use during proposal tests', JSON.stringify(reviewed))
  assert((reviewed?.test_results || []).some(t => /network disabled during tool proposal tests/.test(t.error || '')), 'review records disabled-network test failure', JSON.stringify(reviewed?.test_results))

  await deleteProposal(proposed.proposal_id)
}

// Tests are mandatory for managed proposals.
{
  const proposed = await proposeTool({
    name: noTestsName,
    description: 'No tests should fail review.',
    parameters_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    code: 'return "ok"',
    tests: [],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'no-tests proposal can be stored as draft', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === false && reviewed.status === 'rejected', 'review rejects proposal without tests', JSON.stringify(reviewed))
  assert((reviewed?.issues || []).some(i => /at least one test is required/.test(i)), 'review explains missing tests', JSON.stringify(reviewed?.issues))

  await deleteProposal(proposed.proposal_id)
}

// Approved proposal: review -> install -> callable.
{
  const proposed = await proposeTool({
    name: goodName,
    description: 'Return the input text in uppercase for factory smoke tests.',
    parameters_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to uppercase.' },
      },
      required: ['text'],
    },
    permissions: { network: false, exec: false },
    code: 'const text = String(args.text || ""); return text.toUpperCase();',
    tests: [
      { name: 'uppercase ascii', args: { text: 'hello' }, expect: 'HELLO' },
      { name: 'empty string', args: { text: '' }, expect: '' },
    ],
  })
  assert(proposed?.ok === true && proposed.proposal_id, 'good proposal stored as draft', JSON.stringify(proposed))

  const earlyInstall = parseJson(await execManageToolFactory({
    action: 'install',
    proposal_id: proposed.proposal_id,
  }))
  assert(earlyInstall?.ok === false, 'draft proposal cannot skip review', JSON.stringify(earlyInstall))

  const reviewed = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: proposed.proposal_id,
  }))
  assert(reviewed?.ok === true && reviewed.status === 'approved', 'good proposal approved by review gate', JSON.stringify(reviewed))
  assert((reviewed?.test_results || []).length === 2 && reviewed.test_results.every(t => t.ok), 'all proposal tests pass', JSON.stringify(reviewed?.test_results))

  const installed = parseJson(await execManageToolFactory({
    action: 'install',
    proposal_id: proposed.proposal_id,
  }))
  if (installed?.ok === true) cleanupToolNames.add(goodName)
  assert(installed?.ok === true && installed.tool === goodName, 'approved proposal installs tool', JSON.stringify(installed))

  const schema = getInstalledToolSchema(goodName)
  assert(schema?.function?.name === goodName, 'installed tool exposes function-call schema', JSON.stringify(schema))

  const result = await executeInstalledTool(goodName, { text: 'jarvis' })
  assert(result === 'JARVIS', 'installed generated tool executes through marketplace registry', result)

  uninstallTool({ name: goodName })
  cleanupToolNames.delete(goodName)
  await deleteProposal(proposed.proposal_id)
}

// Direct install keeps permission semantics distinct from the managed gate.
{
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), `blm-tool-direct-perms-${suffix}-`))
  try {
    const directRun = runIsolatedNode(`
      import {
        executeInstalledTool,
        installTool,
        isInstalledTool,
        uninstallTool,
      } from './src/capabilities/marketplace/index.js'

      const baseSchema = { type: 'object', properties: {}, required: [] }
      const execName = ${JSON.stringify(directExecName)}
      const networkName = ${JSON.stringify(directNetworkName)}
      const rejectName = ${JSON.stringify(directRejectName)}
      const results = {}

      async function expectReject(label, fn, expected) {
        try {
          await fn()
          results[label] = { ok: false, message: 'unexpected success' }
        } catch (err) {
          results[label] = { ok: expected.test(err.message), message: err.message }
        }
      }

      try {
        await expectReject('default_exec_rejects', () => installTool({
          name: rejectName + '_exec',
          description: 'Direct install should reject helpers.exec by default.',
          parameters: baseSchema,
          code: 'return await helpers.exec("Write-Output no")',
        }), /helpers\\.exec requires permissions\\.exec=true/)

        await expectReject('default_network_rejects', () => installTool({
          name: rejectName + '_net',
          description: 'Direct install should reject helpers.fetch by default.',
          parameters: baseSchema,
          code: 'return await helpers.fetch("data:text/plain,no")',
        }), /network access requires permissions\\.network=true/)

        await expectReject('globals_still_reject', () => installTool({
          name: rejectName + '_global',
          description: 'Direct install still rejects global runtime access.',
          parameters: baseSchema,
          permissions: { exec: true, network: true },
          code: 'return process.cwd()',
        }), /global runtime access/)

        await installTool({
          name: execName,
          description: 'Direct install exec permission smoke test.',
          parameters: baseSchema,
          permissions: { exec: true },
          code: 'return await helpers.exec("Write-Output direct-exec-ok")',
        })
        const execResult = await executeInstalledTool(execName, {})
        results.explicit_exec_allows = {
          ok: /direct-exec-ok/.test(execResult),
          result: execResult,
        }

        await installTool({
          name: networkName,
          description: 'Direct install network permission smoke test.',
          parameters: baseSchema,
          permissions: { network: true },
          code: 'const res = await helpers.fetch("data:text/plain,direct-network-ok"); return await res.text();',
        })
        const networkResult = await executeInstalledTool(networkName, {})
        results.explicit_network_allows = {
          ok: networkResult === 'direct-network-ok',
          result: networkResult,
        }
      } finally {
        if (isInstalledTool(execName)) uninstallTool({ name: execName })
        if (isInstalledTool(networkName)) uninstallTool({ name: networkName })
      }

      results.cleanup = {
        ok: !isInstalledTool(execName) && !isInstalledTool(networkName),
      }
      console.log('@@RESULT@@' + JSON.stringify(results))
    `, {
      JARVIS_USER_DIR: tempUserDir,
      JARVIS_RESOURCES_DIR: process.cwd(),
    })
    assert(directRun.status === 0, 'isolated direct permission process exits cleanly', directRun.stderr || directRun.stdout)

    const direct = parseMarker(directRun.stdout)
    assert(direct?.default_exec_rejects?.ok === true, 'direct install defaults to no exec permission', JSON.stringify(direct?.default_exec_rejects))
    assert(direct?.default_network_rejects?.ok === true, 'direct install defaults to no network permission', JSON.stringify(direct?.default_network_rejects))
    assert(direct?.globals_still_reject?.ok === true, 'direct install still rejects global runtime access', JSON.stringify(direct?.globals_still_reject))
    assert(direct?.explicit_exec_allows?.ok === true, 'direct install allows helpers.exec when exec permission is explicit', JSON.stringify(direct?.explicit_exec_allows))
    assert(direct?.explicit_network_allows?.ok === true, 'direct install allows helpers.fetch when network permission is explicit', JSON.stringify(direct?.explicit_network_allows))
    assert(direct?.cleanup?.ok === true, 'direct permission test cleans up installed tools', JSON.stringify(direct?.cleanup))
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true })
  }
}

// Installed managed tools persist on disk and reload into a fresh registry.
{
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), `blm-tool-factory-${suffix}-`))
  try {
    const installRun = runIsolatedNode(`
      import { execManageToolFactory } from './src/capabilities/tool-factory.js'
      const parse = (value) => JSON.parse(String(value || ''))
      const name = ${JSON.stringify(persistName)}
      const proposed = parse(await execManageToolFactory({
        action: 'propose',
        name,
        description: 'Persisted generated tool for reload tests.',
        parameters_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        permissions: { network: false, exec: false },
        code: 'return "persist-" + String(args.value || "")',
        tests: [{ name: 'runs', args: { value: 'ok' }, expect: 'persist-ok' }],
      }))
      const reviewed = parse(await execManageToolFactory({ action: 'review', proposal_id: proposed.proposal_id }))
      const installed = parse(await execManageToolFactory({ action: 'install', proposal_id: proposed.proposal_id }))
      console.log('@@RESULT@@' + JSON.stringify({ proposed, reviewed, installed }))
    `, {
      JARVIS_USER_DIR: tempUserDir,
      JARVIS_RESOURCES_DIR: process.cwd(),
    })
    assert(installRun.status === 0, 'isolated managed install process exits cleanly', installRun.stderr || installRun.stdout)

    const installed = parseMarker(installRun.stdout)
    assert(installed?.reviewed?.ok === true && installed?.installed?.ok === true, 'isolated managed install succeeds', JSON.stringify(installed))

    const reloadRun = runIsolatedNode(`
      import fs from 'fs'
      import path from 'path'
      import { paths } from './src/paths.js'
      import { executeInstalledTool, getInstalledToolSchema, loadInstalledTools } from './src/capabilities/marketplace/index.js'
      const name = ${JSON.stringify(persistName)}
      await loadInstalledTools()
      const schema = getInstalledToolSchema(name)
      const result = await executeInstalledTool(name, { value: 'ok' })
      const meta = JSON.parse(fs.readFileSync(path.join(paths.sandboxDir, 'installed_tools', name + '.json'), 'utf-8'))
      console.log('@@RESULT@@' + JSON.stringify({
        schema_name: schema?.function?.name,
        result,
        permissions: meta.permissions,
      }))
    `, {
      JARVIS_USER_DIR: tempUserDir,
      JARVIS_RESOURCES_DIR: process.cwd(),
    })
    assert(reloadRun.status === 0, 'isolated reload process exits cleanly', reloadRun.stderr || reloadRun.stdout)

    const reloaded = parseMarker(reloadRun.stdout)
    assert(reloaded?.schema_name === persistName, 'loadInstalledTools reloads generated schema from disk', JSON.stringify(reloaded))
    assert(reloaded?.result === 'persist-ok', 'reloaded generated tool executes from fresh registry', JSON.stringify(reloaded))
    assert(reloaded?.permissions?.network === false && reloaded?.permissions?.exec === false, 'installed managed tool persists default permissions', JSON.stringify(reloaded?.permissions))
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true })
  }
}

// Legacy disk tools without permissions still load with the compatibility path.
{
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), `blm-tool-legacy-${suffix}-`))
  try {
    const legacyRun = runIsolatedNode(`
      import fs from 'fs'
      import path from 'path'
      import { paths } from './src/paths.js'
      import { executeInstalledTool, getInstalledToolSchema, loadInstalledTools } from './src/capabilities/marketplace/index.js'
      const name = ${JSON.stringify(legacyName)}
      const toolsDir = path.join(paths.sandboxDir, 'installed_tools')
      fs.mkdirSync(toolsDir, { recursive: true })
      fs.writeFileSync(path.join(toolsDir, name + '.json'), JSON.stringify({
        name,
        description: 'Legacy tool without permissions metadata.',
        parameters: { type: 'object', properties: {}, required: [] },
        code: 'return process.cwd() ? "legacy-ok" : "legacy-bad"',
        installed_at: new Date().toISOString(),
      }, null, 2), 'utf-8')
      await loadInstalledTools()
      const schema = getInstalledToolSchema(name)
      const result = await executeInstalledTool(name, {})
      console.log('@@RESULT@@' + JSON.stringify({ schema_name: schema?.function?.name, result }))
    `, {
      JARVIS_USER_DIR: tempUserDir,
      JARVIS_RESOURCES_DIR: process.cwd(),
    })
    assert(legacyRun.status === 0, 'isolated legacy load process exits cleanly', legacyRun.stderr || legacyRun.stdout)

    const legacy = parseMarker(legacyRun.stdout)
    assert(legacy?.schema_name === legacyName, 'legacy tool without permissions exposes schema', JSON.stringify(legacy))
    assert(legacy?.result === 'legacy-ok', 'legacy tool without permissions keeps legacy globals compatibility', JSON.stringify(legacy))
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true })
  }
}

for (const name of cleanupToolNames) {
  try { uninstallTool({ name }) } catch {}
}
for (const id of cleanupProposalIds) {
  try { await execManageToolFactory({ action: 'delete', proposal_id: id }) } catch {}
}

const failed = checks.filter(c => !c.ok)
console.log(`\nTool factory checks: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exitCode = 1
