import { createSQLiteStore } from '../kernel/sqlite-store.js'
import { paths } from '../paths.js'
import { initializeSchema } from './schema.js'

const store = createSQLiteStore({ filename: paths.dbFile, initialize: initializeSchema })
export const getDB = store.getDB
export const closeDBForTest = store.close
