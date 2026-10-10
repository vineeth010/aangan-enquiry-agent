ALTER TABLE designers ADD COLUMN IF NOT EXISTS calendar_id text;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'enquiries' AND column_name = 'calcom_booking_uid') THEN ALTER TABLE enquiries RENAME COLUMN calcom_booking_uid TO calendar_event_id; END IF; END $$;
