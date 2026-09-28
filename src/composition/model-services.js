import { config } from '../config.js'
import { createModelTransport } from '../kernel/model-transport.js'
import { createModelConnection } from '../runtime/model-connection.js'

const modelConnection = createModelConnection({ readConfig: () => config, transport: createModelTransport() })
export const openModelStream = request => modelConnection.openStream(request)
