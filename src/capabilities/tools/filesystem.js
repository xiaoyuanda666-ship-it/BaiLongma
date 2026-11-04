import { isBundledSkillPath } from '../sandbox.js'
// Compatibility composition for existing tool registries and callers.
import { createFilesystemPort } from '../../kernel/filesystem.js'
import { createFilesystemTools } from '../../runtime/filesystem-tools.js'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath, resolvePathThroughExistingPrefix } from '../sandbox.js'
import * as preview from '../../write-file-preview.js'

export const {
  execListDir, execWriteFile, execEditFile, execDeleteFile, execMakeDir,
} = createFilesystemTools({
  filesystem: createFilesystemPort({ assertAccess: assertInSandbox }),
  sandboxRoot: SANDBOX_ROOT,
  normalizeSandboxPath,
  resolvePathThroughExistingPrefix,
  assertInSandbox,
  preview,
})

function assertReadablePath(filePath) {
  if (isBundledSkillPath(filePath)) return
  assertInSandbox(filePath)
}
export const { execReadFile } = createFilesystemTools({
  filesystem: createFilesystemPort({ assertAccess: assertReadablePath }),
  sandboxRoot: SANDBOX_ROOT,
  normalizeSandboxPath,
  resolvePathThroughExistingPrefix,
  assertInSandbox: assertReadablePath,
  preview,
})
