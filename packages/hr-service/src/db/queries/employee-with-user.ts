import { eq, and } from 'drizzle-orm'
import type { Db } from '../index.js'
import { employees, users, userIdentityLinks } from '../schema.js'

// Slice 65: cross-schema joined reads. Replaces direct employee.email /
// employee.fullName / etc. accesses now that identity moved to cip_platform.users.
//
// employees.id == users.id (1:1 mapping established by slice 64); the JOIN is
// trivial.

export interface EmployeeRow {
  id:              string
  tenantId:        string
  userId:          string
  phone:           string | null
  employmentType:  string
  dateOfBirth:     string | null
  createdAt:       Date | null
  updatedAt:       Date | null
  disabledAt:      Date | null
}

export interface UserRow {
  id:           string
  tenantId:     string
  email:        string
  fullName:     string
  givenName:    string | null
  surname:      string | null
  identityType: string
  createdAt:    Date | null
  updatedAt:    Date | null
}

export interface EmployeeWithUser {
  employee: EmployeeRow
  user:     UserRow
}

export async function findEmployeeWithUser(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1)
  return (rows[0] as EmployeeWithUser | undefined) ?? null
}

export async function findEmployeeWithUserByUserId(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(and(eq(employees.tenantId, tenantId), eq(employees.userId, userId)))
    .limit(1)
  return (rows[0] as EmployeeWithUser | undefined) ?? null
}

// Replaces findEmployeeByKeycloakId — looks up via the canonical link.
export async function findEmployeeWithUserByKeycloakSub(
  db: Db,
  tenantId: string,
  keycloakSub: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(userIdentityLinks)
    .innerJoin(users, eq(users.id, userIdentityLinks.userId))
    .innerJoin(employees, eq(employees.userId, users.id))
    .where(and(
      eq(userIdentityLinks.tenantId, tenantId),
      eq(userIdentityLinks.provider, 'keycloak'),
      eq(userIdentityLinks.subject, keycloakSub),
    ))
    .limit(1)
  return (rows[0] as EmployeeWithUser | undefined) ?? null
}

export async function findEmployeeWithUserByEmail(
  db: Db,
  tenantId: string,
  email: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(users)
    .innerJoin(employees, eq(employees.userId, users.id))
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
    .limit(1)
  return (rows[0] as EmployeeWithUser | undefined) ?? null
}

export async function listEmployeesWithUserByTenant(
  db: Db,
  tenantId: string,
): Promise<EmployeeWithUser[]> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(eq(employees.tenantId, tenantId))
  return rows as EmployeeWithUser[]
}
