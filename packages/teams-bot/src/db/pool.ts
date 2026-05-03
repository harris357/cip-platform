// Slice 55: shared pg.Pool for the bot.
//
// Previously each consumer (turn-metrics writer, extractor DB helpers)
// constructed its own pool. Centralized here so connection limits are
// predictable across consumers and so a single env-missing path warns
// once.

import pg from 'pg';

const POOL_URL = process.env['DATABASE_URL_HR'];

let pool: pg.Pool | null = null;

/**
 * Returns the shared pg.Pool, or null if DATABASE_URL_HR isn't set.
 * Callers must handle the null case (typically by logging and falling
 * through to a non-DB code path).
 */
export function getPool(): pg.Pool {
  if (!POOL_URL) {
    throw new Error('[bot/db] DATABASE_URL_HR not set; pool unavailable');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString:  POOL_URL,
      max:               6,         // shared across turn-metrics writes + extractor reads
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/**
 * Returns the pool only if it's available, else null. For best-effort
 * call sites that want to skip when DB isn't configured.
 */
export function tryGetPool(): pg.Pool | null {
  try { return getPool(); } catch { return null; }
}
