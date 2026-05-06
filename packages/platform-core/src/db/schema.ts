import {
  pgSchema, uuid, text, boolean, timestamp, jsonb, primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core'

// Slice 62: cip_platform drizzle schema. Empty tables today —
// slice 63+ writes the first rows. Mirrors src/db/migrations/001_init.sql.

export const cipPlatform = pgSchema('cip_platform')

// ── Tenants (platform-level, NO RLS) ─────────────────────────────────────

export const tenants = cipPlatform.table('tenants', {
  id:           uuid('id').primaryKey().defaultRandom(),
  displayName:  text('display_name').notNull(),
  status:       text('status').notNull().default('active'),
  tier:         text('tier').notNull().default('standard'),
  adminEmail:   text('admin_email').notNull(),
  realm:        text('realm').notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  suspendedAt:  timestamp('suspended_at', { withTimezone: true }),
  deletedAt:    timestamp('deleted_at', { withTimezone: true }),
})

export const tenantIdentityProviders = cipPlatform.table('tenant_identity_providers', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  providerType: text('provider_type').notNull(),
  alias:        text('alias').notNull(),
  enabled:      boolean('enabled').notNull().default(true),
  config:       jsonb('config').notNull().default({}),
  secretRef:    text('secret_ref'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantAlias: uniqueIndex('tenant_identity_providers_tenant_id_alias_key').on(t.tenantId, t.alias),
}))

export const tenantSettings = cipPlatform.table('tenant_settings', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull().unique().references(() => tenants.id, { onDelete: 'cascade' }),
  litellmVirtualKey: text('litellm_virtual_key').notNull().default(''),
  channelConfig:     jsonb('channel_config').notNull().default({}),
  routingOverrides:  jsonb('routing_overrides').notNull().default({}),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Routing (global, no RLS) ─────────────────────────────────────────────

export const routingRules = cipPlatform.table('routing_rules', {
  service:    text('service').notNull(),
  purpose:    text('purpose').notNull(),
  alias:      text('alias').notNull(),
  notes:      text('notes'),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy:  text('updated_by'),
}, t => ({
  pk: primaryKey({ columns: [t.service, t.purpose] }),
}))

// ── Users (tenant-scoped, RLS) ───────────────────────────────────────────

// Slice 65: keycloak_id and aad_oid columns dropped — source of truth is
// user_identity_links.
export const users = cipPlatform.table('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  email:        text('email').notNull(),
  fullName:     text('full_name').notNull(),
  givenName:    text('given_name'),
  surname:      text('surname'),
  identityType: text('identity_type').notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantEmail: uniqueIndex('users_tenant_id_email_key').on(t.tenantId, t.email),
}))

// ── Permission groups + roles + assignments ──────────────────────────────

export const permissionGroups = cipPlatform.table('permission_groups', {
  id:          uuid('id').primaryKey().defaultRandom(),
  tenantId:    uuid('tenant_id').notNull(),
  code:        text('code').notNull(),
  label:       text('label').notNull(),
  description: text('description'),
  service:     text('service').notNull(),
  module:      text('module').notNull(),
  permissions: jsonb('permissions').notNull().default([]),
  isSystem:    boolean('is_system').notNull().default(false),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  natural: uniqueIndex('permission_groups_tenant_service_module_code_key')
             .on(t.tenantId, t.service, t.module, t.code),
}))

export const roles = cipPlatform.table('roles', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  code:         text('code').notNull(),
  label:        text('label').notNull(),
  description:  text('description'),
  keycloakRole: text('keycloak_role').notNull(),
  isSystemRole: boolean('is_system_role').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  natural: uniqueIndex('roles_tenant_id_code_key').on(t.tenantId, t.code),
}))

export const roleGroups = cipPlatform.table('role_groups', {
  roleId:  uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => permissionGroups.id, { onDelete: 'cascade' }),
}, t => ({
  pk: primaryKey({ columns: [t.roleId, t.groupId] }),
}))

export const userRoleAssignments = cipPlatform.table('user_role_assignments', {
  userId:    uuid('user_id').notNull(),
  roleId:    uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  tenantId:  uuid('tenant_id').notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk:       primaryKey({ columns: [t.userId, t.roleId] }),
  roleIdx:  index('user_role_assignments_role_idx').on(t.roleId),
  tenIdx:   index('user_role_assignments_tenant_idx').on(t.tenantId),
}))

// ── User identity links (tenant-scoped, RLS) ─────────────────────────────
// Slice 64: 1..N identity providers per user. Replaces denormalized
// users.keycloak_id + users.aad_oid columns long-term (slice 65+ may drop
// them; slice 64 keeps both as cache).

export const userIdentityLinks = cipPlatform.table('user_identity_links', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull(),
  tenantId:  uuid('tenant_id').notNull(),
  provider:  text('provider').notNull(),
  subject:   text('subject').notNull(),
  metadata:  jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  userProvider: uniqueIndex('user_identity_links_user_id_provider_key').on(t.userId, t.provider),
  tenantSubject: uniqueIndex('user_identity_links_tenant_provider_subject_key').on(t.tenantId, t.provider, t.subject),
  providerSubjectIdx: index('idx_uil_provider_subject').on(t.provider, t.subject),
  userIdx: index('idx_uil_user_id').on(t.userId),
}))

// ── Permission catalog (global, no RLS) ──────────────────────────────────

export const permissionCatalog = cipPlatform.table('permission_catalog', {
  service:      text('service').notNull(),
  module:       text('module').notNull(),
  permission:   text('permission').notNull(),
  description:  text('description'),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk:        primaryKey({ columns: [t.service, t.module, t.permission] }),
  moduleIdx: index('permission_catalog_module_idx').on(t.service, t.module),
}))
