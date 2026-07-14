import assert from 'assert'
import { formatTerminalStreamContext, getTerminalStreamSnapshot, recordTerminalStreamEvent } from './terminal-stream.js'
import {
  extractFileWriteArgs,
  extractPartialJsonStringValue,
  streamXmlFileWriteArgumentPreview,
  streamToolFileWriteExecutionPreview,
  streamWriteFileArgumentPreview,
  streamWriteFileExecutionPreview,
} from './write-file-preview.js'

function contentOf(source) {
  return extractPartialJsonStringValue(source, ['content'])
}

globalThis.__JARVIS_WRITE_PREVIEW_AUTO_CLOSE_MS = 0

{
  const partial = contentOf('{"path":"demo.md","content":"Hello\\nWor')
  assert.strictEqual(partial.value, 'Hello\nWor')
  assert.strictEqual(partial.closed, false)

  const complete = contentOf('{"path":"demo.md","content":"Hello\\nWorld"}')
  assert.strictEqual(complete.value, 'Hello\nWorld')
  assert.strictEqual(complete.closed, true)
}

{
  const incompleteEscape = contentOf('{"content":"A\\')
  assert.strictEqual(incompleteEscape.value, 'A')
  assert.strictEqual(incompleteEscape.closed, false)

  const completeEscape = contentOf('{"content":"A\\tB"}')
  assert.strictEqual(completeEscape.value, 'A\tB')
  assert.strictEqual(completeEscape.closed, true)
}

{
  const splitSurrogate = contentOf('{"content":"A\\ud83d')
  assert.strictEqual(splitSurrogate.value, 'A')
  assert.strictEqual(splitSurrogate.closed, false)

  const completeSurrogate = contentOf('{"content":"A\\ud83d\\ude00B"}')
  assert.strictEqual(completeSurrogate.value, 'A😀B')
}

{
  let state = {}
  state = streamWriteFileArgumentPreview({
    name: 'write_file',
    arguments: '{"path":"demo.md","content":"One',
  }, state)
  state = streamWriteFileArgumentPreview({
    name: 'write_file',
    arguments: '{"path":"demo.md","content":"One\\nTwo"}',
  }, state)
  const snapshot = getTerminalStreamSnapshot('write_file')
  const text = snapshot.chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ write_file demo.md\n\nOne\nTwo')
  assert.strictEqual(snapshot.format, 'markdown')
  assert.strictEqual(snapshot.artifact_kind, 'article')
  assert.strictEqual(snapshot.artifact_path, 'demo.md')
  assert.strictEqual(snapshot.hold_open, true)

  recordTerminalStreamEvent({ action: 'close', stream_id: 'write_file', force: 'false' })
  assert.strictEqual(getTerminalStreamSnapshot('write_file').closed, false)
  recordTerminalStreamEvent({ action: 'close', stream_id: 'write_file', force: 'true' })
  assert.strictEqual(getTerminalStreamSnapshot('write_file').closed, true)
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'reset' })
  const reset = getTerminalStreamSnapshot('write_file')
  assert.strictEqual(reset.format, 'plain')
  assert.strictEqual(reset.artifact_kind, '')
  assert.strictEqual(reset.artifact_path, '')
  assert.strictEqual(reset.hold_open, false)
}

{
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'fallback' })
  streamWriteFileExecutionPreview({ path: 'fallback.md', content: 'abc' })
  streamWriteFileExecutionPreview({ path: 'fallback.md', content: 'abc', bytes: 3, verified: true })
  const text = getTerminalStreamSnapshot('write_file').chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ write_file fallback.md\n\nabc\n\n[write_file done, 3 bytes]\n')
}

{
  let state = {}
  state = streamWriteFileArgumentPreview({
    name: 'save_markdown_file',
    arguments: '{"output_path":"note.md","markdown":"Alpha',
  }, state)
  state = streamWriteFileArgumentPreview({
    name: 'save_markdown_file',
    arguments: '{"output_path":"note.md","markdown":"Alpha\\nBeta"}',
  }, state)
  const text = getTerminalStreamSnapshot('write_file').chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ save_markdown_file note.md\n\nAlpha\nBeta')
}

{
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'guard' })
  streamWriteFileArgumentPreview({
    name: 'send_message',
    arguments: '{"target_id":"ID:1","content":"do not show"}',
  }, {})
  const text = getTerminalStreamSnapshot('write_file').chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '')
}

