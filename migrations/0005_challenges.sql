CREATE TABLE IF NOT EXISTS challenges (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  row_start       TEXT NOT NULL,
  row_end         TEXT NOT NULL,
  submit_end      TEXT NOT NULL,
  collection_id   TEXT,
  organizer_id    TEXT NOT NULL,
  is_public       INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenges_row_start ON challenges(row_start);
CREATE INDEX IF NOT EXISTS idx_challenges_submit_end ON challenges(submit_end);
CREATE INDEX IF NOT EXISTS idx_challenges_organizer ON challenges(organizer_id);
