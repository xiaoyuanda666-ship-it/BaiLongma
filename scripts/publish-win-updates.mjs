#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import pkg from '../package.json' with { type: 'json' }
import { publishUpdates } from './publish-updates-lib.mjs'

const root = path.resolve(import.meta.dirname, '..')

publishUpdates({ platform: 'win', root, pkg }).catch(error => {
  console.error(`[publish:win] ${error.message}`)
  process.exitCode = 1
})
