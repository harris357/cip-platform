import { eq, and } from 'drizzle-orm'
import type { Db } from '../index.js'
import { userIdentityLinks } from '../schema.js'
import type { IdentityProvider } from '@cip/shared'

// Slice 65: identity link lookups. Source of truth for "what's this user's
// keycloak/aad/google/etc. subject?" after the denormalized cache columns
// dropped from cip_platform.users.

export async function getIdentitySubject(
  db: Db,
  userId: string,
  provider: IdentityProvider,
): Promise<string | null> {
  const rows = await db
    .select({ subject: userIdentityLinks.subject })
    .from(userIdentityLinks)
    .where(and(eq(userIdentityLinks.userId, userId), eq(userIdentityLinks.provider, provider)))
    .limit(1)
  return rows[0]?.subject ?? null
}

export async function getKeycloakSubject(db: Db, userId: string): Promise<string | null> {
  return getIdentitySubject(db, userId, 'keycloak')
}

export async function getAadOid(db: Db, userId: string): Promise<string | null> {
  return getIdentitySubject(db, userId, 'aad')
}

export interface IdentityLink {
  provider: string
  subject:  string
}

export async function findIdentityLinks(db: Db, userId: string): Promise<IdentityLink[]> {
  const rows = await db
    .select({ provider: userIdentityLinks.provider, subject: userIdentityLinks.subject })
    .from(userIdentityLinks)
    .where(eq(userIdentityLinks.userId, userId))
  return rows
}
