import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/index.js';

// Slice 70: replaces bash section 7a's direct DB INSERT. Idempotent admin
// user provisioning — finds-or-creates the User row, the Employee row, and
// the hr-service-admin role assignment. KC realm role grant (the other half
// of bash 7a) is deferred to slice 71's grantKcAdminRealmRoleActivity.

const InputSchema = z.object({
  tenantId:      z.string().uuid(),
  adminEmail:    z.string().email(),
  adminFullName: z.string().min(1).optional(),
});
const OutputSchema = z.object({
  userId:     z.string().uuid(),
  employeeId: z.string().uuid(),
  created:    z.boolean(),
});
export type ElevateAdminUserInput  = z.infer<typeof InputSchema>;
export type ElevateAdminUserOutput = z.infer<typeof OutputSchema>;

export async function elevateAdminUser(input: unknown): Promise<ElevateAdminUserOutput> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [parsed.tenantId],
    );

    // 1. Find-or-create the User. Idempotent on (tenant_id, email).
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM cip_platform.users WHERE tenant_id = $1 AND email = $2 LIMIT 1`,
      [parsed.tenantId, parsed.adminEmail],
    );
    let userId: string;
    let created = false;
    if (existing.rows[0]) {
      userId = existing.rows[0].id;
    } else {
      userId = randomUUID();
      created = true;
      await client.query(
        `INSERT INTO cip_platform.users
           (id, tenant_id, email, full_name, identity_type)
         VALUES ($1, $2, $3, $4, 'aad_federated')`,
        [
          userId,
          parsed.tenantId,
          parsed.adminEmail,
          parsed.adminFullName ?? parsed.adminEmail,
        ],
      );
    }

    // 2. Find-or-create the Employee. employee.id == user.id (1:1 from slice 64).
    //    onboarding_source='admin' marks this as admin-driven (per slice 66 enum).
    await client.query(
      `INSERT INTO employees
         (id, tenant_id, user_id, employment_type, onboarding_source)
       VALUES ($1, $2, $1, 'employee', 'admin')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, parsed.tenantId],
    );

    // 3. Idempotent role assignment to hr-service-admin. Reads cip_platform
    //    tables post-slice-68. Falls through silently if the role doesn't
    //    exist yet (initTenantDatabase activity should have created it).
    await client.query(
      `INSERT INTO cip_platform.user_role_assignments
         (user_id, role_id, tenant_id)
       SELECT $1, id, $2 FROM cip_platform.roles
        WHERE tenant_id = $2 AND code = 'hr-service-admin'
       ON CONFLICT DO NOTHING`,
      [userId, parsed.tenantId],
    );

    await client.query('COMMIT');
    console.log(
      `[elevateAdminUser] tenant=${parsed.tenantId} email=${parsed.adminEmail} ` +
      `userId=${userId} created=${created}`,
    );
    return OutputSchema.parse({ userId, employeeId: userId, created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
