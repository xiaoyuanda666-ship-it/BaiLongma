import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'
import { createSecureContext } from 'node:tls'
import { domainToASCII } from 'node:url'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-lan-access-'))
const originalHostname = os.hostname
os.hostname = () => 'AI电脑20260925'
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
  assert.equal(san.altNames.some(item => item.type === 2 && item.value === domainToASCII(os.hostname()).toLowerCase()), true)
  const tlsCheck = () => createSecureContext({key: fs.readFileSync(files.serverKey), cert: fs.readFileSync(files.serverCert)})
  tlsCheck()
  const rootBefore = fs.readFileSync(files.rootCert, 'utf8')
  const leafBefore = fs.readFileSync(files.serverCert, 'utf8')
  lan.ensureLanTlsCertificates(['192.168.55.10'])
  assert.equal(fs.readFileSync(files.serverCert, 'utf8'), leafBefore, 'valid cache is reused')
  const legacyMetadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8'))
  delete legacyMetadata.dnsNames
  fs.writeFileSync(files.metadata, JSON.stringify(legacyMetadata))
  lan.ensureLanTlsCertificates(['192.168.55.10'])
  assert.notEqual(fs.readFileSync(files.serverCert, 'utf8'), leafBefore, 'legacy certificates are regenerated')
  assert.equal(fs.readFileSync(files.rootCert, 'utf8'), rootBefore, 'root trust is preserved')
  fs.writeFileSync(files.serverCert, 'invalid certificate')
  lan.ensureLanTlsCertificates(['192.168.55.10'])
  tlsCheck()
  os.hostname = () => 'renamed-pc'
  lan.ensureLanTlsCertificates(['192.168.55.10'])
  assert.ok(JSON.parse(fs.readFileSync(files.metadata, 'utf8')).dnsNames.includes('renamed-pc'))
  tlsCheck()
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
  os.hostname = originalHostname
  delete process.env.BAILONGMA_USER_DIR
  delete process.env.BAILONGMA_ALLOW_LAN
  delete process.env.BAILONGMA_API_TOKEN
  delete process.env.BAILONGMA_PORT
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
