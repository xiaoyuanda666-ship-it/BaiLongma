// voice-wake.js —— 唤醒会话编排(命中→悬浮球→监听→退场)
//
// 命中「小白龙」由主进程经 IPC `wake:hit` 通知本渲染层(见 preload.cjs 的 bailongma.wake)。
// 会话引擎/对话/TTS 全部复用主窗口现有 voice-core(不重造);悬浮球是独立窗口、只当「脸」:
// 主窗口每帧把 {状态 sk, 真实音量 vol} + 文字推给球窗,由球窗注入 voice-core(setExternalVol)
// 驱动球体跳动,动画与 brain-ui 完全一致。
//
// 球下文字:① Agent 在干活时显示「思考中…」/「调用工具中…」(从后端 /events SSE 派生,
// 与 brain-ui 仪表盘同一事件流,Agent 无需多做动作);② 否则显示实时识别文字。
//
// 退场判断三条件:
//   ① 用户要求退下 / ② 任务完成 —— 属 Agent 自判:后端 voice_retire 工具发 SSE 事件,本侧收到后
//      等本轮回复说完(球离开 speaking)再退场(见 retireArmed),不切断告别语;用户又开口则取消。
//   ③ 一分钟内没有识别到新语音 → 退场。计时只在「空闲等用户」时累积:Agent 思考/调用工具/说话
//      期间会刷新活跃时刻,避免长回复中途被误关。

const IDLE_DISMISS_MS = 60000; // 条件三:60s 无新语音(且系统空闲)→ 退场
const IDLE_CHECK_MS = 2000;
const ORB_EXIT_MS = 320;       // 退场动画时长上限,过后才真停会话(与 voice-orb.html 0.28s 过渡对齐)
const FRAME_MIN_MS = 33;       // 推帧给球窗的最小间隔(≈30fps)

// 视为「系统繁忙、不该计入空闲」的 voice-core 状态
const BUSY_SK = new Set(['recognizing', 'processing', 'speaking', 'event', 'done']);

