import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { roles, employeeRoles } from '../../../db/schema.js';

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
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(
        eq(roles.tenantId,     input.tenantId),
        eq(roles.keycloakRole, roleCode),
      ))
      .limit(1);

    if (!role) {
      throw new Error(
        `assignDefaultRoleActivity: role '${roleCode}' not found for tenant ${input.tenantId}`,
      );
    }

    await tx.insert(employeeRoles).values({
      employeeId: input.employeeId,
      roleId:     role.id,
    }).onConflictDoNothing();

    return AssignDefaultRoleOutputSchema.parse({ roleId: role.id });
  });
}
