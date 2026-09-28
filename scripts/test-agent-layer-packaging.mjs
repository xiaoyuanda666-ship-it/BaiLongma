import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage, extractFile, listPackage } from '@electron/asar'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { projectRoot, sourceFiles, moduleSpecifiers } from './check-agent-layers.mjs'

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const layerNames = ['kernel', 'runtime', 'app', 'composition']
const layerFiles = layerNames.flatMap(layer => sourceFiles(path.join(projectRoot, 'src', layer)))
const entryFiles = ['src/index.js', 'src/events.js', 'src/queue.js', 'src/control.js', 'src/tui.js', 'src/llm.js', 'src/capabilities/tools/filesystem.js', 'electron/main.cjs', 'package.json', 'scripts/seed-memories.js']
const candidates = [...sourceFiles(path.join(projectRoot, 'src')), ...entryFiles.map(name => path.join(projectRoot, name))]

for (const platform of ['mac', 'win', 'linux']) {
  test(`${platform}: all layers and compatibility entries share one source ASAR`, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `bailongma-layers-${platform}-`))
    try {
      const stage = path.join(temporary, 'app')
      fs.mkdirSync(stage)
      // Use the installed builder's actual global + platform pattern merger.
      const matchers = getFileMatchers(pkg.build, 'files', stage, {
        defaultSrc: projectRoot,
        globalOutDir: path.join(projectRoot, pkg.build.directories.output),
        customBuildOptions: pkg.build[platform] || {},
        macroExpander: value => value,
      })
      const filter = matchers[0].createFilter()
      const files = [...new Set(candidates)].filter(file => filter(file, fs.statSync(file)))
      for (const file of files) {
        const destination = path.join(stage, path.relative(projectRoot, file))
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(file, destination)
      }
      const archive = path.join(temporary, 'app.asar')
      await createPackage(stage, archive)
      const entries = new Set(listPackage(archive).map(entry => entry.replaceAll('\\', '/')))
      const required = [...layerFiles, ...entryFiles.map(name => path.join(projectRoot, name))]
      for (const file of required) {
        const name = path.relative(projectRoot, file).split(path.sep).join('/')
        assert.ok(entries.has(`/${name}`), `${platform} package dropped ${name}`)
        assert.equal(extractFile(archive, name).toString(), fs.readFileSync(file, 'utf8'))
        if (!/\.(?:js|cjs|mjs)$/.test(file) || name.startsWith('electron/')) continue
        for (const dependency of moduleSpecifiers(fs.readFileSync(file, 'utf8'))) {
          if (!dependency.startsWith('.')) continue
          const resolved = path.relative(projectRoot, path.resolve(path.dirname(file), dependency)).split(path.sep).join('/')
          assert.ok(entries.has(`/${resolved}`), `${name} needs unpackaged module ${resolved}`)
        }
      }
      assert.ok(![...entries].some(name => /\/test[-.]/.test(name)), 'test files stay out of the App')
      const packaged = JSON.parse(extractFile(archive, 'package.json').toString())
      assert.equal(packaged.main, 'electron/main.cjs')
      assert.equal(packaged.version, pkg.version)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })
}
