// Slice 42A: hr-service permission catalog. Seeded into the
// `permission_catalog` DB table at startup. The resolver expands glob
// entries (cert.*) at lookup time by joining against this catalog;
// the catalog is also queryable via `permission_catalog_list` MCP tool.
//
// Add new permissions here alongside the MCP tool that consumes them.
// Alphabetised by permission code within each module.

import type { Pool } from 'pg';

interface CatalogEntry {
  service:     'hr-service';
  module:      'cert' | 'employee' | 'compliance' | 'tenant';
  permission:  string;
  description: string;
}

const HR_SERVICE_CATALOG: CatalogEntry[] = [
  // cert module
  { service: 'hr-service', module: 'cert', permission: 'cert.approve',  description: 'Approve a HITL cert review' },
  { service: 'hr-service', module: 'cert', permission: 'cert.list_all', description: 'List certs across all employees' },
  { service: 'hr-service', module: 'cert', permission: 'cert.submit',   description: 'Submit a new cert for processing' },
  { service: 'hr-service', module: 'cert', permission: 'cert.view_own', description: 'View own certs' },

  // compliance module
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view',     description: 'View tenant-wide compliance reports' },
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view_own', description: 'View personal compliance status' },

  // employee module
  { service: 'hr-service', module: 'employee', permission: 'employee.assign_role',       description: 'Assign Keycloak realm role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.create',            description: 'Provision a new employee' },
  { service: 'hr-service', module: 'employee', permission: 'employee.disable',           description: 'Disable an employee' },
  { service: 'hr-service', module: 'employee', permission: 'employee.find',              description: 'Lookup employee by email' },
  { service: 'hr-service', module: 'employee', permission: 'employee.grant_permission',  description: 'Grant a permission group / role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.list',              description: 'List employees in tenant' },
  { service: 'hr-service', module: 'employee', permission: 'employee.migrate_identity',  description: 'Switch identity type' },
  { service: 'hr-service', module: 'employee', permission: 'employee.revoke_permission', description: 'Revoke a permission group / role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.revoke_role',       description: 'Revoke Keycloak realm role' },

  // tenant module — reserved
  { service: 'hr-service', module: 'tenant', permission: 'tenant.channel_config.view', description: 'Read tenant channel config' },
];

/**
 * Idempotent — every entry is upserted, descriptions update if changed.
 * Call once at hr-service startup. Logs the seeded count for visibility.
 */
export async function seedPermissionCatalog(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    for (const e of HR_SERVICE_CATALOG) {
      await client.query(
        `INSERT INTO permission_catalog (service, module, permission, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (service, module, permission) DO UPDATE
           SET description = EXCLUDED.description`,
        [e.service, e.module, e.permission, e.description],
      );
    }
    console.log(`[catalog] seeded ${HR_SERVICE_CATALOG.length} hr-service permissions`);
  } finally {
    client.release();
  }
}
