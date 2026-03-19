-- Add workout_date to store the activity date (when the workout was done), not when it was calculated
ALTER TABLE course_times ADD COLUMN workout_date TEXT;
