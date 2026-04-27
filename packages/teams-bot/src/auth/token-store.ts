// In-memory SSO token cache: userId → { keycloakJwt, expiresAt }
// Tokens are stored after signin/tokenExchange and retrieved on every message.
// TTL matches Keycloak access token lifetime (default: 5 minutes).
// In a multi-replica deployment, replace with Redis; in-memory is fine for now.

interface TokenEntry {
  keycloakJwt: string;
  expiresAt: number; // Date.now() + TTL
}

const TOKEN_TTL_MS = 5 * 60 * 1000;
const store = new Map<string, TokenEntry>();

export function cacheToken(userId: string, keycloakJwt: string): void {
  store.set(userId, { keycloakJwt, expiresAt: Date.now() + TOKEN_TTL_MS });
}

export function getCachedToken(userId: string): string | null {
  const entry = store.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    store.delete(userId);
    return null;
  }
  return entry.keycloakJwt;
}

export function evictToken(userId: string): void {
  store.delete(userId);
}
