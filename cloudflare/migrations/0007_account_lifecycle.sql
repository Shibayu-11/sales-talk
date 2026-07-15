PRAGMA foreign_keys = ON;

ALTER TABLE organization_memberships
ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
CHECK (status IN ('active', 'invited', 'disabled'));

CREATE INDEX memberships_status_idx
ON organization_memberships(tenant_id, organization_id, status);

CREATE UNIQUE INDEX organization_memberships_user_unique_idx
ON organization_memberships(user_id);

ALTER TABLE organization_memberships
ADD COLUMN status_changed_by_request_id TEXT;

ALTER TABLE auth_credentials
ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0
CHECK (must_reset_password IN (0, 1));

ALTER TABLE audit_logs
ADD COLUMN sequence INTEGER;

CREATE UNIQUE INDEX audit_logs_tenant_sequence_unique_idx
ON audit_logs(tenant_id, sequence)
WHERE sequence IS NOT NULL;

CREATE TABLE auth_action_tokens (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('invite', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  membership_id TEXT NOT NULL REFERENCES organization_memberships(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_request_id TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_by_membership_id TEXT REFERENCES organization_memberships(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX auth_action_tokens_lookup_idx
ON auth_action_tokens(type, token_hash, consumed_at, expires_at);

CREATE INDEX auth_action_tokens_scope_idx
ON auth_action_tokens(tenant_id, organization_id, membership_id, type, consumed_at);

CREATE INDEX auth_action_tokens_user_idx
ON auth_action_tokens(user_id, type, consumed_at, expires_at);
