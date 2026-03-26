-- Add course_distance_m for Rowsandall-compatible reference_speed (m/s = course_distance / standard_time).
-- Default 500 for existing rows (built-in equivalent).
ALTER TABLE course_standards ADD COLUMN course_distance_m REAL NOT NULL DEFAULT 500;
