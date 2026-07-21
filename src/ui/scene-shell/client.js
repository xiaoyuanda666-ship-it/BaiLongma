// scene 传输客户端 —— 连接 /scene WebSocket,把协议消息变成对 shell 的调用。
//
// 职责(SCENE-PROTOCOL §2/§3/§8):
//   - 连接后发 hello;处理 welcome / scene / scene.patch。
//   - 维护本地 rev;间隙检测:patch.base !== 本地 rev → 发 resync 并等全量 scene。
//   - 指数退避重连;重连后重新 hello。
//   - 暴露 sendIntent({surface,name,data})。
//   - 忽略 v !== 1 或未知 type 的消息;无法解析的 JSON 直接丢弃。
//
// 本模块不碰 DOM、不做投影 —— 它只把"对齐后的完整 scene"交给 onScene 回调。
// patch 在客户端内就地合并成完整 scene 再下发,让上层(shell)始终面对全量快照,实现简单。

export class SceneClient {
  // url:ws 地址;onScene(scene):每次得到对齐后的完整 scene 时调用;
  // onStatus(state):连接状态变化('connecting'|'open'|'closed')。
  constructor(url, { onScene, onStatus, caps } = {}, protocols = []) {
    this.url = url
    this.protocols = protocols
    this.onScene = onScene || (() => {})
    this.onStatus = onStatus || (() => {})
    this.caps = caps || ['scene', 'patch']

    this.ws = null
    this.rev = -1                 // 本地已对齐的版本;-1 = 尚未收到首帧
    this.surfaces = new Map()     // 本地维护的 id -> surface,用于就地合并 patch
    this.backoff = 500            // 重连退避起点(ms)
    this.maxBackoff = 15000
    this.closedByUser = false
    this.reconnectTimer = null
  }

  connect() {
    this.closedByUser = false
    this._open()
  }

  _open() {
    this.onStatus('connecting')
    let ws
    try {
      ws = new WebSocket(this.url, this.protocols)
    } catch {
      this._scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.backoff = 500
      this.onStatus('open')
      // 握手:声明身份与能力。重连后同样重发 hello(§8)。
      this._send({ v: 1, type: 'hello', shell: 'cinematic', shellVersion: '0.1.0', caps: this.caps })
    })

    ws.addEventListener('message', (ev) => this._onMessage(ev.data))

    ws.addEventListener('close', () => {
      this.onStatus('closed')
      if (!this.closedByUser) this._scheduleReconnect()
    })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* close 会触发重连 */ } })
  }

  _onMessage(raw) {
    let msg
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch { return }
    if (!msg || msg.v !== 1) return        // 未知版本:忽略(§8)

    switch (msg.type) {
      case 'welcome':
        // 记下服务器 rev;若与本地不符,主动请求全量对齐(§8 重连恢复)。
        if (typeof msg.rev === 'number' && msg.rev !== this.rev) {
          this._sendResync('init')
        }
        break

      case 'scene':
        // 全量快照:本地状态完全等于它。
        this._applyFullScene(msg)
        break

      case 'scene.patch':
        this._applyPatch(msg)
        break

      case 'ping':
        this._send({ v: 1, type: 'pong' })
        break

      case 'pong':
        break

      default:
        break                              // 未知 type:忽略(§8)
    }
  }

  // 全量快照 → 重置本地 surfaces + rev,投影出去。
  _applyFullScene(msg) {
    this.surfaces = new Map()
    for (const s of Array.isArray(msg.surfaces) ? msg.surfaces : []) {
      if (s && typeof s.id === 'string') this.surfaces.set(s.id, s)
    }
    this.rev = typeof msg.rev === 'number' ? msg.rev : 0
    this._emitScene()
  }

  // 增量补丁:先做间隙检测,再就地合并,合并后下发完整 scene。
  _applyPatch(msg) {
    // 间隙检测:base 必须等于本地 rev,否则漏帧 → 丢弃 + resync(§3.2 / §8)。
    if (msg.base !== this.rev) {
      this._sendResync('gap')
      return
    }
    for (const op of Array.isArray(msg.ops) ? msg.ops : []) {
      if (!op) continue
      if (op.op === 'upsert' && op.surface && typeof op.surface.id === 'string') {
        this.surfaces.set(op.surface.id, op.surface)       // 按 id 整体替换 / 插入
      } else if (op.op === 'remove' && typeof op.id === 'string') {
        this.surfaces.delete(op.id)
      }
      // 未知 op:忽略(向前兼容)
    }
    this.rev = typeof msg.rev === 'number' ? msg.rev : this.rev
    this._emitScene()
  }

  // 把本地维护的 surfaces 组装成一份完整 scene 交给上层。
  _emitScene() {
    this.onScene({ v: 1, type: 'scene', rev: this.rev, surfaces: [...this.surfaces.values()] })
  }

  _sendResync(reason) {
    this._send({ v: 1, type: 'resync', reason })
  }

  // 上行用户意图(SCENE-PROTOCOL §3.4)。ts 由客户端打本地时间戳。
  sendIntent({ surface, name, data }) {
    this._send({ v: 1, type: 'intent', surface: surface ?? null, name, data: data || {}, ts: Date.now() })
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)) } catch { /* 断开由 close 处理 */ }
    }
  }

  _scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff)   // 指数退避
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._open()
    }, delay)
  }

  close() {
    this.closedByUser = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) { try { this.ws.close() } catch { /* 已断 */ } }
  }
}
