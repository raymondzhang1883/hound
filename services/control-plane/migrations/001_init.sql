CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  case_name text NOT NULL CHECK (case_name IN ('positive', 'negative')),
  max_cost_usd numeric(12, 6) NOT NULL CHECK (max_cost_usd > 0 AND max_cost_usd <= 10),
  max_trials integer NOT NULL CHECK (max_trials BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'candidate_only_violation', 'shared_violation', 'no_reproduced_candidate_violation',
    'no_suspicion', 'provider_stopped', 'inconclusive', 'cancelled'
  )),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'completed' AND outcome IS NOT NULL) OR status <> 'completed'),
  CHECK ((status = 'completed' AND finished_at IS NOT NULL) OR status <> 'completed'),
  CHECK ((status IN ('failed', 'cancelled') AND finished_at IS NOT NULL) OR status NOT IN ('failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'hunt'),
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner text,
  lease_token_hash bytea,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status IN ('leased', 'running') AND lease_owner IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status NOT IN ('leased', 'running'))
);

CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs (created_at, id)
  WHERE status IN ('queued', 'leased', 'running');

CREATE TABLE IF NOT EXISTS run_events (
  sequence bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  worker_event_id text NOT NULL CHECK (length(worker_event_id) BETWEEN 1 AND 100),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 240),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt, worker_event_id)
);

CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx ON run_events (run_id, sequence);
