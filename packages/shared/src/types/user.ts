import { z } from 'zod';

// Slice 64: User identity types — owned by platform-core (cip_platform.users +
// cip_platform.user_identity_links). Re-exported from hr-service/types/employee.ts
// for backwards compat (IdentityTypeSchema only).

// Open enum: code can add new providers without a DB migration. Adding to this
// list (and wiring sync-employee to populate the link) is the only place to plug
// in a new identity system.
export const IDENTITY_PROVIDERS = [
  'keycloak',
  'aad',
  'google',
  'saml',
  'local_password',
] as const;
export const IdentityProviderSchema = z.enum(IDENTITY_PROVIDERS);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

// identity_type stays for the HR onboarding flow (says what kind of user this
// is at registration time). The actual login linkages live in user_identity_links.
export const IdentityTypeSchema = z.enum(['aad_federated', 'field_employee', 'local_password']);
export type IdentityType = z.infer<typeof IdentityTypeSchema>;

export const UserSchema = z.object({
  id:           z.string().uuid(),
  tenantId:     z.string().uuid(),
  email:        z.string().email(),
  fullName:     z.string().min(1),
  givenName:    z.string().nullable(),
  surname:      z.string().nullable(),
  // Slice 64: denormalized cache columns for the most common providers.
  // The source of truth is user_identity_links. Slice 65+ may drop these.
  keycloakId:   z.string().nullable(),
  aadOid:       z.string().nullable(),
  identityType: IdentityTypeSchema,
  createdAt:    z.string(),
  updatedAt:    z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const UserIdentityLinkSchema = z.object({
  id:         z.string().uuid(),
  userId:     z.string().uuid(),
  tenantId:   z.string().uuid(),
  provider:   IdentityProviderSchema,
  subject:    z.string().min(1),
  metadata:   z.record(z.unknown()).default({}),
  createdAt:  z.string(),
  updatedAt:  z.string(),
});
export type UserIdentityLink = z.infer<typeof UserIdentityLinkSchema>;
