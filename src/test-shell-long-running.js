// Run: node src/test-shell-long-running.js

import { getCommandFailureHint } from './capabilities/tools/shell.js'
import { classifyCommandProfile, isLikelyLongRunningCommand } from './capabilities/tools/command-profiles.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

assert(isLikelyLongRunningCommand('watch -n 1 pm2 list'), 'detects watch')
assert(isLikelyLongRunningCommand('ssh root@1.2.3.4 "watch -n 1 uptime"'), 'detects remote watch over ssh')
assert(isLikelyLongRunningCommand('tail -f /var/log/nginx/access.log'), 'detects tail -f')
assert(isLikelyLongRunningCommand('journalctl -u nginx -f'), 'detects journalctl follow')
assert(isLikelyLongRunningCommand('npm run dev'), 'detects dev server')
assert(!isLikelyLongRunningCommand('ssh root@1.2.3.4 "uptime && pm2 list"'), 'does not mark normal ssh command')
assert(!isLikelyLongRunningCommand('Get-ChildItem'), 'does not mark normal command')
assert(
  classifyCommandProfile(process.platform === 'win32' ? 'Get-ChildItem' : 'ls').mode === (process.platform === 'win32' ? 'quick' : 'task'),
  'classifies quick inspection commands according to the platform fast lane'
)
assert(classifyCommandProfile('npm install').mode === 'task', 'classifies finite task commands')
assert(classifyCommandProfile('npm run dev').mode === 'background', 'classifies dev servers as background')
assert(classifyCommandProfile('curl https://example.com/file.zip -o file.zip').mode === 'download', 'classifies shell downloads')
assert(classifyCommandProfile('git reset --hard').mode === 'strict', 'classifies strict command families')
assert(
  /broken quoting/i.test(getCommandFailureHint('ssh root@1.2.3.4 "bash -lc \'"', 'bash: -c: line 2: syntax error: unexpected end of file')),
  'diagnoses broken remote ssh quoting'
)
assert(
  /PowerShell/i.test(getCommandFailureHint('ssh root@1.2.3.4 "echo test', 'The string is missing the terminator: ".')),
  'diagnoses local PowerShell quoting errors'
)

if (failed === 0) {
  console.log('\nAll shell long-running checks complete.')
} else {
  console.log(`\n${failed} shell long-running check(s) failed.`)
}
