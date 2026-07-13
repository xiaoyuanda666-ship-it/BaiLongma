import { getInstalledToolNames } from '../../capabilities/marketplace/index.js'
import { selectTools } from '../tool-router.js'

export async function selectInjectorTools({
  messageBody = '',
  isTick = false,
  senderId = null,
  hasTask = false,
  hasRecall = false,
  actionLog = [],
  startupSelfCheckActive = false,
} = {}) {
  const { listCapabilities } = await import('../../providers/registry.js')
  const mmCaps = listCapabilities()
  const installedNames = getInstalledToolNames()

  return selectTools({
    messageBody,
    isTick,
    senderId,
    hasTask,
    hasRecall,
    mmCaps,
    recentActionLog: actionLog,
    installedToolNames: installedNames,
    startupSelfCheckActive,
    // fastUserPath 留作未来扩展——目前从 state 上拿不到，selectTools 接受未传即 false
  })
}
