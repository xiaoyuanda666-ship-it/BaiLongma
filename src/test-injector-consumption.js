// UI signal consumption must be committed only after a successful model call.
// Run: electron src/test-injector-consumption.js

import fs from 'fs'
import path from 'path'
import os from 'os'

const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-injector-consumption-'))
process.env.BAILONGMA_USER_DIR = tempUserDir
process.env.USERPROFILE = tempUserDir
process.env.HOME = tempUserDir

try {
  const db = await import('./db.js')
  const {
    runInformationInjector,
    commitInformationConsumption,
  } = await import('./injectors/information-injector.js')

  db.getDB()
  const id = db.insertUISignal({ type: 'card.action', target: 'test', payload: { action: 'open' } })
  const information = runInformationInjector()

  if (!information.uiSignalIds.includes(id)) throw new Error('information injector did not return pending UI signal id')
  if (!db.getUnconsumedUISignals().some(signal => signal.id === id)) throw new Error('UI signal was consumed during read phase')

  const committed = commitInformationConsumption(information)
  if (committed.committed !== 1) throw new Error('UI signal commit count mismatch')
  if (db.getUnconsumedUISignals().some(signal => signal.id === id)) throw new Error('UI signal remained after commit')

  console.log('injector consumption contract ok')
} finally {
  try {
    const { closeDBForTest } = await import('./db.js')
    closeDBForTest()
  } catch {}
  fs.rmSync(tempUserDir, { recursive: true, force: true })
}
