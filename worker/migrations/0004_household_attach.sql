ALTER TABLE users ADD COLUMN household_code TEXT;
ALTER TABLE users ADD COLUMN member_slot TEXT;
ALTER TABLE allowed_emails ADD COLUMN household_code TEXT;
ALTER TABLE allowed_emails ADD COLUMN member_slot TEXT;
