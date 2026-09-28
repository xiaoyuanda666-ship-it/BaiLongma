// Compatibility API. Backend code imports runtime/events.js to avoid loading UI.
export { emitEvent, setStickyEvent, clearStickyEvent } from './runtime/events.js'
export { addSSEClient, removeSSEClient, flushStickyEvents, flushEventsSince, getLatestEventId } from './app/event-stream.js'
