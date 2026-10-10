CREATE TABLE IF NOT EXISTS designers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  access_token_hash text NOT NULL UNIQUE,
  calcom_event_type_id integer,
  active boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz
);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaani_call_id text NOT NULL UNIQUE,
  raw_payload jsonb NOT NULL,
  caller_phone text,
  started_at timestamptz,
  duration_seconds integer,
  transcript text,
  status text NOT NULL DEFAULT 'received',
  last_error text,
  delivery_count integer NOT NULL DEFAULT 1,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  outcome text NOT NULL,
  call_type text NOT NULL,
  criteria jsonb NOT NULL,
  decision_reasons jsonb NOT NULL,
  summary text NOT NULL,
  handoff_note text,
  caller_name text,
  caller_email text,
  project_summary text,
  uncertainties jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL UNIQUE REFERENCES calls(id),
  designer_id uuid REFERENCES designers(id),
  booking_status text NOT NULL DEFAULT 'pending',
  booking_attempts integer NOT NULL DEFAULT 0,
  booking_attempted_at timestamptz,
  calcom_booking_uid text,
  scheduled_start timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'sending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, kind)
);
