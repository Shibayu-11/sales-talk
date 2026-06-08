PRAGMA foreign_keys = ON;

CREATE TABLE auth_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  password_updated_at TEXT NOT NULL,
  login_failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

