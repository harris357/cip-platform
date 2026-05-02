// Slice 46e follow-up: tiny Langfuse public-API client used by
// bot_metrics_get_turn to surface trace + session cost on /turn.
//
// All calls best-effort: a 2s timeout, errors return `null` so the
// /turn card simply omits the cost line if Langfuse is unreachable
// or if the model isn't in Langfuse's price registry (in which case
// `totalCost` itself is null even on a 200).
//
// Auth via LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (Basic).
// Host via LANGFUSE_HOST.

const TIMEOUT_MS = 2_000;

function authHeader(): string | null {
  const pk = process.env['LANGFUSE_PUBLIC_KEY'];
  const sk = process.env['LANGFUSE_SECRET_KEY'];
  if (!pk || !sk) return null;
  return 'Basic ' + Buffer.from(`${pk}:${sk}`).toString('base64');
}

function host(): string {
  return process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com';
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const auth = authHeader();
  if (!auth) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, {
      headers: { authorization: auth },
      signal:  ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

export interface TraceCost {
  totalCost: number | null;       // USD, may be null if model isn't priced
  latency:   number | null;        // seconds
}

export async function fetchTraceCost(traceId: string): Promise<TraceCost | null> {
  const url = `${host()}/api/public/traces/${encodeURIComponent(traceId)}`;
  const data = await fetchJson<{ totalCost?: number | null; latency?: number | null }>(url);
  if (!data) return null;
  return {
    totalCost: typeof data.totalCost === 'number' ? data.totalCost : null,
    latency:   typeof data.latency   === 'number' ? data.latency   : null,
  };
}

export interface SessionCost {
  totalCost: number | null;       // sum of trace.totalCost across the session
  traceCount: number;
}

export async function fetchSessionCost(args: {
  sessionId:     string;
  fromTimestamp: string;          // ISO 8601, must be before any trace
  toTimestamp:   string;          // ISO 8601, must be after
}): Promise<SessionCost | null> {
  const query = JSON.stringify({
    view:    'traces',
    dimensions: [],
    metrics: [
      { measure: 'totalCost', aggregation: 'sum'   },
      { measure: 'count',     aggregation: 'count' },
    ],
    filters: [
      { column: 'sessionId', operator: '=', value: args.sessionId, type: 'string' },
    ],
    fromTimestamp: args.fromTimestamp,
    toTimestamp:   args.toTimestamp,
  });
  const url = `${host()}/api/public/metrics?query=${encodeURIComponent(query)}`;
  const data = await fetchJson<{ data?: Array<{ sum_totalCost?: number | null; count_count?: string | number }> }>(url);
  if (!data?.data?.length) return null;
  const row = data.data[0]!;
  return {
    totalCost:  typeof row.sum_totalCost === 'number' ? row.sum_totalCost : null,
    traceCount: typeof row.count_count   === 'string' ? parseInt(row.count_count, 10) : Number(row.count_count ?? 0),
  };
}
