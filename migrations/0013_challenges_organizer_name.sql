-- Display name at creation time (intervals.icu profile); avoids "Anonymous" on challenge pages.
ALTER TABLE challenges ADD COLUMN organizer_name TEXT;
