import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath, resolvePathThroughExistingPrefix } from '../sandbox.js'
import {
  beginEditFileExecutionPreview,
  finishEditFileExecutionPreview,
  streamWriteFileExecutionPreview,
} from '../../write-file-preview.js'

const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function sha256(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex')
}

function readUtf8Strict(filePath) {
  const buffer = fs.readFileSync(filePath)
  try {
    // Validate without using TextDecoder's output so an existing UTF-8 BOM is
    // retained by Buffer.toString and survives a local edit unchanged.
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
  return buffer.toString('utf8')
}

function fileError(tool, pathValue, code, error, extra = {}) {
  return toolJson({
    ok: false,
    tool,
    path: pathValue,
    code,
    error,
    ...extra,
  })
}

function existingFileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777
  } catch {
    return 0o666
  }
}

// Write through a sibling temporary file so readers never observe a half-written
// document. For create-only writes, link(2) provides an atomic "fail if exists"
// boundary instead of doing a racy existsSync + rename pair.
function atomicWriteUtf8(filePath, content, { failIfExists = false } = {}) {
  const body = String(content)
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  )
  let fd = null
  try {
    fd = fs.openSync(tempPath, 'wx', existingFileMode(filePath))
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null

    if (failIfExists) {
      fs.linkSync(tempPath, filePath)
    } else {
      fs.renameSync(tempPath, filePath)
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
    try { fs.unlinkSync(tempPath) } catch {}
  }
}

function normalizedExpectedSha(value) {
  if (value === undefined || value === null || value === '') return ''
  const normalized = String(value).trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function assertExpectedSha(tool, filePath, displayPath, currentContent, expectedValue) {
  const expected = normalizedExpectedSha(expectedValue)
  if (expected === '') return ''
  if (expected === null) {
    return fileError(tool, displayPath, 'INVALID_EXPECTED_SHA256', 'expected_sha256 must be a 64-character hexadecimal SHA-256 digest')
  }
  if (!fs.existsSync(filePath)) {
    return fileError(tool, displayPath, 'FILE_NOT_FOUND', 'cannot check expected_sha256 because the file does not exist')
  }
  const actual = sha256(currentContent)
  if (actual !== expected) {
    return fileError(tool, displayPath, 'CONTENT_CHANGED', 'the file changed since it was read; read it again before editing', {
      expected_sha256: expected,
      actual_sha256: actual,
    })
  }
  return ''
}

function lineStarts(content) {
  const starts = [0]
  const re = /\r\n|\n|\r/g
  let match
  while ((match = re.exec(content)) !== null) starts.push(match.index + match[0].length)
  return starts
}

function dominantLineEnding(content) {
  const match = String(content).match(/\r\n|\n|\r/)
  return match?.[0] || '\n'
}

function replaceLineRange(content, startLine, endLine, replacement) {
  const starts = lineStarts(content)
  const totalLines = starts.length
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { error: 'start_line and end_line must be positive integers, with end_line >= start_line', totalLines }
  }
  if (startLine > totalLines || endLine > totalLines) {
    return { error: `line range ${startLine}-${endLine} is outside the file (total lines: ${totalLines})`, totalLines }
  }

  const startOffset = starts[startLine - 1]
  const endOffset = endLine < totalLines ? starts[endLine] : content.length
  let body = String(replacement)
  // A line-range replacement describes logical lines. Preserve the file's
  // existing separator at the right boundary unless the replacement is empty.
  if (body && endLine < totalLines && !/(?:\r\n|\n|\r)$/.test(body)) {
    body += dominantLineEnding(content)
  }
  return {
    content: content.slice(0, startOffset) + body + content.slice(endOffset),
    totalLines,
  }
}

export async function execReadFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  const content = fs.readFileSync(resolved, 'utf-8')
  const hasRange = args.start_line !== undefined || args.end_line !== undefined || args.max_lines !== undefined
  const includeMetadata = args.include_metadata === true
  if (!hasRange && !includeMetadata) return content

  const starts = lineStarts(content)
  const totalLines = starts.length
  const start = Math.max(1, parseInt(args.start_line ?? 1, 10) || 1)
  const maxLines = args.max_lines !== undefined
    ? Math.max(0, parseInt(args.max_lines, 10) || 0)
    : null
  const requestedEnd = args.end_line !== undefined
    ? Math.max(start, parseInt(args.end_line, 10) || start)
    : null
  const end = maxLines !== null
    ? Math.min(totalLines, start + maxLines - 1)
    : Math.min(totalLines, requestedEnd ?? totalLines)
  let selectedContent = ''
  if (!hasRange) {
    selectedContent = content
  } else if (maxLines !== 0 && start <= totalLines && end >= start) {
    const startOffset = starts[start - 1]
    let endOffset = end < totalLines ? starts[end] : content.length
    if (end < totalLines) {
      const separator = content.slice(0, endOffset).match(/(?:\r\n|\n|\r)$/)?.[0] || ''
      endOffset -= separator.length
    }
    selectedContent = content.slice(startOffset, endOffset)
  }
  return toolJson({
    ok: true,
    tool: 'read_file',
    path: filePath,
    absolute_path: resolved,
    start_line: start,
    end_line: end,
    total_lines: totalLines,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
    truncated: end < totalLines || start > 1,
    content: selectedContent,
  })
}

