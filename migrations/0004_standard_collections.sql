CREATE TABLE IF NOT EXISTS standard_collections (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  organizer_id    TEXT,
  created_at      TEXT NOT NULL
);
