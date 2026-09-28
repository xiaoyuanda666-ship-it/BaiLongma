// App composition: transport configuration stays outside Agent Runtime.
import { startAPI } from '../api.js'
import { startTUI } from './terminal.js'

export function startApplicationAPI({ runtimeContext, reportStartupProgress = () => {}, env = process.env }) {
  const port = Number(env.BAILONGMA_PORT) || 3721
  const protocol = env.BAILONGMA_TLS_PFX || (env.BAILONGMA_TLS_CERT && env.BAILONGMA_TLS_KEY)
    ? 'https'
    : 'http'
  reportStartupProgress('api', 'running', `准备监听 ${protocol}://127.0.0.1:${port}`, '正在启动本地 API')
  const server = startAPI(port, runtimeContext)
  return { port, protocol, server }
}

export function startApplicationTerminal(userId) {
  return startTUI(userId)
}

// App owns presentation startup; the same runtime can be started without this host.
export async function startApplication({
  runtime,
  reportStartupProgress = () => {},
  startAPI: startAPIHost = startApplicationAPI,
  startTerminal = startApplicationTerminal,
  logger = console,
}) {
  const { port, protocol, server } = startAPIHost({
    reportStartupProgress,
    runtimeContext: {
      getStateSnapshot: runtime.getStateSnapshot,
      onActivated: runtime.onActivated,
      onActivationIntroComplete: runtime.onActivationIntroComplete,
    },
  })
  runtime.startBackgroundServices()
  reportStartupProgress('api', 'running', `等待 ${protocol}://127.0.0.1:${port} 就绪`, '正在等待本地 API 就绪')
  startTerminal('ID:000001')
  let runtimeStarted = null
  if (runtime.needsActivation) {
    logger.log(`Please open ${protocol}://127.0.0.1:${port}/activation in your browser to activate before sending messages\n`)
  } else {
    logger.log('Type a message and press Enter to send it to Jarvis\n')
    // The first turn may perform slow model/tool work. UI readiness must not
    // wait for it; keep the original promise observable and handle failures.
    // Calling start directly still propagates synchronous startup failures.
    runtimeStarted = Promise.resolve(runtime.start())
    runtimeStarted.catch(err => logger.error('[system] Main loop failed to start:', err))
  }
  return { port, protocol, server, runtimeStarted }
}
