import path from 'node:path'
import { paths } from '../paths.js'
import { createJsonlJournal } from '../kernel/jsonl-journal.js'

export const performanceJournal = createJsonlJournal({
  filename: path.join(paths.dataDir, 'request-performance.jsonl'),
})
