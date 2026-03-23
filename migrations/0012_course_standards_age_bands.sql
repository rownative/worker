-- Add age_min, age_max for Rowsandall-style age-band standards (e.g. KNRB).
-- -1 and 999 are sentinels for "no age limit" (backward compatible with existing rows).
-- PK extended so multiple age bands per (boat, sex, weight) are allowed.

-- 1. Create new table with age columns and extended PK
CREATE TABLE course_standards_new (
  collection_id    TEXT NOT NULL,
  boat_type        TEXT NOT NULL,
  sex              TEXT NOT NULL,
  weight_class     TEXT NOT NULL DEFAULT '',
  age_min          INTEGER NOT NULL DEFAULT -1,
  age_max          INTEGER NOT NULL DEFAULT 999,
  standard_time_s  REAL NOT NULL,
  course_distance_m REAL NOT NULL DEFAULT 500,
  PRIMARY KEY (collection_id, boat_type, sex, weight_class, age_min, age_max)
);

-- 2. Copy existing rows with age-agnostic sentinels
INSERT INTO course_standards_new (
  collection_id, boat_type, sex, weight_class, age_min, age_max, standard_time_s, course_distance_m
)
SELECT collection_id, boat_type, sex, weight_class, -1, 999, standard_time_s, course_distance_m
FROM course_standards;

-- 3. Replace old table
DROP TABLE course_standards;
ALTER TABLE course_standards_new RENAME TO course_standards;

-- 4. Recreate index
CREATE INDEX IF NOT EXISTS idx_course_standards_collection ON course_standards(collection_id);
