// Shared process-wide services. This composition root has no UI/HTTP dependency.
import { insertBrainUiEvent } from '../db.js'
import { createEventJournal } from '../kernel/event-journal.js'
import { createRuntimeEventService } from '../runtime/event-service.js'

export const eventJournal = createEventJournal()
export const runtimeEvents = createRuntimeEventService({ journal: eventJournal, insertBrainUiEvent })
