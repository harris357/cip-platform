export interface TenantContext {
  tenantId: string;   // UUID — from JWT, never from request body
  userId: string;     // JWT sub claim
  systemRole: 'platform_admin' | 'tenant_admin' | 'supervisor' | 'worker';
}

export interface TenantConfig {
  tenantId: string;
  name: string;
  tier: 'standard' | 'premium' | 'enterprise';
  litellmVirtualKey: string;
  temporalNamespace: string;
  objectStoreBucket: string;
  createdAt: Date;
}
