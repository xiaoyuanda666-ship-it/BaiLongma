import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import { analyzeLocalServiceCommand } from './runtime/local-service-safety.js'
import { shouldInjectLocalServiceSafety } from './prompt-blocks/local-service-safety.js'

const sandboxProject = path.join(os.tmpdir(), 'bailongma-sandbox', 'projects', 'demo')

assert.equal(
  shouldInjectLocalServiceSafety({ userMessage: '写一个网页游戏并在浏览器打开', coding: true }),
  true,
  'coding turns receive local-service guidance'
)
assert.equal(
  shouldInjectLocalServiceSafety({ userMessage: '今天天气怎么样' }),
  false,
  'unrelated conversation does not receive the service block'
)

const vite = analyzeLocalServiceCommand('npm run dev', {
  cwd: sandboxProject,
  currentUserMessage: '运行这个前端项目测试一下',
})
assert.equal(vite.is_service, true)
assert.equal(vite.blocked, false, 'normal framework dev server remains allowed')
assert.equal(vite.exposure, 'unknown', 'runtime does not invent a bind address hidden inside package scripts')

const safeStatic = analyzeLocalServiceCommand('python3 -m http.server 8321 --bind 127.0.0.1', {
  cwd: sandboxProject,
  currentUserMessage: '把这个网页跑起来，在我电脑浏览器打开',
})
assert.equal(safeStatic.blocked, false, 'dedicated loopback static preview is allowed')
assert.equal(safeStatic.exposure, 'local')
assert.equal(safeStatic.served_root, path.resolve(sandboxProject))

const ipv6Static = analyzeLocalServiceCommand('python3 -m http.server 8321 --bind ::1', {
  cwd: sandboxProject,
  currentUserMessage: '本机预览网页',
})
assert.equal(ipv6Static.blocked, false, 'IPv6 loopback is accepted as local development')
assert.equal(ipv6Static.exposure, 'local')

const defaultPythonServer = analyzeLocalServiceCommand('python3 -m http.server 8321', {
  cwd: sandboxProject,
  currentUserMessage: '在我电脑浏览器打开',
})
assert.equal(defaultPythonServer.blocked, true, 'python static server default all-interface bind is corrected for local previews')
assert.equal(defaultPythonServer.code, 'NETWORK_SERVICE_NOT_REQUESTED')

const desktopRoot = analyzeLocalServiceCommand(
  `python3 -m http.server 8321 --bind 127.0.0.1 --directory ${path.join(os.homedir(), 'Desktop')}`,
  { cwd: sandboxProject, currentUserMessage: '打开刚写好的网页' },
)
assert.equal(desktopRoot.blocked, true, 'serving the entire Desktop for one preview is blocked')
assert.equal(desktopRoot.code, 'SERVICE_ROOT_TOO_BROAD')

const ordinaryRepo = analyzeLocalServiceCommand('python3 -m http.server 8321 --bind 127.0.0.1', {
  cwd: path.join(os.homedir(), 'src', 'existing-project'),
  currentUserMessage: '运行这个已有项目测试一下',
})
assert.equal(ordinaryRepo.blocked, false, 'an existing project outside the sandbox is not over-blocked')

const lanPreview = analyzeLocalServiceCommand('vite --host 0.0.0.0', {
  cwd: sandboxProject,
  currentUserMessage: '启动一下，让我手机在同一个局域网打开',
})
assert.equal(lanPreview.blocked, false, 'explicit LAN development remains allowed')
assert.equal(lanPreview.exposure, 'network')
assert(lanPreview.warnings.some(item => /authorized/i.test(item)))

const mobileDesign = analyzeLocalServiceCommand('vite --host 0.0.0.0', {
  cwd: sandboxProject,
  currentUserMessage: '做一个手机端网页，在我电脑浏览器测试',
})
assert.equal(mobileDesign.blocked, true, 'a mobile layout request alone does not authorize LAN exposure')

const bareViteHost = analyzeLocalServiceCommand('vite --host', {
  cwd: sandboxProject,
  currentUserMessage: '本机预览一下',
})
assert.equal(bareViteHost.blocked, true, 'bare Vite --host is recognized as all-interface exposure')

const positionalStaticRoot = analyzeLocalServiceCommand(
  `npx http-server ${path.join(os.homedir(), 'Downloads')} -a 127.0.0.1`,
  { cwd: sandboxProject, currentUserMessage: '预览一个网页' },
)
assert.equal(positionalStaticRoot.code, 'SERVICE_ROOT_TOO_BROAD', 'positional static roots are inspected')

const accidentalLan = analyzeLocalServiceCommand('uvicorn app:app --host 0.0.0.0 --port 8000', {
  cwd: sandboxProject,
  currentUserMessage: '把 API 跑起来本机测试',
})
assert.equal(accidentalLan.blocked, true, 'unrequested non-loopback API bind is blocked')
assert.equal(accidentalLan.code, 'NETWORK_SERVICE_NOT_REQUESTED')

const accidentalTunnel = analyzeLocalServiceCommand('ngrok http 3000', {
  cwd: sandboxProject,
  currentUserMessage: '在本机浏览器预览',
})
assert.equal(accidentalTunnel.blocked, true, 'public tunnel requires public intent')
assert.equal(accidentalTunnel.code, 'PUBLIC_SERVICE_NOT_REQUESTED')

const requestedTunnel = analyzeLocalServiceCommand('ngrok http 3000', {
  cwd: sandboxProject,
  currentUserMessage: '给我生成一个公网链接，外网也能访问',
})
assert.equal(requestedTunnel.blocked, false, 'explicit public tunnel request remains allowed')
assert.equal(requestedTunnel.exposure, 'public')

const finiteCommand = analyzeLocalServiceCommand('node build.js', {
  cwd: sandboxProject,
  currentUserMessage: '打包项目',
})
assert.equal(finiteCommand.is_service, false, 'ordinary finite commands are untouched')

console.log('test-local-service-safety passed')
