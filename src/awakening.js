export const STARTUP_SELF_CHECK_VERSION = 'v3'

const STARTUP_SELF_CHECK_CONFIG_KEY = 'l2_startup_self_check'
const AWAKENING_CONFIG_KEY = 'awakening_ticks_remaining'
const EXPLORATION_INDEX_KEY = 'awakening_exploration_index'

const AWAKENING_EXPLORATION_TASKS = [
  `Exploration (1/2): See what you already know.
Go through the injected memories silently and take stock: who do you know, what do you know, are there any threads with no follow-up.
[HARD RULE — DO NOT VIOLATE] During the awakening exploration phase the user has not started a conversation with you yet. Calling send_message to proactively open a topic — including any "casual mention" of memories you uncovered — is forbidden. Record findings only in the AwakeningCard below; do not turn them into outbound messages.
When done, call ui_show("AwakeningCard", { index:1, total:2, title:"Reading memories", finding:"(one sentence: the most notable lead in the memory store, or 'memory store ready')", emoji:"🧠" }).
If later the user opens a conversation and the topic is relevant, you may bring the finding in then — not before.`,
  `Exploration (2/2): Find a forgotten thread.
Look through memories silently — what did the user mention before but never bring up again? A plan, an idea, something they said they wanted to do but never did?
[HARD RULE — DO NOT VIOLATE] Same as Task 1: send_message is forbidden during awakening exploration. Do not "casually bring it up". Do not ask "do you need me to move this forward?". Do not draft an opening line to the user. The thread, if found, lives only in the AwakeningCard finding field; it waits for the user to start the conversation.
When done, call ui_show("AwakeningCard", { index:2, total:2, title:"Unfinished thread", finding:"(one sentence describing the forgotten thread, or 'no open threads found')", emoji:"🔍" }).`,
]

