PRAGMA foreign_keys = ON;

CREATE TABLE auth_action_deliveries (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'failed', 'cancelled')),
  provider_message_id TEXT,
  error_code TEXT,
  attempted_at TEXT,
  accepted_at TEXT,
  failed_at TEXT,
  token_id TEXT NOT NULL REFERENCES auth_action_tokens(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  membership_id TEXT NOT NULL REFERENCES organization_memberships(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX auth_action_deliveries_token_idx
ON auth_action_deliveries(token_id);

CREATE INDEX auth_action_deliveries_scope_status_idx
ON auth_action_deliveries(tenant_id, organization_id, membership_id, status, updated_at);

CREATE INDEX auth_action_deliveries_user_status_idx
ON auth_action_deliveries(user_id, status, updated_at);

ALTER TABLE auth_credentials
ADD COLUMN active_password_reset_token_id TEXT REFERENCES auth_action_tokens(id);

CREATE INDEX auth_credentials_active_password_reset_token_idx
ON auth_credentials(active_password_reset_token_id)
WHERE active_password_reset_token_id IS NOT NULL;
