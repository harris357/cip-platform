import { z } from 'zod';

export const IdentityTypeSchema = z.enum(['aad_federated', 'field_employee']);
export type IdentityType = z.infer<typeof IdentityTypeSchema>;

export const EmploymentTypeSchema = z.enum(['employee', 'contractor']);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const EmployeeSchema = z.object({
  id:             z.string().uuid(),
  tenantId:       z.string().uuid(),
  email:          z.string().email(),
  fullName:       z.string().min(1),
  givenName:      z.string().nullable(),
  surname:        z.string().nullable(),
  phone:          z.string().nullable(),
  aadOid:         z.string().nullable(),
  keycloakId:     z.string().nullable(),
  identityType:   IdentityTypeSchema,
  employmentType: EmploymentTypeSchema,
  createdAt:      z.string(),
  updatedAt:      z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// Input shape for upsertEmployee — DB-side defaults fill the rest.
export const EmployeeUpsertSchema = EmployeeSchema.pick({
  id: true, tenantId: true, email: true, fullName: true,
  identityType: true, employmentType: true,
}).extend({
  givenName:  z.string().nullable().optional(),
  surname:    z.string().nullable().optional(),
  phone:      z.string().nullable().optional(),
  aadOid:     z.string().nullable().optional(),
  keycloakId: z.string().nullable().optional(),
});
export type EmployeeUpsert = z.infer<typeof EmployeeUpsertSchema>;
