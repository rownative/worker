CREATE TABLE IF NOT EXISTS challenge_results (
  id                  TEXT PRIMARY KEY,
  challenge_id        TEXT NOT NULL,
  athlete_id          TEXT NOT NULL,
  activity_id         TEXT NOT NULL,
  display_name        TEXT,
  raw_time_s          REAL NOT NULL,
  corrected_time_s    REAL,
  points              REAL,
  boat_type           TEXT,
  sex                 TEXT,
  weight_class        TEXT,
  category_source     TEXT,
  start_time          TEXT,
  validation_status   TEXT NOT NULL,
  validation_note     TEXT,
  submitted_at        TEXT NOT NULL,
  UNIQUE(challenge_id, athlete_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_results_challenge ON challenge_results(challenge_id);
