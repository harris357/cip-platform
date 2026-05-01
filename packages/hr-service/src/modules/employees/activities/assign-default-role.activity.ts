import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { permissionGroups, employeeGroupAssignments } from '../../../db/schema.js';

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

// Slice 32: every new employee gets the 'employee' realm role by default,
// regardless of identityType. identity_type is HOW you authenticate, not WHAT
// you can do. HR reps additionally get the 'hr' realm role via a separate
// assignment (Slice 33's employee.assign_role tool); 'employee' is baseline.
//
// Slice 42A: targets the renamed permission_groups + employee_group_assignments
// tables. The activity finds the first permission_group whose keycloak_role
// matches the desired realm role and assigns it. Function name kept stable
// (Slice 42C reconciles when the role layer makes naming accurate again).
const DEFAULT_ROLE: Record<IdentityType, string> = {
  aad_federated:  'employee',
  field_employee: 'employee',
};

export async function assignDefaultRoleActivity(
  input: AssignDefaultRoleInput,
): Promise<AssignDefaultRoleOutput> {
  const roleCode = DEFAULT_ROLE[input.identityType];
  const db = getDb();

  return withTenantRLS(db, input.tenantId, async (tx) => {
    const [group] = await tx
      .select({ id: permissionGroups.id })
      .from(permissionGroups)
      .where(and(
        eq(permissionGroups.tenantId,     input.tenantId),
        eq(permissionGroups.keycloakRole, roleCode),
      ))
      .limit(1);

    if (!group) {
      throw new Error(
        `assignDefaultRoleActivity: permission group with keycloak_role='${roleCode}' not found for tenant ${input.tenantId}`,
      );
    }

    await tx.insert(employeeGroupAssignments).values({
      employeeId: input.employeeId,
      groupId:    group.id,
    }).onConflictDoNothing();

    return AssignDefaultRoleOutputSchema.parse({ roleId: group.id });
  });
}
