// Shared by CLI publishing and the local release console.
export const UPDATE_SERVER = Object.freeze({
  sshHost: process.env.BAILONGMA_UPDATE_SSH_HOST || 'bailongma-server',
  origin: 'https://bailongma.top/updates',
  serverRoot: '/srv/bailongma-updates',
  updaterHeader: 'BailongmaUpdater/2',
  channel: 'stable',
})
