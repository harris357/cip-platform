// Hotfix (post-Slice 46): the MCP SDK strips non-spec annotation fields
// from `tool.annotations` during `client.listTools()` serialization. The
// bot needs `sideEffectLevel`, `requiredPermission`, `whenToUse`,
// `whenNotToUse`, `commonNextTools`, and `outputSchema` for:
//   - the write-confirm gate (sideEffectLevel)
//   - the permission filter on the bot side (requiredPermission)
//   - the planner's tool-reference block (the rest)
//
// hr-service exposes the full annotation map at /admin/tool-metadata.
// We fetch it once per pod and cache for 5 minutes (annotations are
// static for a given image; the TTL is a defense against stale state
// after a hot redeploy).

const TTL_MS = 5 * 60 * 1000;

let cache: { metadata: Record<string, Record<string, unknown>>; expiresAt: number } | null = null;

/**
 * Fetch the tool annotation map from hr-service. Returns an empty object
 * on any failure — call sites must tolerate missing metadata (the gate
 * was already broken; degrading silently keeps the bot working while
 * surfacing a warning log).
 */
export async function getToolMetadata(): Promise<Record<string, Record<string, unknown>>> {
  if (cache && Date.now() < cache.expiresAt) return cache.metadata;

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[tool-metadata] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — gate degrades');
    return {};
  }

  try {
    const resp = await fetch(`${baseUrl}/admin/tool-metadata`, {
      headers: { 'x-platform-admin-token': token },
    });
    if (!resp.ok) {
      console.warn(`[tool-metadata] HTTP ${resp.status} — gate degrades`);
      return {};
    }
    const body = (await resp.json()) as { tools: Record<string, Record<string, unknown>> };
    cache = { metadata: body.tools, expiresAt: Date.now() + TTL_MS };
    return body.tools;
  } catch (err) {
    console.warn(
      `[tool-metadata] fetch threw: ${err instanceof Error ? err.message : String(err)} — gate degrades`,
    );
    return {};
  }
}

// Test-only.
export function _resetToolMetadataCache(): void {
  cache = null;
}
