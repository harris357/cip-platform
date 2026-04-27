-- ============================================================
-- CIP HR — Normalized Domain Model (supersedes 001_initial.sql)
-- Fresh environments run this file only.
-- All tenant-scoped tables have tenant_id UUID NOT NULL + RLS.
-- Lookup tables are global (no tenant_id) and seeded at deploy.
-- ============================================================

-- ============================================================
-- LOOKUP TABLES (global, non-tenant-scoped, seeded at deploy)
-- ============================================================

CREATE TABLE IF NOT EXISTS hitl_reasons (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hitl_resolutions (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_types (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employment_types (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_types (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_step_names (
  id    SERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

-- ============================================================
-- TENANT SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL UNIQUE,
  litellm_virtual_key TEXT NOT NULL DEFAULT '',
  -- Written once by initTenantDatabase (Platform Core) at provision time; read on every LLM call
  channel_config      JSONB NOT NULL DEFAULT '{}',
  -- channel_config shape: { "hr_notifications": { "teamsTeamId": "...", "teamsChannelId": "..." } }
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- ROLES
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  keycloak_role  TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  capabilities   JSONB NOT NULL DEFAULT '{}',
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, keycloak_role)
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- EMPLOYEES
-- ============================================================

CREATE TABLE IF NOT EXISTS employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  email           TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  given_name      TEXT,
  surname         TEXT,
  phone           TEXT,
  aad_oid         TEXT,
  keycloak_id     TEXT,
  identity_type   TEXT NOT NULL REFERENCES identity_types(code),
  employment_type TEXT NOT NULL DEFAULT 'employee' REFERENCES employment_types(code),
  date_of_birth   DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Lookup by email is the most common join path (AAD onboarding, MCP queries)
CREATE INDEX idx_employees_tenant_email ON employees(tenant_id, email);
-- AAD OID lookup needed during federated onboarding; partial index avoids scanning nulls
CREATE INDEX idx_employees_aad_oid ON employees(tenant_id, aad_oid) WHERE aad_oid IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_roles (
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  granted_by  UUID REFERENCES employees(id),
  PRIMARY KEY (employee_id, role_id)
);

-- ============================================================
-- CERTIFICATE LIBRARY (tenant-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS certificate_types (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  code      TEXT NOT NULL,
  label     TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

ALTER TABLE certificate_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON certificate_types
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE IF NOT EXISTS issuing_organizations (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name      TEXT NOT NULL,
  aliases   TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE(tenant_id, name)
);

ALTER TABLE issuing_organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON issuing_organizations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE IF NOT EXISTS certificate_definitions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  cert_type_id          UUID NOT NULL REFERENCES certificate_types(id),
  issuing_org_id        UUID REFERENCES issuing_organizations(id),
  display_name          TEXT NOT NULL,
  default_validity_days INTEGER,
  keywords              TEXT[] NOT NULL DEFAULT '{}',
  is_active             BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(tenant_id, display_name)
);

ALTER TABLE certificate_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON certificate_definitions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- CERT SUBMISSIONS (pipeline — one per submitted document)
-- ============================================================

CREATE TABLE IF NOT EXISTS cert_submissions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  submitted_by        UUID NOT NULL REFERENCES employees(id),
  matched_employee_id UUID REFERENCES employees(id),
  cert_def_id         UUID REFERENCES certificate_definitions(id),
  submission_status   TEXT NOT NULL DEFAULT 'pending'
    CHECK (submission_status IN ('pending','processing','matched','failed','hitl_required')),
  object_store_key    TEXT NOT NULL,
  confidence          NUMERIC(4,3),
  extracted_fields    JSONB,
  prompt_version      TEXT,
  model_used          TEXT,
  workflow_id         TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cert_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cert_submissions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_cert_submissions_tenant ON cert_submissions(tenant_id);
-- Employee lookup: "show me all submissions for this employee"
CREATE INDEX idx_cert_submissions_employee ON cert_submissions(tenant_id, submitted_by);
-- Status-based queue draining (worker picks up 'pending' rows)
CREATE INDEX idx_cert_submissions_status ON cert_submissions(tenant_id, submission_status);

-- ============================================================
-- CERTIFICATIONS (credential — one per validated cert per employee)
-- ============================================================

CREATE TABLE IF NOT EXISTS certifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  employee_id    UUID NOT NULL REFERENCES employees(id),
  cert_def_id    UUID NOT NULL REFERENCES certificate_definitions(id),
  submission_id  UUID REFERENCES cert_submissions(id),
  cert_status    TEXT NOT NULL DEFAULT 'valid'
    CHECK (cert_status IN ('valid','expired','revoked','superseded')),
  issue_date     DATE,
  expires_at     TIMESTAMPTZ,
  issued_by_text TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON certifications
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Primary compliance query path: all certs for an employee
CREATE INDEX idx_certifications_employee ON certifications(tenant_id, employee_id);
-- Expiry scanner: only scan valid certs (others are already terminal states)
CREATE INDEX idx_certifications_expiry ON certifications(tenant_id, expires_at)
  WHERE cert_status = 'valid';

-- ============================================================
-- HITL
-- ============================================================

CREATE TABLE IF NOT EXISTS hitl_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  submission_id UUID NOT NULL REFERENCES cert_submissions(id),
  reason_id     INTEGER NOT NULL REFERENCES hitl_reasons(id),
  resolution_id INTEGER REFERENCES hitl_resolutions(id),
  assigned_to   UUID REFERENCES employees(id),
  resolved_by   UUID REFERENCES employees(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

ALTER TABLE hitl_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hitl_items
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id),
  type_id     INTEGER NOT NULL REFERENCES notification_types(id),
  payload     JSONB,
  sent_at     TIMESTAMPTZ,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- COST TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_step_costs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  step_name_id   INTEGER NOT NULL REFERENCES workflow_step_names(id),
  submission_id  UUID REFERENCES cert_submissions(id),
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_usd       NUMERIC(10,6),
  model_used     TEXT,
  recorded_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE workflow_step_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_step_costs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- OUTCOME STORE (agent runs)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  run_id      TEXT NOT NULL,
  agent_type  TEXT NOT NULL,
  input       JSONB,
  output      JSONB,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- SEED: global lookup tables
-- ============================================================

INSERT INTO hitl_reasons (code, label) VALUES
  ('low_confidence',       'Low extraction confidence'),
  ('ambiguous_person',     'Ambiguous person match'),
  ('ambiguous_cert_type',  'Ambiguous certificate type'),
  ('expired_document',     'Document appears expired'),
  ('illegible_document',   'Document is illegible'),
  ('manual_review',        'Manual review requested')
ON CONFLICT (code) DO NOTHING;

INSERT INTO hitl_resolutions (code, label) VALUES
  ('approved',             'Approved as-is'),
  ('corrected',            'Approved with corrections'),
  ('rejected',             'Rejected — invalid document')
ON CONFLICT (code) DO NOTHING;

INSERT INTO notification_types (code, label) VALUES
  ('cert_processed',       'Certificate processed'),
  ('cert_expiring_soon',   'Certificate expiring soon'),
  ('cert_expired',         'Certificate expired'),
  ('hitl_required',        'Manual review required'),
  ('hitl_resolved',        'Manual review resolved'),
  ('onboarding_complete',  'Onboarding complete'),
  ('hr_message_sent',      'Message sent to HR')
ON CONFLICT (code) DO NOTHING;

INSERT INTO employment_types (code, label) VALUES
  ('employee', 'Employee')
ON CONFLICT (code) DO NOTHING;

INSERT INTO identity_types (code, label) VALUES
  ('aad_federated',  'Azure AD (federated)'),
  ('field_employee', 'Field employee (OTP login)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO workflow_step_names (code, label) VALUES
  ('fetch_document',        'Fetch document'),
  ('pre_classify',          'Pre-classify certificate'),
  ('vision_extraction',     'Vision extraction'),
  ('match_employee',        'Employee matching'),
  ('match_cert_definition', 'Certificate definition matching'),
  ('persist_certification', 'Persist certification'),
  ('send_notification',     'Send notification')
ON CONFLICT (code) DO NOTHING;
