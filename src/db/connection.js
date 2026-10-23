import { createSQLiteStore } from '../kernel/sqlite-store.js'
import { paths } from '../paths.js'
import { initializeSchema } from './schema.js'
import { instrumentSQLiteDatabase } from '../runtime/sqlite-performance.js'

const store = createSQLiteStore({ filename: paths.dbFile, initialize: initializeSchema })
export const getDB = () => instrumentSQLiteDatabase(store.getDB())
export const closeDBForTest = store.close
