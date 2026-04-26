# Slice 15 — Employee Onboarding Workflow

> **Prerequisite:** Slices 02, 05A, 05B, 06, 10 complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/modules/employees/
  workflows/
    employee-onboarding.workflow.ts
  activities/
    create-keycloak-user.activity.ts
    assign-default-role.activity.ts
    send-welcome-notification.activity.ts
    publish-employee-onboarded.activity.ts
```

Register all four activities and the workflow in `src/workers/temporal-worker.ts`.

---

## Workflow Topology

```
1. createKeycloakUser(tenantId, employeeId, identityType, email, fullName, aadOid?)
      → keycloakId: string

2. assignDefaultRole(tenantId, employeeId, identityType)
      → roleId: string
      (aad_federated → 'field_operations'; field_employee → 'field_employee')

3. sendWelcomeNotification(tenantId, employeeId, identityType)
      → void (stub — logs and returns)

4. publishEmployeeOnboarded(tenantId, employeeId, identityType)
      → publishes EmployeeOnboardedEvent to NATS
```

Workflow ID:
```typescript
// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
workflowId: `EmployeeOnboard-${input.tenantId}-${input.employeeId}`
```

---

## `createKeycloakUser` — Identity Type Branching

```typescript
export async function createKeycloakUserActivity(input: {
  tenantId: string
  employeeId: string
  identityType: IdentityType
  email: string
  fullName: string
  aadOid?: string
}): Promise<{ keycloakId: string }> {
  if (input.identityType === 'aad_federated') {
    // Create Keycloak user linked to AAD IDP
    // User authenticates via AAD — no password set in Keycloak
    throw new Error('not implemented')
  } else {
    // Create Keycloak user with OTP-only login
    // No password, no AAD link — field employee uses SMS OTP flow
    throw new Error('not implemented')
  }
}
```

---

## `assignDefaultRole`

```typescript
export async function assignDefaultRoleActivity(input: {
  tenantId: string
  employeeId: string
  identityType: IdentityType
}): Promise<{ roleId: string }> {
  const defaultRole = input.identityType === 'aad_federated'
    ? 'field_operations'
    : 'field_employee'

  const db = getDb()
  // Look up role by keycloak_role code within tenant, insert into employee_roles
  throw new Error('not implemented')
}
```

---

## `publishEmployeeOnboarded`

```typescript
export async function publishEmployeeOnboardedActivity(input: {
  tenantId: string
  employeeId: string
  identityType: string
}): Promise<void> {
  const nc = await getNatsConnection()
  const js = nc.jetstream()
  const event: EmployeeOnboardedEvent = {
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
    onboardedAt:  new Date().toISOString(),
  }
  await js.publish(
    Subjects.employeeOnboarded(input.tenantId),
    JSON.stringify(event),
  )
}
```

---

## Acceptance Criteria

- [ ] Workflow ID follows `{workflowType}-{tenantId}-{entityId}` with comment
- [ ] `createKeycloakUser` branches on `identityType` with a stub for each path
- [ ] `assignDefaultRole` correctly maps `aad_federated → field_operations`, `field_employee → field_employee`
- [ ] `publishEmployeeOnboarded` uses `Subjects.employeeOnboarded()` — no raw NATS string
- [ ] All activities registered in `temporal-worker.ts`
- [ ] All unimplemented bodies throw `new Error('not implemented')`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes
