// Slice 58A — migration runner. Idempotent via schema_migrations
// bookkeeping. Same pattern as packages/hr-service/src/db/migrate.ts.
// The init container in helm/templates/deployment.yaml calls
// `node dist/db/migrate.js` before the main container starts.

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_DOCS']
  if (!url) throw new Error('DATABASE_URL_DOCS is required')

  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    // Bootstrap the tracking table in cip_documents (created by 001).
    // First migration creates the schema, so on the very first run we
    // bootstrap the tracking table in public temporarily, then 001
    // creates the schema, then we re-target.  Simplest path: keep
    // tracking in public — no risk of cross-tenant leakage since
    // schema_migrations is platform-level state.
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_service_schema_migrations (
        migration   TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const allFiles = await readdir(MIGRATIONS_DIR)
    const sqlFiles = allFiles.filter((f) => f.endsWith('.sql')).sort()

    const { rows } = await client.query<{ migration: string }>(
      'SELECT migration FROM doc_service_schema_migrations',
    )
    const applied = new Set(rows.map((r) => r.migration))

    for (const file of sqlFiles) {
      if (applied.has(file)) {
        console.log(`[skip]  ${file}`)
        continue
      }

      console.log(`[apply] ${file}`)
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8')

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO doc_service_schema_migrations (migration) VALUES ($1)',
          [file],
        )
        await client.query('COMMIT')
        console.log(`[done]  ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${String(err)}`)
      }
    }

    console.log('All doc-service migrations applied.')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
