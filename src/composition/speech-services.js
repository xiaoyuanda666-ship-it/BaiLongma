import { createFilesystemPort } from '../kernel/filesystem.js'
import { createSpeechExpression } from '../runtime/speech-expression.js'
import { assertInSandbox, SANDBOX_ROOT } from '../capabilities/sandbox.js'

export const prepareSpeechExpression = createSpeechExpression({
  filesystem: createFilesystemPort({ assertAccess: assertInSandbox }),
  sandboxRoot: SANDBOX_ROOT,
})
