PRAGMA foreign_keys = ON;

CREATE TABLE audio_assets (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audio_assets_call_idx ON audio_assets(call_id, created_at DESC);

CREATE TABLE stt_jobs (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id),
  audio_asset_id TEXT NOT NULL REFERENCES audio_assets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX stt_jobs_call_idx ON stt_jobs(call_id, created_at DESC);
CREATE INDEX stt_jobs_status_idx ON stt_jobs(status, updated_at DESC);

CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  is_final INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX transcript_segments_call_idx ON transcript_segments(call_id, start_ms ASC);

