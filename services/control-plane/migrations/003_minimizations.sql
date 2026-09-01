ALTER TABLE run_artifacts DROP CONSTRAINT run_artifacts_kind_check;
ALTER TABLE run_artifacts DROP CONSTRAINT run_artifacts_attempt_check;
ALTER TABLE run_artifacts ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE run_artifacts ALTER COLUMN attempt DROP NOT NULL;
ALTER TABLE run_artifacts ADD CONSTRAINT run_artifacts_kind_check CHECK (kind IN ('replay_plan', 'minimized_plan'));
ALTER TABLE run_artifacts ADD CONSTRAINT run_artifacts_attempt_check CHECK (attempt IS NULL OR attempt >= 1);
ALTER TABLE run_artifacts ADD CONSTRAINT run_artifacts_producer_check CHECK ((job_id IS NULL) = (attempt IS NULL));

CREATE TABLE run_minimizations (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  source_plan_id text NOT NULL CHECK (source_plan_id ~ '^[0-9a-f]{64}$'),
  minimized_plan_id text NOT NULL CHECK (minimized_plan_id ~ '^[0-9a-f]{64}$'),
  projection jsonb NOT NULL,
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 2 AND 131072),
  created_at timestamptz NOT NULL DEFAULT now()
);
