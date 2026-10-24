import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readRemoteVersions } from '../../../scripts/publish-updates-lib.mjs'

test('remote version read sends the read-only script and preserves missing architectures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ssh-test-'))
  const previousPath = process.env.PATH
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(dir, { recursive:true, force:true }) })
  fs.writeFileSync(path.join(dir, 'ssh'), `#!/bin/sh
body=$(cat)
case "$body" in *'platform=$1'*'manifest=$2'*'shift 2'*) ;; *) exit 91 ;; esac
case "$body" in *'install '*|*'mv '*|*'flock '*) exit 92 ;; esac
printf 'x64=\\narm64=2.2.155\\n'
`, {mode:0o755})
  process.env.PATH = `${dir}:${previousPath}`
  const versions = readRemoteVersions(dir, 'bailongma-server', {platform:'mac', manifestName:'latest-mac.yml'}, ['x64','arm64'])
  assert.deepEqual(Object.fromEntries(versions), {x64:'',arm64:'2.2.155'})
})