export function createWakeFlow(core) {
  const orb = (typeof window !== 'undefined' && window.bailongma && window.bailongma.wake) || null;

  let active = false;          // 唤醒会话进行中
  let inConversation = false;  // 已听到语音、转入正常对话
  let lastActiveTs = 0;        // 最近一次「用户说话 / 系统繁忙」时刻(空闲退场据此判)
  let idleTimer = null;
  let dismissToken = 0;

  // 推送去重 / 节流
  let lastFrameTs = 0, lastSk = null, lastText = null, lastThinking = null;

  // ── Agent 活动(从 /events SSE 派生,用于「思考中/调用工具中」文字) ──
  let agentText = '';          // '' = Agent 不在本轮干活
  let agentBusy = false;
  let ssePath = 'l2';          // l1=用户消息触发,l2=后台 TICK;只反映 l1(用户的语音对话)

  // ── Agent 自判退场(条件一/二:用户要求退下 / 任务完成):后端 voice_retire 事件触发 ──
  // 不立刻收起,等本轮回复说完(球离开 speaking、回到 listening)再退场,避免把话切断。
  let retirePending = false;   // 收到 voice_retire,等本轮结束
  let retireArmed = false;     // 本轮已 response,只待说完
  let retireArmedTs = 0;

  function markActive() { lastActiveTs = Date.now(); }

  // ── 60s 空闲退场 ──
  function startIdleWatch() {
    stopIdleWatch();
    markActive();
    idleTimer = setInterval(() => {
      if (!active) return;
      if (Date.now() - lastActiveTs >= IDLE_DISMISS_MS) dismiss();
    }, IDLE_CHECK_MS);
  }
  function stopIdleWatch() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  // ── core 每帧钩子:状态 + 真实音量 + 文字 推给球窗 ──
  function onFrame(vol, frame = {}) {
    if (!active) return;
    const rawSk = frame.status || core.getStatus?.() || 'listening';
    if (BUSY_SK.has(rawSk)) markActive(); // 用户说话/系统繁忙 → 刷新活跃,空闲计时不累积

    // Agent 自判退场:本轮已结束且话已说完(球非繁忙)→ 收起。留 600ms 让 TTS 起播,避免回复前空档误退。
    if (retireArmed && !BUSY_SK.has(rawSk) && Date.now() - retireArmedTs > 600) { dismiss(); return; }

    const speaking = frame.ttsActive || rawSk === 'speaking';
    const level = speaking ? (frame.ttsVol || 0) : (vol || 0);
    let sk = rawSk === 'idle' ? 'listening' : rawSk; // 唤醒球在场即「在听」,静默也显白

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (sk !== lastSk || now - lastFrameTs >= FRAME_MIN_MS) {
      lastSk = sk; lastFrameTs = now;
      orb?.orbFrame({ sk, vol: level });
    }

    // 文字优先级:Agent 活动标签 > 实时识别文字
    const thinking = agentBusy;
    const text = agentBusy ? agentText : (core.getText?.() || '');
    if (text !== lastText || thinking !== lastThinking) {
      lastText = text; lastThinking = thinking;
      orb?.orbText({ text, thinking });
    }
  }

  // ── /events SSE:派生 Agent 在干什么(与 brain-ui 仪表盘同源,只读) ──
  function setupSSE() {
    if (typeof EventSource === 'undefined') return;
    let es;
    const connect = () => {
      try { es = new EventSource('/events'); } catch { return; }
      es.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        onAgentEvent(msg?.type, msg?.data || {});
      };
      es.onerror = () => { try { es.close(); } catch {} setTimeout(connect, 3000); };
    };
    connect();
  }

  function onAgentEvent(type) {
    // 路径跟踪:始终更新,以便对话中途也能正确归类
    if (type === 'message_received') ssePath = 'l1';
    else if (type === 'tick') ssePath = 'l2';
    else if (type === 'scheduled_task') ssePath = 'l3';
    // voice_retire 是显式退场指令,不分路;等本轮说完再真正退(见 onFrame 的 retireArmed)
    if (type === 'voice_retire') { if (active) { retirePending = true; markActive(); } return; }
    if (!active || ssePath !== 'l1') return; // 只反映用户语音对话这一路

    switch (type) {
      case 'message_received':
      case 'stream_start':
        if (!agentBusy || agentText === '') { agentText = '思考中…'; }
        agentBusy = true; markActive();
        break;
      case 'tool_preparing':
      case 'tool_executing':
      case 'tool_call':
        agentText = '调用工具中…'; agentBusy = true; markActive();
        break;
      case 'stream_chunk':
        // Agent 开始吐正文 → 即将/正在说话,文字交回球体语音动画;保持活跃
        agentText = ''; agentBusy = false; markActive();
        break;
      case 'response':
      case 'processing_preempted':
      case 'protocol_violation':
        // 本轮结束。若 Agent 本轮调用过 voice_retire → 武装退场,待这条回复说完(onFrame 判)
        agentText = ''; agentBusy = false; markActive();
        if (retirePending) { retireArmed = true; retireArmedTs = Date.now(); }
        break;
      default:
        break;
    }
  }

  // ── 命中「小白龙」 ──
  async function onHit() {
    if (active) { markActive(); return; } // 已在场:刷新空闲计时,忽略重复唤醒(叠加 800ms 冷却)
    dismissToken++;
    active = true; inConversation = false;
    agentText = ''; agentBusy = false;
    retirePending = false; retireArmed = false;
    lastSk = null; lastText = null; lastThinking = null; lastFrameTs = 0;
    orb?.orbEnter();
    startIdleWatch();
    if (!core.micActive) {
      const stream = await core.startSession();
      if (!stream) { dismiss(); return; }
    }
  }

  // ── 收到转写(interim/final 均算识别到语音) ──
  function onTranscript() {
    if (!active) return;
    inConversation = true;
    markActive(); // 新语音 → 重置 60s 空闲计时
    retirePending = false; retireArmed = false; // 用户又开口 → 取消待退场,继续对话
  }

  // ── 收起:退场动画 + 停会话 ──
  function dismiss() {
    if (!active) return;
    active = false; inConversation = false;
    agentText = ''; agentBusy = false;
    retirePending = false; retireArmed = false;
    stopIdleWatch();
    orb?.orbExit();
    const token = ++dismissToken;
    setTimeout(() => {
      if (token !== dismissToken || active) return;
      if (core.micActive) core.stopSession();
    }, ORB_EXIT_MS);
  }

  orb?.onHit(onHit);
  setupSSE();

  return {
    onFrame,
    onTranscript,
    // 愿景留口(条件一/二):Agent 每轮自判「该退下了」时调用,走同一套退场动画
    requestDismiss: dismiss,
    isActive: () => active,
  };
}
