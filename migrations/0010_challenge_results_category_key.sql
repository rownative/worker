-- One result per athlete per category. category_key = 'raw' for raw-time, or 'boat|sex|weight' for handicap.
-- Replaces UNIQUE(challenge_id, athlete_id, activity_id) with UNIQUE(challenge_id, athlete_id, category_key).
-- Deduplicate: keep best (lowest raw_time_s) per (challenge_id, athlete_id, category_key).

-- 1. Create new table with category_key and new UNIQUE
CREATE TABLE challenge_results_new (
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
  validation_status    TEXT NOT NULL,
  validation_note     TEXT,
  submitted_at        TEXT NOT NULL,
  track_latlng        TEXT,
  category_key        TEXT NOT NULL,
  UNIQUE(challenge_id, athlete_id, category_key)
);

-- 2. Backfill category_key and copy, keeping best per category
INSERT INTO challenge_results_new (
  id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s,
  points, boat_type, sex, weight_class, category_source, start_time, validation_status,
  validation_note, submitted_at, track_latlng, category_key
)
SELECT id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s,
  points, boat_type, sex, weight_class, category_source, start_time, validation_status,
  validation_note, submitted_at, track_latlng, category_key
FROM (
  SELECT *,
    CASE
      WHEN (boat_type IS NULL OR boat_type = '') AND (sex IS NULL OR sex = '')
      THEN 'raw'
      ELSE COALESCE(boat_type, '') || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '')
    END AS category_key,
    ROW_NUMBER() OVER (
      PARTITION BY challenge_id, athlete_id,
        CASE
          WHEN (boat_type IS NULL OR boat_type = '') AND (sex IS NULL OR sex = '')
          THEN 'raw'
          ELSE COALESCE(boat_type, '') || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '')
        END
      ORDER BY raw_time_s ASC
    ) AS rn
  FROM challenge_results
) WHERE rn = 1;

-- 3. Replace old table
DROP TABLE challenge_results;
ALTER TABLE challenge_results_new RENAME TO challenge_results;

-- 4. Recreate index
CREATE INDEX IF NOT EXISTS idx_challenge_results_challenge ON challenge_results(challenge_id);
