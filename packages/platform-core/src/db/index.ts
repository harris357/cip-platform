import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

// Slice 62: platform-core db pool + drizzle client.
// Pool is exported but unused in slice 62 — slice 63 is the first
// consumer. Initialization is lazy so tests / scripts that don't
// touch the DB don't require DATABASE_URL_PLATFORM.

// Use the bare NodePgDatabase type so that both top-level db handles
// AND inner transaction handles satisfy `Db` in query function signatures.
export type Db = NodePgDatabase<typeof schema>

let _pool: Pool | null = null
let _db: Db | null = null

export function getPool(): Pool {
  if (!_pool) {
    const url = process.env['DATABASE_URL_PLATFORM']
    if (!url) throw new Error('DATABASE_URL_PLATFORM is required')
    _pool = new Pool({ connectionString: url })
  }
  return _pool
}

export function getDb(): Db {
  if (!_db) {
    _db = drizzle(getPool(), { schema })
  }
  return _db
}
