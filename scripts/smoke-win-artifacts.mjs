#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { assertPeX64 } from './build-win.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const unpacked = path.join(root, 'dist', 'win-unpacked')
const exe = path.join(unpacked, 'Bailongma.exe')
const resources = path.join(unpacked, 'resources')
const appAsar = path.join(resources, 'app.asar')
const appUnpacked = `${appAsar}.unpacked`
const installer = path.join(root, 'dist', `Bailongma-Setup-${pkg.version}.exe`)
const latestYml = path.join(root, 'dist', 'latest.yml')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`Windows artifact smoke requires Windows x64, got ${process.platform}-${process.arch}`)
}

for (const [file, label] of [[exe, 'packaged app'], [appAsar, 'app.asar'], [installer, 'NSIS installer'], [latestYml, 'latest.yml']]) {
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0, `${label} is missing or empty: ${file}`)
}
assertPeX64(exe, 'packaged Bailongma executable')
assertPeX64(path.join(resources, 'node-runtime', 'node.exe'), 'bundled Node runtime')
assertPeX64(path.join(appUnpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'packaged better-sqlite3 binding')
assertPeX64(path.join(appUnpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node'), 'packaged ONNX Runtime binding')

assert.equal(fs.existsSync(path.join(appUnpacked, 'build', 'native-speech-recognizer')), false,
  'Windows package must not contain the macOS native speech helper')

const entries = new Set(listPackage(appAsar).map(entry => entry.replaceAll('\\', '/')))
for (const required of [
  '/package.json',
  '/electron/main.cjs',
  '/src/index.js',
  '/src/device-information-scanner.js',
  '/node_modules/better-sqlite3/package.json',
  '/node_modules/sharp/package.json',
  '/node_modules/sherpa-onnx-node/package.json',
]) {
  assert.ok(entries.has(required), `required packaged entry is missing: ${required}`)
}
const packagedPkg = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'))
assert.equal(packagedPkg.version, pkg.version, 'packaged version does not match package.json')

function probeModule(label, source) {
  const result = spawnSync(exe, ['-e', source], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BAILONGMA_SMOKE_APP_ASAR: appAsar },
  })
  assert.equal(result.status, 0, `${label} probe failed:\n${result.stdout || ''}\n${result.stderr || ''}`)
}

const requirePrelude = "const {createRequire}=require('node:module');const r=createRequire(require('node:path').join(process.env.BAILONGMA_SMOKE_APP_ASAR,'package.json'));"
probeModule('better-sqlite3', `${requirePrelude}const D=r('better-sqlite3');const d=new D(':memory:');d.exec('select 1');d.close();`)
probeModule('sharp', `${requirePrelude}const s=r('sharp');if(!s.versions?.sharp)throw new Error('sharp version unavailable');`)
probeModule('sherpa-onnx', `${requirePrelude}const s=r('sherpa-onnx-node');if(!s)throw new Error('sherpa unavailable');`)

const latest = fs.readFileSync(latestYml, 'utf8')
assert.match(latest, new RegExp(`version:\\s*['\"]?${pkg.version.replaceAll('.', '\\.')}`))
assert.ok(latest.includes(path.basename(installer)), 'latest.yml does not reference this version installer')

console.log(JSON.stringify({
  ok: true,
  version: pkg.version,
  platform: process.platform,
  arch: process.arch,
  installer,
  installerBytes: fs.statSync(installer).size,
}, null, 2))
