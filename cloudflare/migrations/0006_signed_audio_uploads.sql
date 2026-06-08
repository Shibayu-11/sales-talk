PRAGMA foreign_keys = ON;

CREATE TABLE pending_audio_uploads (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  audio_asset_id TEXT NOT NULL,
  stt_job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX pending_audio_uploads_scope_idx
ON pending_audio_uploads(tenant_id, organization_id, created_at DESC);

CREATE INDEX pending_audio_uploads_status_idx
ON pending_audio_uploads(status, expires_at);

