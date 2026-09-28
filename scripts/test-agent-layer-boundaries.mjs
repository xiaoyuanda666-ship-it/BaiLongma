import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectAgentLayers, moduleSpecifiers } from './check-agent-layers.mjs'

function fixture(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-layer-check-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const filename = path.join(root, name)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, content)
    }
    callback(root)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('checker includes reexports, dynamic imports and nested Kernel modules', () => {
  assert.deepEqual(moduleSpecifiers(`import './setup.js'\nimport {\n a, b\n} from './x.js'\nexport { a } from './y.js'\nawait import('./z.js')`), ['./setup.js', './x.js', './y.js', './z.js'])
  fixture({
    'src/kernel/nested/adapter.js': "export * from '../../runtime/policy.js'",
    'src/runtime/policy.js': '',
  }, root => assert.match(inspectAgentLayers(root).errors.join('\n'), /Kernel cannot import another layer/))
})

test('checker follows compatibility facades and rejects Runtime-to-App back edges', () => {
  fixture({
    'src/runtime/host.js': "import { value } from '../compat.js'",
    'src/compat.js': "export { value } from './app/adapter.js'",
    'src/app/adapter.js': 'export const value = 1',
  }, root => assert.match(inspectAgentLayers(root).errors.join('\n'), /Runtime cannot load App.*compat.js -> src\/app\/adapter.js/))
})

test('checker rejects new Electron access and allows injected Runtime factories', () => {
  fixture({
    'src/runtime/host.js': "const electron = require('electron')",
    'src/kernel/transport.js': "import OpenAI from 'openai'",
  }, root => assert.match(inspectAgentLayers(root).errors.join('\n'), /Runtime cannot load Electron/))
  fixture({
    'src/runtime/host.js': 'export const create = port => ({ run: () => port.execute() })',
    'src/kernel/transport.js': "import fs from 'node:fs'",
  }, root => assert.deepEqual(inspectAgentLayers(root).errors, []))
})

test('new Runtime OS access and concrete Kernel construction require injected ports', () => {
  fixture({
    'src/runtime/new-service.js': "import fs from 'node:fs'\nimport { create } from '../kernel/store.js'",
    'src/kernel/store.js': 'export const create = () => ({})',
  }, root => {
    const errors = inspectAgentLayers(root).errors.join('\n')
    assert.match(errors, /Runtime must use infrastructure ports/)
    assert.match(errors, /Runtime must receive Kernel implementations/)
  })
})