export async function execListDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory || '.'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const result = entries.map(e => {
    const type = e.isDirectory() ? '[目录]' : '[文件]'
    return `${type} ${e.name}`
  }).join('\n')
  const relDisplay = dirPath === '.' ? '.' : dirPath.replace(/\\/g, '/')
  return `目录（相对路径）：${relDisplay}\n\n${result || '（空目录）'}`
}

export async function execWriteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  const content = args.content ?? args.text ?? args.data
  if (!rawPath) return '错误：未提供文件路径'
  if (content === undefined) return '错误：未提供写入内容'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可修改`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  const writeTarget = resolvePathThroughExistingPrefix(resolved)
  if (PROTECTED_FILES.has(path.basename(writeTarget).toLowerCase())) {
    return `错误：${path.basename(writeTarget)} 是系统文件，不可修改`
  }
  fs.mkdirSync(path.dirname(writeTarget), { recursive: true })
  // Omission must be safe: creating a new file is common, while replacing an
  // existing whole file is destructive and must be an explicit model choice.
  const ifExists = String(args.if_exists || 'error').trim().toLowerCase()
  if (!['overwrite', 'error'].includes(ifExists)) {
    return fileError('write_file', filePath, 'INVALID_IF_EXISTS', 'if_exists must be "overwrite" or "error"')
  }
  const existed = fs.existsSync(writeTarget)
  if (ifExists === 'error' && existed) {
    return fileError('write_file', filePath, 'FILE_EXISTS', 'the file already exists; use edit_file to modify it or set if_exists="overwrite" explicitly')
  }
  const previousContent = existed ? fs.readFileSync(writeTarget, 'utf8') : ''
  const expectedError = assertExpectedSha('write_file', writeTarget, filePath, previousContent, args.expected_sha256)
  if (expectedError) return expectedError

  streamWriteFileExecutionPreview({ path: filePath, content })
  try {
    atomicWriteUtf8(writeTarget, content, { failIfExists: ifExists === 'error' })
  } catch (err) {
    streamWriteFileExecutionPreview({ path: filePath, content, verified: false })
    if (ifExists === 'error' && err?.code === 'EEXIST') {
      return fileError('write_file', filePath, 'FILE_EXISTS', 'the file was created by another process before this write completed')
    }
    throw err
  }
  const verifiedContent = fs.readFileSync(writeTarget, 'utf-8')
  const verified = verifiedContent === String(content)
  const bytes = Buffer.byteLength(verifiedContent, 'utf-8')
  streamWriteFileExecutionPreview({ path: filePath, content, bytes, verified })
  if (!verified) {
    return toolJson({
      ok: false,
      tool: 'write_file',
      path: filePath,
      absolute_path: writeTarget,
      bytes,
      verified: false,
      error: 'read-back verification did not match written content',
    })
  }
  return toolJson({
    ok: true,
    tool: 'write_file',
    path: filePath,
    absolute_path: writeTarget,
    bytes,
    created: !existed,
    sha256: sha256(verifiedContent),
    verified: true,
    content_preview: verifiedContent.slice(0, 120),
  })
}

export async function execEditFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return fileError('edit_file', '', 'PATH_REQUIRED', 'no file path was provided')
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return fileError('edit_file', filePath, 'PROTECTED_FILE', `${path.basename(filePath)} is a protected system file`)
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  const writeTarget = resolvePathThroughExistingPrefix(resolved)
  if (PROTECTED_FILES.has(path.basename(writeTarget).toLowerCase())) {
    return fileError('edit_file', filePath, 'PROTECTED_FILE', `${path.basename(writeTarget)} is a protected system file`)
  }
  if (!fs.existsSync(writeTarget)) {
    return fileError('edit_file', filePath, 'FILE_NOT_FOUND', 'the file does not exist; use write_file to create it')
  }
  if (!fs.statSync(writeTarget).isFile()) {
    return fileError('edit_file', filePath, 'NOT_A_FILE', 'the path is not a regular file')
  }

  const before = readUtf8Strict(writeTarget)
  if (before === null) {
    return fileError('edit_file', filePath, 'INVALID_UTF8', 'edit_file only supports valid UTF-8 text files and will not rewrite binary or differently encoded data')
  }
  const beforeSha = sha256(before)
  const expectedError = assertExpectedSha('edit_file', writeTarget, filePath, before, args.expected_sha256)
  if (expectedError) return expectedError

  const operation = String(args.operation || 'replace').trim().toLowerCase()
  let after = before
  let replacements = 0
  let editedRange = null

  if (operation === 'replace') {
    if (args.old_text === undefined || args.new_text === undefined) {
      return fileError('edit_file', filePath, 'CONTENT_REQUIRED', 'replace requires both old_text and new_text (new_text may be empty to delete)')
    }
    const oldText = String(args.old_text)
    const newText = String(args.new_text)
    if (!oldText) return fileError('edit_file', filePath, 'EMPTY_OLD_TEXT', 'old_text must not be empty')

    let cursor = 0
    while ((cursor = before.indexOf(oldText, cursor)) !== -1) {
      replacements += 1
      cursor += oldText.length
    }
    if (replacements === 0) {
      return fileError('edit_file', filePath, 'TEXT_NOT_FOUND', 'old_text was not found; read the current file and copy the target text exactly', {
        sha256: beforeSha,
      })
    }
    if (replacements > 1 && args.replace_all !== true) {
      return fileError('edit_file', filePath, 'AMBIGUOUS_MATCH', `old_text occurs ${replacements} times; include more surrounding text or set replace_all=true`, {
        matches: replacements,
        sha256: beforeSha,
      })
    }
    after = args.replace_all === true
      ? before.split(oldText).join(newText)
      : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length)
    if (args.replace_all !== true) replacements = 1
  } else if (operation === 'replace_lines') {
    if (args.content === undefined) {
      return fileError('edit_file', filePath, 'CONTENT_REQUIRED', 'replace_lines requires content (it may be empty to delete the selected lines)')
    }
    const startLine = Number(args.start_line)
    const endLine = args.end_line === undefined ? startLine : Number(args.end_line)
    const outcome = replaceLineRange(before, startLine, endLine, args.content)
    if (outcome.error) {
      return fileError('edit_file', filePath, 'INVALID_LINE_RANGE', outcome.error, { total_lines: outcome.totalLines })
    }
    after = outcome.content
    editedRange = { start_line: startLine, end_line: endLine }
  } else if (operation === 'append') {
    if (args.content === undefined) return fileError('edit_file', filePath, 'CONTENT_REQUIRED', 'append requires content')
    after = before + String(args.content)
  } else if (operation === 'prepend') {
    if (args.content === undefined) return fileError('edit_file', filePath, 'CONTENT_REQUIRED', 'prepend requires content')
    after = String(args.content) + before
  } else {
    return fileError('edit_file', filePath, 'INVALID_OPERATION', 'operation must be replace, replace_lines, append, or prepend')
  }

  if (after === before) {
    return toolJson({
      ok: true,
      tool: 'edit_file',
      path: filePath,
      absolute_path: writeTarget,
      operation,
      changed: false,
      verified: true,
      bytes_before: Buffer.byteLength(before, 'utf8'),
      bytes_after: Buffer.byteLength(after, 'utf8'),
      sha256_before: beforeSha,
      sha256_after: beforeSha,
    })
  }

  // Re-check immediately before committing to narrow the window for concurrent
  // writers even when the caller did not provide an explicit expected hash.
  const latest = fs.readFileSync(writeTarget, 'utf8')
  if (sha256(latest) !== beforeSha) {
    return fileError('edit_file', filePath, 'CONTENT_CHANGED', 'the file changed while the edit was being prepared; read it again and retry', {
      expected_sha256: beforeSha,
      actual_sha256: sha256(latest),
    })
  }

  beginEditFileExecutionPreview({ path: filePath, content: before })
  let verifiedContent
  try {
    atomicWriteUtf8(writeTarget, after)
    verifiedContent = fs.readFileSync(writeTarget, 'utf8')
  } catch (err) {
    let visibleContent = before
    try { visibleContent = fs.readFileSync(writeTarget, 'utf8') } catch {}
    finishEditFileExecutionPreview({ path: filePath, content: visibleContent, verified: false })
    throw err
  }
  const verified = verifiedContent === after
  const afterSha = sha256(verifiedContent)
  const bytesAfter = Buffer.byteLength(verifiedContent, 'utf8')
  finishEditFileExecutionPreview({
    path: filePath,
    content: verifiedContent,
    bytes: bytesAfter,
    verified,
  })
  if (!verified) {
    return fileError('edit_file', filePath, 'VERIFY_FAILED', 'read-back verification did not match the edited content', {
      absolute_path: writeTarget,
      verified: false,
      sha256_before: beforeSha,
      sha256_after: afterSha,
    })
  }

  return toolJson({
    ok: true,
    tool: 'edit_file',
    path: filePath,
    absolute_path: writeTarget,
    operation,
    changed: true,
    replacements: operation === 'replace' ? replacements : undefined,
    ...(editedRange || {}),
    bytes_before: Buffer.byteLength(before, 'utf8'),
    bytes_after: bytesAfter,
    sha256_before: beforeSha,
    sha256_after: afterSha,
    verified: true,
  })
}

export async function execDeleteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供路径'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可删除`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  if (!fs.existsSync(resolved)) return `错误：路径不存在：${filePath}`
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true })
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'directory',
      verified_absent: verifiedAbsent,
    })
  } else {
    fs.unlinkSync(resolved)
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'file',
      verified_absent: verifiedAbsent,
    })
  }
}

export async function execMakeDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  const verified = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  return toolJson({
    ok: verified,
    tool: 'make_dir',
    path: dirPath,
    absolute_path: resolved,
    verified,
  })
}
