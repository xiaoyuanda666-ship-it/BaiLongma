import crypto from 'node:crypto'
import { isLoopbackAddress, isPrivateLanAddress, timingSafeTokenEqual } from './websocket-security.js'

function cookieName(req) {
  const port = new URL(`http://${req.headers.host}`).port || 'default'
  return `bailongma-session-${port}`
}
const SESSION_SECONDS = 12 * 60 * 60

// Origin is a browser boundary, not proof that a caller is on a trusted network.
export function isTrustedRequestOrigin(req, { allowPublicNavigation = false } = {}) {
  const origin = req.headers?.origin
  const publicNavigation = allowPublicNavigation && req.method === 'GET'
    && req.headers?.['sec-fetch-mode'] === 'navigate'
    && req.headers?.['sec-fetch-dest'] === 'document'
    && req.headers?.['sec-fetch-user'] === '?1'
  if (req.headers?.['sec-fetch-site'] === 'cross-site' && !publicNavigation) return false
  if (origin === 'null') return false
  try {
    const expected = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${req.headers?.host}`)
    if (!isLoopbackAddress(expected.hostname) && !isPrivateLanAddress(expected.hostname)) return false
    if (publicNavigation) return true
    if (!origin) return true // Native clients and same-origin GET commonly omit Origin.
    const parsed = new URL(origin)
    return parsed.origin === origin && parsed.origin === expected.origin
  } catch { return false }
}

function signature(payload, token) {
  return crypto.createHmac('sha256', token).update(`bailongma-session:${payload}`).digest('base64url')
}

export function createSessionCookie(token, req, now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${crypto.randomBytes(16).toString('base64url')}`
  return `${cookieName(req)}=${payload}.${signature(payload, token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${req.socket?.encrypted ? '; Secure' : ''}`
}

export function hasValidSession(req, token, now = Date.now()) {
  if (!token) return false
  const COOKIE = cookieName(req)
  const value = String(req.headers?.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  if (!value) return false
  const [expires, nonce, mac, extra] = value.split('.')
  if (extra || !/^\d+$/.test(expires) || !nonce || Number(expires) <= Math.floor(now / 1000)) return false
  return timingSafeTokenEqual(mac, signature(`${expires}.${nonce}`, token))
}

export function hasBearerToken(req, token) {
  return timingSafeTokenEqual(String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim(), token)
}

export function hasAuthorizedAccess(req, { lanEnabled, expectedToken } = {}) {
  if (!isTrustedRequestOrigin(req)) return false
  if (isLoopbackAddress(req.socket?.remoteAddress)) return true
  return !!lanEnabled && isPrivateLanAddress(req.socket?.remoteAddress)
    && (hasBearerToken(req, expectedToken) || hasValidSession(req, expectedToken))
}

export function isPublicBootstrapRequest(req, pathname) {
  if (req.method !== 'GET') return false
  return new Set(['/', '/index.html', '/brain-ui', '/brain-ui.html', '/activation', '/activation.html',
    '/favicon.ico', '/bailongma-lan-root-ca.cer', '/vendor/d3/d3.min.js', '/site-assets/icon.png']).has(pathname)
    || pathname.startsWith('/src/ui/brain-ui/') || pathname.startsWith('/src/ui/scene-shell/')
}
