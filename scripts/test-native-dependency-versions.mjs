#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertNativeDependencyVersion } from './check-native-dependency-versions.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-native-deps-test-'))
const dependency = 'better-sqlite3'

function writeFixture({ declared = '12.8.0', lockDeclared = declared, locked = declared, installed = declared } = {}) {
  fs.mkdirSync(path.join(root, 'node_modules', dependency), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [dependency]: declared } }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    packages: {
      '': { dependencies: { [dependency]: lockDeclared } },
      [`node_modules/${dependency}`]: { version: locked },
    },
  }))
  fs.writeFileSync(
    path.join(root, 'node_modules', dependency, 'package.json'),
    JSON.stringify({ name: dependency, version: installed }),
  )
}

try {
  writeFixture()
  assert.equal(assertNativeDependencyVersion(root, dependency).installed, '12.8.0')

  writeFixture({ installed: '12.11.1' })
  assert.throws(() => assertNativeDependencyVersion(root, dependency), /node_modules contains 12\.11\.1, expected 12\.8\.0/)

  writeFixture({ declared: '^12.8.0', lockDeclared: '^12.8.0', locked: '12.8.0', installed: '12.8.0' })
  assert.throws(() => assertNativeDependencyVersion(root, dependency), /must pin an exact version/)

  writeFixture({ lockDeclared: '^12.8.0' })
  assert.throws(() => assertNativeDependencyVersion(root, dependency), /package-lock\.json declares \^12\.8\.0/)

  console.log('[test-native-dependency-versions] all tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
