import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { roles, employeeRoleAssignments } from '../../../db/schema.js';

type IdentityType = 'aad_federated' | 'field_employee';

export interface AssignDefaultRoleInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
}

export interface AssignDefaultRoleOutput {
  roleId: string;
}

const AssignDefaultRoleOutputSchema = z.object({
  roleId: z.string().uuid(),
});

// Slice 32 + 42C: every new employee gets a default CIP role on first
// provisioning. Role choice is keyed off identityType, mapping to the
// role whose `keycloak_role` column matches. After 42C the role layer
// is the canonical assignment surface; this activity inserts into
// employee_role_assignments.
//
// 'employee' realm role is the baseline that every authenticated user
// gets. HR users additionally get the 'hr' realm role via Slice 33's
// employee.assign_role tool (which calls Keycloak Admin API).
const DEFAULT_REALM_ROLE: Record<IdentityType, string> = {
  aad_federated:  'employee',
  field_employee: 'employee',
};

export async function assignDefaultRoleActivity(
  input: AssignDefaultRoleInput,
): Promise<AssignDefaultRoleOutput> {
  const realmRoleCode = DEFAULT_REALM_ROLE[input.identityType];
  const db = getDb();

  return withTenantRLS(db, input.tenantId, async (tx) => {
    // Find the first CIP role whose keycloak_role matches the desired realm
    // role. Multiple may exist (e.g., field_worker + hr_standard both have
    // keycloak_role='employee' / 'hr'); LIMIT 1 picks one deterministically
    // (alphabetical order via the ORDER BY in the underlying SQL).
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(
        eq(roles.tenantId,     input.tenantId),
        eq(roles.keycloakRole, realmRoleCode),
      ))
      .limit(1);

    if (!role) {
      throw new Error(
        `assignDefaultRoleActivity: no CIP role with keycloak_role='${realmRoleCode}' found for tenant ${input.tenantId}. ` +
        `Run 'init-tenant-database' or migration 012 to seed roles.`,
      );
    }

    await tx.insert(employeeRoleAssignments).values({
      employeeId: input.employeeId,
      roleId:     role.id,
    }).onConflictDoNothing();

    return AssignDefaultRoleOutputSchema.parse({ roleId: role.id });
  });
}
