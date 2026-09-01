CREATE TABLE run_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  kind text NOT NULL CHECK (kind IN ('replay_plan')),
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 2 AND 1048576),
  logical_id text CHECK (logical_id IS NULL OR logical_id ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind)
);

CREATE INDEX run_artifacts_sha256_idx ON run_artifacts (sha256);

CREATE TABLE run_results (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  outcome text NOT NULL CHECK (outcome IN (
    'candidate_only_violation', 'shared_violation', 'no_reproduced_candidate_violation',
    'no_suspicion', 'provider_stopped', 'inconclusive'
  )),
  projection jsonb NOT NULL,
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 2 AND 262144),
  created_at timestamptz NOT NULL DEFAULT now()
);
