-- Field agents may request an admin review of an entry without deleting it.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS review_requested_at timestamptz;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS review_requested_by text;
