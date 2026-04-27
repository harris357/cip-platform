import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

let _pool: Pool | null = null
let _db: Db | null = null

export function getDb(): Db {
  if (!_db) {
    _pool = new Pool({ connectionString: process.env['DATABASE_URL_HR'] })
    _db = drizzle(_pool, { schema })
  }
  return _db
}
