export interface TenantContext {
  tenantId: string;   // UUID — from JWT, never from request body
  userId: string;
  tenantConfig: TenantConfig;
}

export interface TenantConfig {
  tenantId: string;
  name: string;
  litellmVirtualKey: string;
  keycloakRealm: string;
  natsPrefix: string;         // = `cip.${tenantId}`
  langfuseTags: Record<string, string>;
}
