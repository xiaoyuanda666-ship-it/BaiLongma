import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-bsk-skill-'))
process.env.BAILONGMA_USER_DIR = temp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const { config } = await import('./config.js')
const { paths } = await import('./paths.js')
const { selectSkillsForMessage } = await import('./skills/registry.js')
const { execReadFile, execWriteFile } = await import('./capabilities/tools/filesystem.js')
const { collectVerifiedWebResearchSources } = await import('./runtime/action-contract.js')
after(() => fs.rmSync(temp, { recursive: true, force: true }))

test('bundled bsk skill is discoverable and its relative references are readable in the default sandbox', async () => {
  config.security.fileSandbox = true
  const skill = selectSkillsForMessage('用 bsk 浏览器读取网页').active.find(skill => skill.id === 'bsk')
  assert.ok(skill && skill.source === 'bundled')
  assert.equal(evaluateToolPolicy('read_file', { path: skill.filePath }, { currentUserMessage: '用浏览器读取网页' }).allowed, true)
  const text = await execReadFile({ path: skill.filePath })
  assert.match(text, /run_command/)
  assert.match(text, /web_search/)
  const references = [...text.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1])
  assert.ok(references.length > 0)
  for (const ref of references) assert.ok((await execReadFile({ path: path.join(skill.dir, ref) })).length > 0)
  await assert.rejects(() => execWriteFile({ path: path.join(skill.dir, 'must-not-write.txt'), content: 'x' }), /拒绝|sandbox/)
  const outside = path.join(temp, 'outside.txt'); fs.writeFileSync(outside, 'private')
  await assert.rejects(() => execReadFile({ path: outside }), /拒绝|sandbox/)
})

test('bsk article observations count as evidence; setup, snippets and failed commands do not', () => {
  const result = { ok: true, exit_code: 0, command: 'bsk observe --session task --json',
    stdout: JSON.stringify({ url: 'https://example.com/articles/original', title: 'Original', text: 'Original article body. '.repeat(20) }) }
  const sources = value => collectVerifiedWebResearchSources([{ name: 'run_command', result: JSON.stringify(value) }])
  assert.equal(sources(result).length, 1)
  assert.equal(sources({ ...result, exit_code: 1 }).length, 0)
  assert.equal(sources({ ...result, command: 'bsk doctor' }).length, 0)
  assert.equal(sources({ ...result, stdout: '{}' }).length, 0)
})
