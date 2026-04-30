import { z } from 'zod';

// ── Existing runtime auth shapes (do not change — consumed across packages) ──

export interface TenantContext {
  tenantId: string;
  userId: string;
  tenantConfig: TenantConfig;
}

export interface TenantConfig {
  tenantId: string;
  name: string;
  litellmVirtualKey: string; // source: tenant_settings.litellm_virtual_key (written by TenantProvisioningWorkflow)
  keycloakRealm: string;
  natsPrefix: string;
  langfuseTags: Record<string, string>;
}

// Auth context built from verified JWT — roles are raw Keycloak role codes.
// Each service maps roles to its own capability model.
export interface AuthContext extends TenantContext {
  roles: string[];
}

// ── Slice 35 — canonical tenant ledger schemas ────────────────────────────

export const TenantStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantTierSchema = z.enum(['standard', 'enterprise', 'trial']);
export type TenantTier = z.infer<typeof TenantTierSchema>;

export const IdentityProviderTypeSchema = z.enum([
  'aad_oidc',
  'google_oidc',
  'generic_oidc',
  'saml',
  'sms_otp',
  'local_password',
]);
export type IdentityProviderType = z.infer<typeof IdentityProviderTypeSchema>;

export const TenantSchema = z.object({
  id:           z.string().uuid(),
  displayName:  z.string().min(1),
  status:       TenantStatusSchema,
  tier:         TenantTierSchema,
  adminEmail:   z.string().email(),
  realm:        z.string().min(1),     // KC realm name; defaults to id::text in DB
  createdAt:    z.string(),
  updatedAt:    z.string(),
  suspendedAt:  z.string().nullable(),
  deletedAt:    z.string().nullable(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const TenantIdentityProviderSchema = z.object({
  id:            z.string().uuid(),
  tenantId:      z.string().uuid(),
  providerType:  IdentityProviderTypeSchema,
  alias:         z.string().min(1),
  enabled:       z.boolean(),
  config:        z.record(z.unknown()),
  secretRef:     z.string().nullable(),
  createdAt:     z.string(),
  updatedAt:     z.string(),
});
export type TenantIdentityProvider = z.infer<typeof TenantIdentityProviderSchema>;
