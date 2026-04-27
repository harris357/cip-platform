import { getDb } from '../../../db/index.js';

type IdentityType = 'aad_federated' | 'field_employee';

export interface AssignDefaultRoleInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
}

export interface AssignDefaultRoleOutput {
  roleId: string;
}

export async function assignDefaultRoleActivity(
  input: AssignDefaultRoleInput,
): Promise<AssignDefaultRoleOutput> {
  const defaultRole = input.identityType === 'aad_federated'
    ? 'field_operations'
    : 'field_employee';

  const db = getDb();
  // Look up role by keycloak_role code within tenant, insert into employee_roles
  void defaultRole;
  void db;
  throw new Error('not implemented');
}