export function createAwakeningManager({
  state: runtimeState = null,
  getConfig,
  setConfig,
  nowTimestamp,
  buildDelegationAskDirections,
  insertMemory,
  clearStickyEvent,
  emitEvent,
} = {}) {
  function requireState(state) {
    const target = state || runtimeState
    if (!target) throw new Error('AwakeningManager requires runtime state')
    return target
  }

  function getAwakeningTicks() {
    const raw = getConfig(AWAKENING_CONFIG_KEY)
    if (raw === null || raw === undefined || raw === '') return 10
    return Math.max(0, parseInt(raw, 10) || 0)
  }

  function decrementAwakeningTick() {
    const current = getAwakeningTicks()
    if (current > 0) setConfig(AWAKENING_CONFIG_KEY, String(current - 1))
  }

  function getExplorationIndex() {
    const raw = getConfig(EXPLORATION_INDEX_KEY)
    if (raw === null || raw === undefined || raw === '') return 0
    return Math.max(0, parseInt(raw, 10) || 0)
  }

  function advanceExplorationTask() {
    const current = getExplorationIndex()
    if (current < AWAKENING_EXPLORATION_TASKS.length) {
      setConfig(EXPLORATION_INDEX_KEY, String(current + 1))
    }
  }

  function buildAwakeningExplorationDirections() {
    if (getAwakeningTicks() <= 0) return null
    const index = getExplorationIndex()
    if (index < AWAKENING_EXPLORATION_TASKS.length) return AWAKENING_EXPLORATION_TASKS[index]
    return buildDelegationAskDirections?.() || null
  }

  function readStartupSelfCheckState() {
    try {
      const raw = getConfig(STARTUP_SELF_CHECK_CONFIG_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function writeStartupSelfCheckState(value) {
    setConfig(STARTUP_SELF_CHECK_CONFIG_KEY, JSON.stringify(value))
  }

  function ensureStartupSelfCheckState(state = runtimeState) {
    const target = requireState(state)
    const current = readStartupSelfCheckState()
    if (current?.version === STARTUP_SELF_CHECK_VERSION && current.status === 'completed') {
      target.startupSelfCheck = { ...current, active: false }
      return target.startupSelfCheck
    }

    const now = nowTimestamp()
    const next = {
      version: STARTUP_SELF_CHECK_VERSION,
      status: 'running',
      started_at: current?.started_at || now,
      updated_at: now,
      attempts: Number(current?.attempts || 0) + (current?.status === 'running' ? 0 : 1),
      results: current?.version === STARTUP_SELF_CHECK_VERSION && current?.results ? current.results : {},
      active: true,
    }
    writeStartupSelfCheckState(next)
    target.startupSelfCheck = next
    return next
  }

  function buildStartupSelfCheckDirections(checkState) {
    if (!checkState?.active) return ''
    return [
      `This is the L2 startup self-check flow (${STARTUP_SELF_CHECK_VERSION}). It runs once. Complete every step in order and then call complete_startup_self_check to persist the actual results.`,
      `[HARD RULE] Do not call send_message and do not emit ordinary assistant text during this flow. Announce status only with speak and ui_set.`,
      `Use one Scene surface throughout: id="self-check", kind="selfcheck". Update that same id for each running step, then morph it to done before removing it.`,
      `1. Call speak text="小白龙已启动，正在检查文件读写能力". Call ui_set({id:"self-check",kind:"selfcheck",intent:"inform",data:{phase:"running",step:1,total:3,name:"文件读写",icon:"📁"}}). Write the current timestamp to self_check.txt in the sandbox root using write_file, then use read_file to read it back and verify the content. Record ok, degraded, or error from the tool evidence.`,
      `2. Call speak text="正在检查热点面板". Call ui_set({id:"self-check",kind:"selfcheck",intent:"inform",data:{phase:"running",step:2,total:3,name:"热点面板",icon:"🌐"}}). Call hotspot_mode action="show", verify its response, then call hotspot_mode action="hide". Record the actual result.`,
      `3. Call speak text="正在检查视频模式". Call ui_set({id:"self-check",kind:"selfcheck",intent:"inform",data:{phase:"running",step:3,total:3,name:"视频模式",icon:"🎬"}}). Call web_search once for "bilibili Iron Man JARVIS". Use the first returned Bilibili BV URL only; do not guess a URL or keep searching. Call media_mode with mode="video", action="show", that URL, and autoplay=true; wait about five seconds, then call media_mode with mode="video", action="hide". Record the actual result.`,
      `Continue even if a step fails. Then call ui_set({id:"self-check",kind:"selfcheck",intent:"inform",data:{phase:"done",results:[{name:"文件读写",status:"ok/error/skipped",note:"..."},{name:"热点面板",status:"ok/error/skipped",note:"..."},{name:"视频模式",status:"ok/error/skipped",note:"..."}],overall:"ok/degraded/error"}}), replacing the placeholder values with the actual outcomes. Call complete_startup_self_check with the same evidence-based result map, then call ui_set with id="self-check" and remove=true.`,
    ].join('\n')
  }

  function completeStartupSelfCheck({ summary = '', results = {} } = {}, state = runtimeState) {
    const target = requireState(state)
    const now = nowTimestamp()
    const completed = {
      version: STARTUP_SELF_CHECK_VERSION,
      status: 'completed',
      started_at: target.startupSelfCheck?.started_at || now,
      completed_at: now,
      updated_at: now,
      results,
      summary,
    }
    writeStartupSelfCheckState(completed)
    target.startupSelfCheck = { ...completed, active: false }
    insertMemory?.({
      mem_id: `system_l2_startup_self_check_${STARTUP_SELF_CHECK_VERSION}`,
      type: 'system',
      title: `L2 startup self-check ${STARTUP_SELF_CHECK_VERSION}`,
      content: `L2 startup self-check completed: ${summary || 'no summary'}`,
      detail: JSON.stringify({ summary, results }, null, 2),
      tags: ['system', 'l2', 'startup_self_check', STARTUP_SELF_CHECK_VERSION],
      entities: [],
      timestamp: now,
    })
    clearStickyEvent?.('startup_self_check_started')
    emitEvent?.('startup_self_check_completed', completed)
    return completed
  }

  return {
    version: STARTUP_SELF_CHECK_VERSION,
    getAwakeningTicks,
    decrementAwakeningTick,
    advanceExplorationTask,
    buildAwakeningExplorationDirections,
    writeStartupSelfCheckState,
    ensureStartupSelfCheckState,
    buildStartupSelfCheckDirections,
    completeStartupSelfCheck,
  }
}
