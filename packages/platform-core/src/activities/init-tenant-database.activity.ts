export async function initTenantDatabase(input: { tenantId: string }): Promise<void> {
  void input;
  // TODO: run 001_initial.sql migration for tenant schema
  throw new Error('initTenantDatabase: not implemented');
}
