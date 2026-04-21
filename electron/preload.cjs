// 预留给未来暴露给前端的桥（比如自动更新状态、打开系统文件夹等）。
// 目前激活页和 brain-ui 都通过 HTTP 和后端说话，不需要额外 bridge。
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('bailongma', {
  platform: process.platform,
})
