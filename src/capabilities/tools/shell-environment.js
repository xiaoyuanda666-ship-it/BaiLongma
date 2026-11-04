import os from 'node:os'
import path from 'node:path'

// GUI-launched macOS apps do not inherit the user's login-shell PATH.
// Preserve existing resolution order, then add standard CLI installation paths.
export function shellEnvironment(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
  const result = { ...env }
  const key = Object.keys(result).find(key => key.toLowerCase() === 'path') || 'PATH'
  const delimiter = platform === 'win32' ? ';' : ':'
  const extra = [env.BSK_INSTALL_DIR, path.join(home, '.local', 'bin'),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])].filter(Boolean)
  result[key] = [...new Set([...(result[key] || '').split(delimiter).filter(Boolean), ...extra])].join(delimiter)
  return result
}
