import {
  pgTable, uuid, text, boolean, integer, numeric,
  timestamp, date, jsonb, primaryKey,
} from 'drizzle-orm/pg-core'

// ── Lookup tables (global, no tenant_id) ──────────────────────────────────

export const hitlReasons = pgTable('hitl_reasons', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

export const hitlResolutions = pgTable('hitl_resolutions', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

export const notificationTypes = pgTable('notification_types', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

export const employmentTypes = pgTable('employment_types', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

export const identityTypes = pgTable('identity_types', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

export const workflowStepNames = pgTable('workflow_step_names', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

// ── Tenant-scoped tables ───────────────────────────────────────────────────

export const tenantSettings = pgTable('tenant_settings', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull().unique(),
  litellmVirtualKey: text('litellm_virtual_key').notNull().default(''),
  channelConfig:     jsonb('channel_config').notNull().default({}),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const roles = pgTable('roles', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  keycloakRole: text('keycloak_role').notNull(),
  label:        text('label').notNull(),
  description:  text('description'),
  capabilities: jsonb('capabilities').notNull().default({}),
  isSystemRole: boolean('is_system_role').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const employees = pgTable('employees', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       uuid('tenant_id').notNull(),
  email:          text('email').notNull(),
  fullName:       text('full_name').notNull(),
  givenName:      text('given_name'),
  surname:        text('surname'),
  phone:          text('phone'),
  aadOid:         text('aad_oid'),
  keycloakId:     text('keycloak_id'),
  identityType:   text('identity_type').notNull().references(() => identityTypes.code),
  employmentType: text('employment_type').notNull().default('employee').references(() => employmentTypes.code),
  dateOfBirth:    date('date_of_birth'),
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const employeeRoles = pgTable('employee_roles', {
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  roleId:     uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  grantedAt:  timestamp('granted_at', { withTimezone: true }).defaultNow(),
  grantedBy:  uuid('granted_by').references(() => employees.id),
}, (table) => ({
  pk: primaryKey({ columns: [table.employeeId, table.roleId] }),
}))

export const certificateTypes = pgTable('certificate_types', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code:     text('code').notNull(),
  label:    text('label').notNull(),
})

export const issuingOrganizations = pgTable('issuing_organizations', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name:     text('name').notNull(),
  aliases:  text('aliases').array().notNull().default([]),
})

export const certificateDefinitions = pgTable('certificate_definitions', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  tenantId:            uuid('tenant_id').notNull(),
  certTypeId:          uuid('cert_type_id').notNull().references(() => certificateTypes.id),
  issuingOrgId:        uuid('issuing_org_id').references(() => issuingOrganizations.id),
  displayName:         text('display_name').notNull(),
  defaultValidityDays: integer('default_validity_days'),
  keywords:            text('keywords').array().notNull().default([]),
  isActive:            boolean('is_active').notNull().default(true),
})

export const certSubmissions = pgTable('cert_submissions', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull(),
  submittedBy:       uuid('submitted_by').notNull().references(() => employees.id),
  matchedEmployeeId: uuid('matched_employee_id').references(() => employees.id),
  certDefId:         uuid('cert_def_id').references(() => certificateDefinitions.id),
  submissionStatus:  text('submission_status').notNull().default('pending'),
  objectStoreKey:    text('object_store_key').notNull(),
  confidence:        numeric('confidence', { precision: 4, scale: 3 }),
  extractedFields:   jsonb('extracted_fields'),
  promptVersion:     text('prompt_version'),
  modelUsed:         text('model_used'),
  workflowId:        text('workflow_id'),
  createdAt:         timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const certifications = pgTable('certifications', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  employeeId:   uuid('employee_id').notNull().references(() => employees.id),
  certDefId:    uuid('cert_def_id').notNull().references(() => certificateDefinitions.id),
  submissionId: uuid('submission_id').references(() => certSubmissions.id),
  certStatus:   text('cert_status').notNull().default('valid'),
  issueDate:    date('issue_date'),
  expiresAt:    timestamp('expires_at', { withTimezone: true }),
  issuedByText: text('issued_by_text'),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const hitlItems = pgTable('hitl_items', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  submissionId: uuid('submission_id').notNull().references(() => certSubmissions.id),
  reasonId:     integer('reason_id').notNull().references(() => hitlReasons.id),
  resolutionId: integer('resolution_id').references(() => hitlResolutions.id),
  assignedTo:   uuid('assigned_to').references(() => employees.id),
  resolvedBy:   uuid('resolved_by').references(() => employees.id),
  notes:        text('notes'),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
  resolvedAt:   timestamp('resolved_at', { withTimezone: true }),
})

export const notifications = pgTable('notifications', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  typeId:     integer('type_id').notNull().references(() => notificationTypes.id),
  payload:    jsonb('payload'),
  sentAt:     timestamp('sent_at', { withTimezone: true }),
  readAt:     timestamp('read_at', { withTimezone: true }),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const workflowStepCosts = pgTable('workflow_step_costs', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  stepNameId:   integer('step_name_id').notNull().references(() => workflowStepNames.id),
  submissionId: uuid('submission_id').references(() => certSubmissions.id),
  tokensIn:     integer('tokens_in'),
  tokensOut:    integer('tokens_out'),
  costUsd:      numeric('cost_usd', { precision: 10, scale: 6 }),
  modelUsed:    text('model_used'),
  recordedAt:   timestamp('recorded_at', { withTimezone: true }).defaultNow(),
})

export const agentRuns = pgTable('agent_runs', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tenantId:  uuid('tenant_id').notNull(),
  runId:     text('run_id').notNull(),
  agentType: text('agent_type').notNull(),
  input:     jsonb('input'),
  output:    jsonb('output'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt:   timestamp('ended_at', { withTimezone: true }),
})
