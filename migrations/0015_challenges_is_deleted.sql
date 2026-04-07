-- Add is_deleted flag to challenges table
ALTER TABLE challenges ADD COLUMN is_deleted INTEGER DEFAULT 0 NOT NULL;

-- Create index for filtering deleted challenges
CREATE INDEX IF NOT EXISTS idx_challenges_is_deleted ON challenges(is_deleted);
