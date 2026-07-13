export const STARTUP_SELF_CHECK_VERSION = 'v2'

const STARTUP_SELF_CHECK_CONFIG_KEY = 'l2_startup_self_check'
const AWAKENING_CONFIG_KEY = 'awakening_ticks_remaining'
const EXPLORATION_INDEX_KEY = 'awakening_exploration_index'

// Awakening exploration tasks: after self-check completes, each autonomous heartbeat tick completes one in order.
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
  getConfig,
  setConfig,
  nowTimestamp,
  buildDelegationAskDirections,
} = {}) {
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
      if (!raw) return null
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function writeStartupSelfCheckState(value) {
    setConfig(STARTUP_SELF_CHECK_CONFIG_KEY, JSON.stringify(value))
  }

  function ensureStartupSelfCheckState(state) {
    const current = readStartupSelfCheckState()
    if (current?.version === STARTUP_SELF_CHECK_VERSION && current.status === 'completed') {
      state.startupSelfCheck = { ...current, active: false }
      return state.startupSelfCheck
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
    state.startupSelfCheck = next
    return next
  }

  function buildStartupSelfCheckDirections(checkState) {
    if (!checkState?.active) return ''
    return [
      `This is the L2 startup self-check flow (${STARTUP_SELF_CHECK_VERSION}). It runs once; when finished you must call complete_startup_self_check to record the results — it will not run again.`,
      `[HARD RULE — DO NOT VIOLATE] During self-check, calling send_message is strictly forbidden. No text output of any kind (including "checking…", "self-check complete", or any other text). All status must be expressed through speak (voice) and ui_show (cards). The text channel must remain completely silent; any text output counts as self-check failure.`,
      `Complete the following 3 checks in order. Before each one, you must simultaneously play a Chinese voice announcement and show a progress card. After the check completes, close the card before moving to the next:`,
      `1. Call speak text="正在检查文件读写能力"; call ui_show("SelfCheckStepCard", {step:1, total:3, name:"文件读写", icon:"📁"}) and save the returned id as step_card_id. Then: use write_file to write self_check.txt in the sandbox root (content = current timestamp), then read_file it back to verify consistency. Record the result and call ui_hide(step_card_id).`,
      `2. Call speak text="正在检查热点面板"; call ui_show("SelfCheckStepCard", {step:2, total:3, name:"热点面板", icon:"🌐"}) and save the returned id as step_card_id. Then: hotspot_mode action=show; confirm it returns ok, then hotspot_mode action=hide. Record the result and call ui_hide(step_card_id).`,
      `3. Call speak text="正在检查视频模式"; call ui_show("SelfCheckStepCard", {step:3, total:3, name:"视频模式", icon:"🎬"}) and save the returned id as step_card_id. Then: web_search for "bilibili Iron Man JARVIS" ONCE — this is only a self-check, so take the FIRST BV number that appears in the results and stop immediately; do NOT keep searching for more videos or compare options, one valid BV id is enough. media_mode mode=video action=show url=https://www.bilibili.com/video/<BV> autoplay=true; wait ~5 seconds; media_mode mode=video action=hide. Record the result and call ui_hide(step_card_id).`,
      `Result values: use ok, degraded, error, or skipped_* for each item. Continue to the next item even if one fails.`,
      `[FINAL TWO STEPS — REQUIRED]\n(a) Call ui_show to display SelfCheckCard with props: { results: [{name:"文件读写",status:"ok/error",...},{name:"热点面板",...},{name:"视频模式",...}], overall:"ok/degraded/error" }. Infer overall from actual results: all ok → ok; any skipped → degraded; any error → error.\n(b) Call complete_startup_self_check with a summary (one sentence) and the results object.`,
    ].join('\n')
  }

  return {
    getAwakeningTicks,
    decrementAwakeningTick,
    advanceExplorationTask,
    buildAwakeningExplorationDirections,
    writeStartupSelfCheckState,
    ensureStartupSelfCheckState,
    buildStartupSelfCheckDirections,
  }
}
