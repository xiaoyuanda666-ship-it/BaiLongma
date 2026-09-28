import { eventJournal } from '../composition/event-services.js'
import { createSSEEvents } from './sse-events.js'

export const { addSSEClient, removeSSEClient, flushStickyEvents, flushEventsSince, getLatestEventId } = createSSEEvents(eventJournal)
