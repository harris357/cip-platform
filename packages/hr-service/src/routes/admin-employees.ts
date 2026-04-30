import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@cip/shared';
import { requireRealmRole } from '@cip/shared/src/utils/tenant-context.js';
import {
  IdentityTypeSchema,
  EmploymentTypeSchema,
} from '../types/employee.js';
import { onboardEmployee, AppError } from '../services/employee-onboarding.js';

export const adminEmployeesRouter: IRouter = Router();

const AdminEmployeeCreateSchema = z.object({
  email:          z.string().email(),
  fullName:       z.string().min(1),
  identityType:   IdentityTypeSchema,
  aadOid:         z.string().min(8).optional(),
  phone:          z.string().min(7).optional(),
  employmentType: EmploymentTypeSchema.optional(),
});

// Thin route handler — parses the body, calls the service, maps errors to
// HTTP status codes. All provisioning logic lives in
// services/employee-onboarding.ts so Slice 33's MCP tool reuses it.
adminEmployeesRouter.post(
  '/admin/employees',
  requireRealmRole('hr'),
  async (req: Request & { tenantContext?: AuthContext }, res: Response): Promise<void> => {
    const parse = AdminEmployeeCreateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'validation', issues: parse.error.issues });
      return;
    }

    const auth = req.tenantContext;
    if (!auth) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    try {
      const d = parse.data;
      const result = await onboardEmployee({
        tenantId:        auth.tenantId,
        actorKeycloakId: auth.userId,        // sub from JWT — service resolves to employees.id
        email:           d.email,
        fullName:        d.fullName,
        identityType:    d.identityType,
        ...(d.aadOid         !== undefined ? { aadOid:         d.aadOid }         : {}),
        ...(d.phone          !== undefined ? { phone:          d.phone }          : {}),
        ...(d.employmentType !== undefined ? { employmentType: d.employmentType } : {}),
      });
      res.status(201).json({ ...result, status: 'onboarding' });
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      console.error('[admin-employees] unexpected error:', err);
      res.status(500).json({ error: 'internal' });
    }
  },
);
