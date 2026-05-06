import { z } from 'zod';

// Slice 65: Employee is HR-only. Identity fields moved to cip_platform.users
// (read via the findEmployeeWithUser helper). IdentityTypeSchema kept here as
// a re-export for any consumer that still imports it from this file path.
export { IdentityTypeSchema, type IdentityType } from '@cip/shared/src/types/user.js';

export const EmploymentTypeSchema = z.enum(['employee', 'contractor']);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const EmployeeSchema = z.object({
  id:             z.string().uuid(),
  tenantId:       z.string().uuid(),
  userId:         z.string().uuid(),
  phone:          z.string().nullable(),
  employmentType: EmploymentTypeSchema,
  createdAt:      z.string(),
  updatedAt:      z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// Input shape for upsertEmployee — DB-side defaults fill the rest.
export const EmployeeUpsertSchema = EmployeeSchema.pick({
  id: true, tenantId: true, userId: true, employmentType: true,
}).extend({
  phone: z.string().nullable().optional(),
});
export type EmployeeUpsert = z.infer<typeof EmployeeUpsertSchema>;
