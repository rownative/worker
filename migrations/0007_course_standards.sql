-- Standard times for handicap scoring. One row per category per collection.
-- standard_time_s: reference time (seconds) for that category at nominal distance (e.g. 500m).
-- Corrected time = raw * (standard_ref / standard_athlete). Points = 100 * (standard_athlete / raw).
CREATE TABLE IF NOT EXISTS course_standards (
  collection_id   TEXT NOT NULL,
  boat_type       TEXT NOT NULL,
  sex             TEXT NOT NULL,
  weight_class    TEXT NOT NULL DEFAULT '',
  standard_time_s REAL NOT NULL,
  PRIMARY KEY (collection_id, boat_type, sex, weight_class)
);

CREATE INDEX IF NOT EXISTS idx_course_standards_collection ON course_standards(collection_id);
