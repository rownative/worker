-- Fix category_key to include boat_type and display_name even for non-handicap challenges
-- Previous: handicap challenges used 'boat|sex|weight', raw challenges used 'raw' (causing overwrites)
-- New: all challenges use 'boat|display_name|sex|weight[|age_band]'

-- Recompute category_key for all existing results and deduplicate (keep best time per category)
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
  crew_avg_age        INTEGER,
  start_time          TEXT,
  validation_status   TEXT NOT NULL,
  validation_note     TEXT,
  submitted_at        TEXT NOT NULL,
  track_latlng        TEXT,
  category_key        TEXT NOT NULL,
  UNIQUE(challenge_id, athlete_id, category_key)
);

INSERT INTO challenge_results_new (
  id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s,
  points, boat_type, sex, weight_class, crew_avg_age, start_time, validation_status,
  validation_note, submitted_at, track_latlng, category_key
)
SELECT id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s,
  points, boat_type, sex, weight_class, crew_avg_age, start_time, validation_status,
  validation_note, submitted_at, track_latlng, new_category_key
FROM (
  SELECT *,
    CASE
      -- Old format with age band: 'boat|sex|weight|ageBand' → new: 'boat|displayName|sex|weight|ageBand'
      WHEN category_key LIKE '%|%|%|%' AND category_key != 'raw' THEN
        COALESCE(boat_type, '') || '|' || LOWER(COALESCE(TRIM(display_name), '')) || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '') || '|' || 
        SUBSTR(category_key, LENGTH(COALESCE(boat_type, '')) + LENGTH(COALESCE(sex, '')) + LENGTH(COALESCE(weight_class, '')) + 4)
      -- All other formats: 'boat|displayName|sex|weight'
      ELSE
        COALESCE(boat_type, '') || '|' || LOWER(COALESCE(TRIM(display_name), '')) || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '')
    END AS new_category_key,
    ROW_NUMBER() OVER (
      PARTITION BY 
        challenge_id, 
        athlete_id,
        CASE
          WHEN category_key LIKE '%|%|%|%' AND category_key != 'raw' THEN
            COALESCE(boat_type, '') || '|' || LOWER(COALESCE(TRIM(display_name), '')) || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '') || '|' || 
            SUBSTR(category_key, LENGTH(COALESCE(boat_type, '')) + LENGTH(COALESCE(sex, '')) + LENGTH(COALESCE(weight_class, '')) + 4)
          ELSE
            COALESCE(boat_type, '') || '|' || LOWER(COALESCE(TRIM(display_name), '')) || '|' || COALESCE(sex, '') || '|' || COALESCE(weight_class, '')
        END
      ORDER BY raw_time_s ASC
    ) AS rn
  FROM challenge_results
) WHERE rn = 1;

DROP TABLE challenge_results;
ALTER TABLE challenge_results_new RENAME TO challenge_results;

CREATE INDEX IF NOT EXISTS idx_challenge_results_challenge ON challenge_results(challenge_id);
