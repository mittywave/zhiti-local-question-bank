CREATE TABLE IF NOT EXISTS ai_provider_config (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  name TEXT NOT NULL DEFAULT 'AI Provider',
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  wire_api TEXT NOT NULL DEFAULT 'auto',
  model_catalog_json TEXT NOT NULL DEFAULT '[]',
  recognition_model TEXT NOT NULL DEFAULT '',
  text_model TEXT NOT NULL DEFAULT '',
  diagram_model TEXT NOT NULL DEFAULT '',
  grading_model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
