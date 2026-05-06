import { z } from 'zod';

// Slice 64: IdentityTypeSchema canonical home is @cip/shared/src/types/user.ts.
// Re-exported here for backwards compat. Note: shared schema includes
// 'local_password' in addition to 'aad_federated' | 'field_employee'.
export { IdentityTypeSchema, type IdentityType } from '@cip/shared/src/types/user.js';
import { IdentityTypeSchema } from '@cip/shared/src/types/user.js';

export const EmploymentTypeSchema = z.enum(['employee', 'contractor']);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const EmployeeSchema = z.object({
  id:             z.string().uuid(),
  tenantId:       z.string().uuid(),
  /** Slice 64: linkage to cip_platform.users.id (1:1). NOT NULL post-046 migration. */
  userId:         z.string().uuid(),

  // Identity fields. Stay for slice 64; slice 65 drops them after the
  // read-site migration completes. Read from User instead going forward.
  /** @deprecated Slice 64: read from User. Will be dropped in slice 65. */
  email:          z.string().email(),
  /** @deprecated Slice 64: read from User. Will be dropped in slice 65. */
  fullName:       z.string().min(1),
  /** @deprecated Slice 64: read from User. */
  givenName:      z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  surname:        z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  aadOid:         z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  keycloakId:     z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  identityType:   IdentityTypeSchema,

  // HR-specific (stay):
  phone:          z.string().nullable(),
  employmentType: EmploymentTypeSchema,
  createdAt:      z.string(),
  updatedAt:      z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// Input shape for upsertEmployee — DB-side defaults fill the rest.
export const EmployeeUpsertSchema = EmployeeSchema.pick({
  id: true, tenantId: true, userId: true, email: true, fullName: true,
  identityType: true, employmentType: true,
}).extend({
  givenName:  z.string().nullable().optional(),
  surname:    z.string().nullable().optional(),
  phone:      z.string().nullable().optional(),
  aadOid:     z.string().nullable().optional(),
  keycloakId: z.string().nullable().optional(),
});
export type EmployeeUpsert = z.infer<typeof EmployeeUpsertSchema>;
