import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-lan-access-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_ALLOW_LAN = '1'
process.env.BAILONGMA_API_TOKEN = 'test-lan-pairing-token'
process.env.BAILONGMA_PORT = '4567'

try {
  const lan = await import(`./lan-access.js?test=${Date.now()}`)
  const files = lan.ensureLanTlsCertificates(['192.168.55.10'])

  for (const filePath of [files.rootCer, files.serverKey, files.serverCert, files.metadata]) {
    assert.equal(fs.existsSync(filePath), true, `${filePath} should exist`)
  }

  const leafPem = fs.readFileSync(files.serverCert, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
  const cert = forge.pki.certificateFromPem(leafPem)
  const san = cert.getExtension('subjectAltName')
  assert.equal(san.altNames.some(item => item.type === 7 && item.ip === '192.168.55.10'), true)
  assert.equal(san.altNames.some(item => item.type === 7 && item.ip === '127.0.0.1'), true)

  const configModule = await import(`./config.js?test=${Date.now()}`)
  const network = configModule.getNetworkConfig()
  assert.equal(network.allowLanAccess, true)
  assert.equal(network.accessToken, 'test-lan-pairing-token')
  assert.equal(network.httpsEnabled, true)
  for (const entry of network.accessEntries) {
    assert.match(entry.url, /^https:\/\/.+:4567\/#token=test-lan-pairing-token$/)
    assert.match(entry.certificateUrl, /^https:\/\/.+:4567\/bailongma-lan-root-ca\.cer$/)
  }

  console.log('LAN access certificate and URL tests passed')
} finally {
  delete process.env.BAILONGMA_USER_DIR
  delete process.env.BAILONGMA_ALLOW_LAN
  delete process.env.BAILONGMA_API_TOKEN
  delete process.env.BAILONGMA_PORT
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
