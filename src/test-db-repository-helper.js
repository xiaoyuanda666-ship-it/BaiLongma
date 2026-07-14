import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function runRepositoryTest(name, test) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-${name}-`))
  const resolvedTempRoot = path.resolve(tempRoot)
  const resolvedOsTemp = path.resolve(os.tmpdir())

  if (!resolvedTempRoot.startsWith(`${resolvedOsTemp}${path.sep}`)) {
    throw new Error(`Refusing to use unsafe temp path: ${resolvedTempRoot}`)
  }

  process.env.JARVIS_USER_DIR = resolvedTempRoot
  process.env.JARVIS_RESOURCES_DIR = path.resolve('.')

  try {
    const connection = await import('./db/connection.js')
    await test(connection)
    connection.closeDBForTest()
  } finally {
    const { closeDBForTest } = await import('./db/connection.js')
    closeDBForTest()
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true })
  }

  console.log(`${name} repository tests passed`)
}
