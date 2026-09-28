// Compatibility composition for existing tool registries and callers.
import { createFilesystemPort } from '../../kernel/filesystem.js'
import { createFilesystemTools } from '../../runtime/filesystem-tools.js'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath, resolvePathThroughExistingPrefix } from '../sandbox.js'
import * as preview from '../../write-file-preview.js'

export const {
  execReadFile, execListDir, execWriteFile, execEditFile, execDeleteFile, execMakeDir,
} = createFilesystemTools({
  filesystem: createFilesystemPort({ assertAccess: assertInSandbox }),
  sandboxRoot: SANDBOX_ROOT,
  normalizeSandboxPath,
  resolvePathThroughExistingPrefix,
  assertInSandbox,
  preview,
})
