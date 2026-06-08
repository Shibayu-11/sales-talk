PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  parent_organization_id TEXT REFERENCES organizations(id),
  type TEXT NOT NULL CHECK (type IN ('insurer', 'agency', 'internal')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX organizations_tenant_idx ON organizations(tenant_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, organization_id, user_id)
);

CREATE INDEX memberships_context_idx
ON organization_memberships(tenant_id, organization_id, user_id);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source TEXT NOT NULL,
  industry TEXT NOT NULL,
  product_id TEXT NOT NULL,
  consent_status TEXT NOT NULL,
  consent_method TEXT,
  consent_captured_at TEXT,
  consent_notice_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX calls_scope_idx ON calls(tenant_id, organization_id, started_at DESC);

CREATE TABLE compliance_rule_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  parent_rule_set_id TEXT REFERENCES compliance_rule_sets(id),
  name TEXT NOT NULL,
  product_category TEXT NOT NULL,
  preset_key TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL,
  approved_at TEXT,
  approved_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX rule_sets_scope_idx
ON compliance_rule_sets(tenant_id, organization_id, product_category, approval_status);

CREATE TABLE compliance_rules (
  id TEXT PRIMARY KEY,
  rule_set_id TEXT NOT NULL REFERENCES compliance_rule_sets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  industry TEXT NOT NULL,
  product_category TEXT NOT NULL,
  severity TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  reason TEXT NOT NULL,
  recommended_phrase TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX rules_rule_set_priority_idx ON compliance_rules(rule_set_id, priority);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  actor_membership_id TEXT REFERENCES organization_memberships(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_logs_scope_idx
ON audit_logs(tenant_id, organization_id, created_at DESC);
