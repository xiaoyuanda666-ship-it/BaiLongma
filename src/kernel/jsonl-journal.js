import fs from 'node:fs/promises'

// Bounded asynchronous diagnostic storage, supplied to Runtime by composition.
export function createJsonlJournal({ filename, maxBytes = 8 * 1024 * 1024 }) {
  let pending = Promise.resolve()
  return {
    append(value, retained = []) {
      pending = pending.then(async () => {
        const size = await fs.stat(filename).then(s => s.size, () => 0)
        const line = JSON.stringify(value) + '\n'
        if (size + Buffer.byteLength(line) > maxBytes) {
          const records = typeof retained === 'function' ? retained() : retained
          const lines = Buffer.byteLength(line) <= maxBytes ? [line] : []
          let bytes = lines.length ? Buffer.byteLength(line) : 0
          for (let i = records.length - 1; i >= 0; i--) {
            const next = JSON.stringify(records[i]) + '\n'
            if (i === records.length - 1 && next === line) continue
            const nextBytes = Buffer.byteLength(next)
            if (bytes + nextBytes > maxBytes) break
            lines.unshift(next)
            bytes += nextBytes
          }
          await fs.writeFile(filename, lines.join(''))
        } else {
          await fs.appendFile(filename, line)
        }
      }).catch(() => {})
    },
    async readTail(limit = 80) {
      try {
        const handle = await fs.open(filename, 'r')
        try {
          const { size } = await handle.stat()
          const length = Math.min(size, maxBytes + 1024 * 1024)
          const buffer = Buffer.alloc(length)
          await handle.read(buffer, 0, length, size - length)
          return buffer.toString('utf8').split('\n').flatMap(line => {
            try { return [JSON.parse(line)] } catch { return [] }
          }).slice(-limit).reverse()
        } finally { await handle.close() }
      } catch { return [] }
    },
    flush: () => pending,
  }
}
