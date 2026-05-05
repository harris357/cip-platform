import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

let _pool: Pool | null = null
let _db: Db | null = null

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env['DATABASE_URL_DOCS'],
      // search_path puts cip_documents first so unqualified table names
      // resolve there; cip_hr second so we can read permission_catalog
      // for the seed migration without schema prefixes.
      options: '-c search_path=cip_documents,public',
    })
  }
  return _pool
}

export function getDb(): Db {
  if (!_db) {
    _db = drizzle(getPool(), { schema })
  }
  return _db
}