{
  const extracted = extractFileWriteArgs('create_article_file', {
    output_path: 'article.md',
    article: 'Body',
  })
  assert.deepStrictEqual(extracted, {
    toolName: 'create_article_file',
    path: 'article.md',
    content: 'Body',
  })

  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'installed' })
  streamToolFileWriteExecutionPreview('create_article_file', { output_path: 'article.md', article: 'Body' })
  streamToolFileWriteExecutionPreview('create_article_file', { output_path: 'article.md', article: 'Body' }, { bytes: 4, verified: true })
  const snapshot = getTerminalStreamSnapshot('write_file')
  const text = snapshot.chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ create_article_file article.md\n\nBody\n\n[create_article_file done, 4 bytes]\n')
  assert.strictEqual(snapshot.format, 'markdown')
  assert.strictEqual(snapshot.hold_open, true)
}

{
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'xml' })
  const session = { cleared: false }
  let state = { session }
  state = streamXmlFileWriteArgumentPreview('<invoke name="save_markdown_file"><parameter name="output_path">xml.md</parameter><parameter name="markdown">A&amp;', state)
  state = streamXmlFileWriteArgumentPreview('<invoke name="save_markdown_file"><parameter name="output_path">xml.md</parameter><parameter name="markdown">A&amp;B&lt;C</parameter>', state)
  const snapshot = getTerminalStreamSnapshot('write_file')
  const text = snapshot.chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ save_markdown_file xml.md\n\nA&B<C')
  assert.strictEqual(snapshot.format, 'markdown')
  assert.strictEqual(snapshot.hold_open, true)
}

{
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'article-ish path' })
  streamWriteFileExecutionPreview({ path: 'weekly-report.txt', content: '# Weekly Report\n\nBody' })
  const snapshot = getTerminalStreamSnapshot('write_file')
  assert.strictEqual(snapshot.format, 'markdown')
  assert.strictEqual(snapshot.artifact_kind, 'article')
  assert.strictEqual(snapshot.artifact_path, 'weekly-report.txt')
  assert.strictEqual(snapshot.hold_open, true)
}

{
  recordTerminalStreamEvent({
    action: 'clear',
    stream_id: 'write_file',
    title: 'Writing diary.md',
    format: 'markdown',
    artifact_kind: 'article',
    artifact_path: 'diary.md',
    hold_open: true,
  })
  recordTerminalStreamEvent({ action: 'write', stream_id: 'write_file', text: '# Diary\n\nBody' })
  const previousReader = globalThis.getJarvisWindowLayoutSnapshot
  globalThis.getJarvisWindowLayoutSnapshot = () => ({
    displays: [],
    windows: [
      {
        kind: 'terminal_stream',
        terminal_stream_id: 'write_file',
        title: 'Writing diary.md',
        visible: true,
        focused: false,
        minimized: false,
        bounds: { x: 1300, y: 60, width: 560, height: 830 },
      },
    ],
  })
  const context = formatTerminalStreamContext()
  assert.match(context, /visible_window: yes/)
  assert.match(context, /window_stream_id: write_file/)
  assert.match(context, /artifact_path=diary\.md/)
  assert.match(context, /force=true/)
  assert.match(context, /Do not tell the user no preview window exists/)
  globalThis.getJarvisWindowLayoutSnapshot = () => ({ displays: [], windows: [] })
  assert.match(formatTerminalStreamContext(), /visible_window: no/)
  if (previousReader) {
    globalThis.getJarvisWindowLayoutSnapshot = previousReader
  } else {
    delete globalThis.getJarvisWindowLayoutSnapshot
  }
}

{
  recordTerminalStreamEvent({ action: 'clear', stream_id: 'write_file', title: 'code' })
  streamWriteFileExecutionPreview({ path: 'color.json', content: '{"color":"#00ff00"}' })
  streamWriteFileExecutionPreview({ path: 'color.json', content: '{"color":"#00ff00"}', bytes: 19, verified: true })
  const snapshot = getTerminalStreamSnapshot('write_file')
  const text = snapshot.chunks.map(chunk => chunk.text).join('')
  assert.strictEqual(text, '$ write_file color.json\n\n{"color":"#00ff00"}\n\n[write_file done, 19 bytes]\n')
  assert.strictEqual(snapshot.format, 'code')
  assert.strictEqual(snapshot.artifact_kind, 'code')
  assert.strictEqual(snapshot.artifact_path, 'color.json')
  assert.strictEqual(snapshot.hold_open, false)

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.strictEqual(getTerminalStreamSnapshot('write_file').closed, true)
}

delete globalThis.__JARVIS_WRITE_PREVIEW_AUTO_CLOSE_MS

console.log('test-write-file-preview passed')
