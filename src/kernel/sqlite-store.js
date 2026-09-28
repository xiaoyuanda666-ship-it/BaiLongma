import Database from 'better-sqlite3'

// Kernel owns connection lifetime; Runtime supplies its schema and repositories.
export function createSQLiteStore({ filename, initialize, DatabaseImpl = Database }) {
  let db = null
  return {
    getDB() {
      if (db) return db
      const connection = new DatabaseImpl(filename)
      try {
        connection.pragma('journal_mode = WAL')
        initialize(connection)
        db = connection
        return db
      } catch (error) {
        connection.close()
        throw error
      }
    },
    close() {
      if (!db) return
      db.close()
      db = null
    },
  }
}
