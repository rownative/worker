-- Store downsampled GPS track for organiser overlay (avoids fetching another athlete's activity)
ALTER TABLE challenge_results ADD COLUMN track_latlng TEXT;
