// Legacy singleton adapter; new isolated runtimes can inject createRuntimeEventService.
import { runtimeEvents } from '../composition/event-services.js'

export const { emitEvent, setStickyEvent, clearStickyEvent } = runtimeEvents
