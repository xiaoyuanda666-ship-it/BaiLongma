const EDIT_FOLLOWUP_RE = /(?:(?:把|将|再|顺便).{0,50}(?:改成|换成|加上|加一句|删掉|去掉|追加|修改|编辑)|(?:其他|其它|其余).{0,6}(?:别动|不动|不要改))/i
// Extension words such as “JSON 回显” are page content, not file evidence.
const FILE_CONTEXT_RE = /(?:\b(?:read_file|write_file|edit_file|absolute_path|artifact_path)\b|(?:^|[\\/\s"'])[^\\/\s"']+\.(?:md|markdown|txt|json|js|mjs|cjs|ts|tsx|jsx|py|html?|css|vue|svelte)(?:\b|["']))/i
const EXPLICIT_BROWSER_TASK_RE = /(?:\bbrowser_[a-z_]+\b|https?:\/\/|浏览器|输入框|表单|搜索框)/i

function hasFileEvidence(text = '') {
  // An online .html URL alone does not establish a local editable artifact.
  return FILE_CONTEXT_RE.test(String(text).replace(/https?:\/\/[^\s，。！？；]+/giu, ''))
}

export function isFileEditFollowup(text = '', { conversationWindow = [], runtimeContext = '' } = {}) {
  if (!EDIT_FOLLOWUP_RE.test(text) || EXPLICIT_BROWSER_TASK_RE.test(text)) return false
  return (Array.isArray(conversationWindow)
    && conversationWindow.slice(-6).some(item => hasFileEvidence(item?.content || '')))
    || hasFileEvidence(runtimeContext)
}
