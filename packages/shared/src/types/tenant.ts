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
