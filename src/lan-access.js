import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'
import { paths } from './paths.js'

const LAN_TLS_DIR = path.join(paths.dataDir, 'lan-tls')

export function isPrivateLanIpv4(address = '') {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

export function getPrivateLanAddresses() {
  const candidates = []
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : '')
      if (family !== 'IPv4' || entry.internal || !isPrivateLanIpv4(entry.address)) continue
      const virtual = /(vethernet|wsl|docker|vmware|virtualbox|hyper-v|tailscale|zerotier)/i.test(interfaceName)
      const prefixPriority = entry.address.startsWith('192.168.') ? 0
        : entry.address.startsWith('10.') ? 10
          : 20
      candidates.push({
        address: entry.address,
        priority: prefixPriority + (virtual ? 100 : 0),
      })
    }
  }
  candidates.sort((a, b) => a.priority - b.priority
    || a.address.localeCompare(b.address, undefined, { numeric: true }))
  return [...new Set(candidates.map(candidate => candidate.address))]
}

export function getLanTlsPaths() {
  return {
    rootKey: path.join(LAN_TLS_DIR, 'root-ca-key.pem'),
    rootCert: path.join(LAN_TLS_DIR, 'root-ca-cert.pem'),
    rootCer: path.join(LAN_TLS_DIR, 'bailongma-lan-root-ca.cer'),
    serverKey: path.join(LAN_TLS_DIR, 'server-key.pem'),
    serverCert: path.join(LAN_TLS_DIR, 'server-cert-chain.pem'),
    metadata: path.join(LAN_TLS_DIR, 'certificate-metadata.json'),
  }
}

function writeAtomic(filePath, value, encoding = undefined) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, value, encoding)
  fs.renameSync(tmp, filePath)
}

function randomSerialNumber() {
  return `00${crypto.randomBytes(16).toString('hex')}`
}

function createRootCertificate(files) {
  const pki = forge.pki
  const keys = pki.rsa.generateKeyPair(2048)
  const cert = pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerialNumber()
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
  const attrs = [{ name: 'commonName', value: 'Bailongma LAN Root CA' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 1, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  writeAtomic(files.rootKey, pki.privateKeyToPem(keys.privateKey), 'utf8')
  writeAtomic(files.rootCert, pki.certificateToPem(cert), 'utf8')
  const der = forge.asn1.toDer(pki.certificateToAsn1(cert)).getBytes()
  writeAtomic(files.rootCer, Buffer.from(der, 'binary'))
  return { cert, privateKey: keys.privateKey }
}

function readRootCertificate(files) {
  const pki = forge.pki
  if (!fs.existsSync(files.rootKey) || !fs.existsSync(files.rootCert) || !fs.existsSync(files.rootCer)) {
    return createRootCertificate(files)
  }
  try {
    return {
      cert: pki.certificateFromPem(fs.readFileSync(files.rootCert, 'utf8')),
      privateKey: pki.privateKeyFromPem(fs.readFileSync(files.rootKey, 'utf8')),
    }
  } catch {
    return createRootCertificate(files)
  }
}

function metadataMatches(files, addresses) {
  if (!fs.existsSync(files.serverKey) || !fs.existsSync(files.serverCert)) return false
  try {
    const metadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8'))
    return JSON.stringify(metadata.addresses || []) === JSON.stringify(addresses)
      && new Date(metadata.validUntil || 0).getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

function createServerCertificate(files, addresses, root) {
  const pki = forge.pki
  const keys = pki.rsa.generateKeyPair(2048)
  const cert = pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerialNumber()
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000)
  cert.setSubject([{ name: 'commonName', value: 'Bailongma LAN' }])
  cert.setIssuer(root.cert.subject.attributes)

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ]
  const hostname = os.hostname().trim()
  if (hostname) {
    altNames.push({ type: 2, value: hostname })
    altNames.push({ type: 2, value: `${hostname}.local` })
  }
  for (const address of addresses) altNames.push({ type: 7, ip: address })

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true },
  ])
  cert.sign(root.privateKey, forge.md.sha256.create())

  writeAtomic(files.serverKey, pki.privateKeyToPem(keys.privateKey), 'utf8')
  writeAtomic(
    files.serverCert,
    `${pki.certificateToPem(cert)}${pki.certificateToPem(root.cert)}`,
    'utf8',
  )
  writeAtomic(files.metadata, JSON.stringify({
    addresses,
    generatedAt: new Date().toISOString(),
    validUntil: cert.validity.notAfter.toISOString(),
  }, null, 2), 'utf8')
}

export function ensureLanTlsCertificates(addresses = getPrivateLanAddresses()) {
  const files = getLanTlsPaths()
  fs.mkdirSync(LAN_TLS_DIR, { recursive: true })
  const root = readRootCertificate(files)
  if (!metadataMatches(files, addresses)) createServerCertificate(files, addresses, root)
  return files
}
