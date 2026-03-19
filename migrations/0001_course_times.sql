CREATE TABLE IF NOT EXISTS course_times (
  id              TEXT PRIMARY KEY,
  athlete_id      TEXT NOT NULL,
  activity_id     TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  time_s          REAL NOT NULL,
  distance_m      REAL NOT NULL,
  validation_note TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE(athlete_id, activity_id, course_id)
);
