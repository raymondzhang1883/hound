package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

var (
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
	errStaleLease = errors.New("stale_lease")
)

var (
	workerIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`)
	eventIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`)
	eventTypePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
)

type config struct {
	listen        string
	databaseURL   string
	workerKey     string
	leaseDuration time.Duration
}

type store struct {
	pool          *pgxpool.Pool
	leaseDuration time.Duration
}
type server struct {
	store     *store
	workerKey string
	logger    *slog.Logger
}

type run struct {
	ID         string     `json:"id"`
	Case       string     `json:"case"`
	MaxCostUSD float64    `json:"maxCostUsd"`
	MaxTrials  int        `json:"maxTrials"`
	Status     string     `json:"status"`
	Outcome    *string    `json:"outcome,omitempty"`
	Reason     *string    `json:"reason,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Job        job        `json:"job"`
}

type job struct {
	ID             string     `json:"id"`
	Status         string     `json:"status"`
	Attempt        int        `json:"attempt"`
	MaxAttempts    int        `json:"maxAttempts"`
	LeaseEpoch     int64      `json:"leaseEpoch"`
	LeaseOwner     *string    `json:"leaseOwner,omitempty"`
	LeaseExpiresAt *time.Time `json:"leaseExpiresAt,omitempty"`
}

type lease struct {
	JobID          string    `json:"jobId"`
	RunID          string    `json:"runId"`
	Attempt        int       `json:"attempt"`
	LeaseEpoch     int64     `json:"leaseEpoch"`
	LeaseToken     string    `json:"leaseToken"`
	LeaseExpiresAt time.Time `json:"leaseExpiresAt"`
	Case           string    `json:"case"`
	MaxCostUSD     float64   `json:"maxCostUsd"`
	MaxTrials      int       `json:"maxTrials"`
}

type event struct {
	Sequence      int64     `json:"sequence"`
	RunID         string    `json:"runId"`
	JobID         string    `json:"jobId"`
	Attempt       int       `json:"attempt"`
	WorkerEventID string    `json:"workerEventId"`
	Type          string    `json:"type"`
	Summary       string    `json:"summary"`
	OccurredAt    time.Time `json:"occurredAt"`
	CreatedAt     time.Time `json:"createdAt"`
}

func envConfig() (config, error) {
	c := config{listen: os.Getenv("HOUND_LISTEN_ADDR"), databaseURL: os.Getenv("HOUND_DATABASE_URL"), workerKey: os.Getenv("HOUND_WORKER_KEY"), leaseDuration: 30 * time.Second}
	if c.listen == "" {
		c.listen = "127.0.0.1:8090"
	}
	if c.databaseURL == "" {
		return c, errors.New("HOUND_DATABASE_URL is required")
	}
	if len(c.workerKey) < 32 {
		return c, errors.New("HOUND_WORKER_KEY must contain at least 32 characters")
	}
	if raw := os.Getenv("HOUND_LEASE_DURATION"); raw != "" {
		duration, err := time.ParseDuration(raw)
		if err != nil || duration < time.Second || duration > 5*time.Minute {
			return c, errors.New("HOUND_LEASE_DURATION must be from 1s to 5m")
		}
		c.leaseDuration = duration
	}
	return c, nil
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	h := hex.EncodeToString(value)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:]), nil
}

func runID() (string, error) {
	id, err := randomID()
	if err != nil {
		return "", err
	}
	return time.Now().UTC().Format("2006-01-02T15-04-05.000Z") + "-" + id, nil
}
func leaseToken() (string, []byte, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(value)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:], nil
}
func tokenHash(value string) []byte { sum := sha256.Sum256([]byte(value)); return sum[:] }

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, path := range files {
		version := strings.TrimSuffix(strings.TrimPrefix(path, "migrations/"), ".sql")
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&exists); err == nil && !exists {
			var body []byte
			body, err = migrations.ReadFile(path)
			if err == nil {
				_, err = tx.Exec(ctx, string(body))
			}
			if err == nil {
				_, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, version)
			}
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", version, err)
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) createRun(ctx context.Context, caseName string, cost float64, trials int) (run, error) {
	rid, err := runID()
	if err != nil {
		return run{}, err
	}
	jid, err := randomID()
	if err != nil {
		return run{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return run{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO runs(id,case_name,max_cost_usd,max_trials,status) VALUES($1,$2,$3,$4,'queued')`, rid, caseName, cost, trials); err != nil {
		return run{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO jobs(id,run_id,kind,status) VALUES($1,$2,'hunt','queued')`, jid, rid); err != nil {
		return run{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return run{}, err
	}
	return s.getRun(ctx, rid)
}

func (s *store) getRun(ctx context.Context, id string) (run, error) {
	var r run
	err := s.pool.QueryRow(ctx, `SELECT r.id,r.case_name,r.max_cost_usd::float8,r.max_trials,r.status,r.outcome,r.reason,r.created_at,r.started_at,r.finished_at,
		j.id,j.status,j.attempt,j.max_attempts,j.lease_epoch,j.lease_owner,j.lease_expires_at FROM runs r JOIN jobs j ON j.run_id=r.id WHERE r.id=$1`, id).Scan(
		&r.ID, &r.Case, &r.MaxCostUSD, &r.MaxTrials, &r.Status, &r.Outcome, &r.Reason, &r.CreatedAt, &r.StartedAt, &r.FinishedAt,
		&r.Job.ID, &r.Job.Status, &r.Job.Attempt, &r.Job.MaxAttempts, &r.Job.LeaseEpoch, &r.Job.LeaseOwner, &r.Job.LeaseExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return run{}, errNotFound
	}
	return r, err
}

func (s *store) listRuns(ctx context.Context, limit int) ([]run, error) {
	rows, err := s.pool.Query(ctx, `SELECT r.id,r.case_name,r.max_cost_usd::float8,r.max_trials,r.status,r.outcome,r.reason,r.created_at,r.started_at,r.finished_at,
		j.id,j.status,j.attempt,j.max_attempts,j.lease_epoch,j.lease_owner,j.lease_expires_at FROM runs r JOIN jobs j ON j.run_id=r.id ORDER BY r.created_at DESC,r.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []run{}
	for rows.Next() {
		var r run
		if err = rows.Scan(&r.ID, &r.Case, &r.MaxCostUSD, &r.MaxTrials, &r.Status, &r.Outcome, &r.Reason, &r.CreatedAt, &r.StartedAt, &r.FinishedAt,
			&r.Job.ID, &r.Job.Status, &r.Job.Attempt, &r.Job.MaxAttempts, &r.Job.LeaseEpoch, &r.Job.LeaseOwner, &r.Job.LeaseExpiresAt); err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}

func (s *store) lease(ctx context.Context, owner string) (*lease, error) {
	token, hash, err := leaseToken()
	if err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `WITH exhausted AS (
		UPDATE jobs SET status='failed',finished_at=now(),updated_at=now() WHERE status IN ('leased','running') AND lease_expires_at<=now() AND attempt>=max_attempts RETURNING run_id
	) UPDATE runs SET status='failed',reason='attempts_exhausted',finished_at=now(),updated_at=now() WHERE id IN (SELECT run_id FROM exhausted)`)
	if err != nil {
		return nil, err
	}
	var item lease
	err = tx.QueryRow(ctx, `SELECT j.id,j.run_id,j.attempt+1,j.lease_epoch+1,r.case_name,r.max_cost_usd::float8,r.max_trials
		FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.status='queued' OR (j.status IN ('leased','running') AND j.lease_expires_at<=now() AND j.attempt<j.max_attempts)
		ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`).Scan(&item.JobID, &item.RunID, &item.Attempt, &item.LeaseEpoch, &item.Case, &item.MaxCostUSD, &item.MaxTrials)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.LeaseToken = token
	item.LeaseExpiresAt = time.Now().UTC().Add(s.leaseDuration)
	command, err := tx.Exec(ctx, `UPDATE jobs SET status='leased',attempt=$2,lease_epoch=$3,lease_owner=$4,lease_token_hash=$5,lease_expires_at=$6,updated_at=now(),finished_at=NULL WHERE id=$1`,
		item.JobID, item.Attempt, item.LeaseEpoch, owner, hash, item.LeaseExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("claim update: %w", err)
	}
	if command.RowsAffected() != 1 {
		return nil, errors.New("claim update affected no rows")
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET status='running',started_at=COALESCE(started_at,now()),finished_at=NULL,reason=NULL,updated_at=now() WHERE id=$1`, item.RunID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &item, nil
}

func checkLease(stored []byte, supplied string) bool {
	candidate := tokenHash(supplied)
	return len(stored) == len(candidate) && subtle.ConstantTimeCompare(stored, candidate) == 1
}

func (s *store) start(ctx context.Context, jobID, token string, epoch int64) error {
	command, err := s.pool.Exec(ctx, `UPDATE jobs SET status='running',updated_at=now() WHERE id=$1 AND lease_epoch=$2 AND lease_token_hash=$3 AND status IN ('leased','running') AND lease_expires_at>now()`, jobID, epoch, tokenHash(token))
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errStaleLease
	}
	return nil
}
func (s *store) heartbeat(ctx context.Context, jobID, token string, epoch int64) (time.Time, error) {
	expires := time.Now().UTC().Add(s.leaseDuration)
	command, err := s.pool.Exec(ctx, `UPDATE jobs SET lease_expires_at=$4,updated_at=now() WHERE id=$1 AND lease_epoch=$2 AND lease_token_hash=$3 AND status IN ('leased','running') AND lease_expires_at>now()`, jobID, epoch, tokenHash(token), expires)
	if err != nil {
		return time.Time{}, err
	}
	if command.RowsAffected() != 1 {
		return time.Time{}, errStaleLease
	}
	return expires, nil
}

func (s *store) addEvent(ctx context.Context, jobID, token string, epoch int64, input event) (event, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return event{}, err
	}
	defer tx.Rollback(ctx)
	var runID string
	var attempt int
	err = tx.QueryRow(ctx, `SELECT run_id,attempt FROM jobs WHERE id=$1 AND lease_epoch=$2 AND lease_token_hash=$3 AND status='running' AND lease_expires_at>now() FOR UPDATE`, jobID, epoch, tokenHash(token)).Scan(&runID, &attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return event{}, errStaleLease
	}
	if err != nil {
		return event{}, err
	}
	input.RunID = runID
	input.JobID = jobID
	input.Attempt = attempt
	err = tx.QueryRow(ctx, `INSERT INTO run_events(run_id,job_id,attempt,worker_event_id,event_type,summary,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT(job_id,attempt,worker_event_id) DO NOTHING RETURNING sequence,created_at`, runID, jobID, attempt, input.WorkerEventID, input.Type, input.Summary, input.OccurredAt).Scan(&input.Sequence, &input.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var existing event
		err = tx.QueryRow(ctx, `SELECT sequence,run_id,job_id,attempt,worker_event_id,event_type,summary,occurred_at,created_at FROM run_events WHERE job_id=$1 AND attempt=$2 AND worker_event_id=$3`, jobID, attempt, input.WorkerEventID).Scan(
			&existing.Sequence, &existing.RunID, &existing.JobID, &existing.Attempt, &existing.WorkerEventID, &existing.Type, &existing.Summary, &existing.OccurredAt, &existing.CreatedAt)
		if err != nil {
			return event{}, err
		}
		if existing.Type != input.Type || existing.Summary != input.Summary || !existing.OccurredAt.Equal(input.OccurredAt) {
			return event{}, errConflict
		}
		input = existing
	} else if err != nil {
		return event{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return event{}, err
	}
	return input, nil
}

func (s *store) complete(ctx context.Context, jobID, token string, epoch int64, state, outcome, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var runID, status string
	var stored []byte
	var currentOutcome, currentReason *string
	var expiresAt *time.Time
	err = tx.QueryRow(ctx, `SELECT j.run_id,j.status,j.lease_token_hash,j.lease_expires_at,r.outcome,r.reason FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.id=$1 AND j.lease_epoch=$2 FOR UPDATE OF j,r`, jobID, epoch).Scan(&runID, &status, &stored, &expiresAt, &currentOutcome, &currentReason)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !checkLease(stored, token) {
		return errStaleLease
	}
	if err != nil {
		return err
	}
	if status == "completed" || status == "failed" {
		if state == status && value(currentOutcome) == outcome && value(currentReason) == reason {
			return tx.Commit(ctx)
		}
		return errConflict
	}
	if status != "running" {
		return errConflict
	}
	if expiresAt == nil || !expiresAt.After(time.Now()) {
		return errStaleLease
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1`, jobID, state); err != nil {
		return err
	}
	runStatus := state
	var outcomeValue any = outcome
	if outcome == "" {
		outcomeValue = nil
	}
	var reasonValue any = reason
	if reason == "" {
		reasonValue = nil
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET status=$2,outcome=$3,reason=$4,finished_at=now(),updated_at=now() WHERE id=$1`, runID, runStatus, outcomeValue, reasonValue); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func value(input *string) string {
	if input == nil {
		return ""
	}
	return *input
}

func (s *store) cancel(ctx context.Context, runID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var runStatus string
	var jobID, jobStatus string
	err = tx.QueryRow(ctx, `SELECT r.status,j.id,j.status FROM runs r JOIN jobs j ON j.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r,j`, runID).Scan(&runStatus, &jobID, &jobStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if runStatus == "cancelled" && jobStatus == "cancelled" {
		return tx.Commit(ctx)
	}
	if runStatus == "completed" || runStatus == "failed" {
		return errConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE id=$1`, jobID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE runs SET status='cancelled',outcome='cancelled',reason='operator_cancelled',finished_at=now(),updated_at=now() WHERE id=$1`, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *store) events(ctx context.Context, runID string, after int64, limit int) ([]event, error) {
	rows, err := s.pool.Query(ctx, `SELECT sequence,run_id,job_id,attempt,worker_event_id,event_type,summary,occurred_at,created_at FROM run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, runID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []event{}
	for rows.Next() {
		var item event
		if err = rows.Scan(&item.Sequence, &item.RunID, &item.JobID, &item.Attempt, &item.WorkerEventID, &item.Type, &item.Summary, &item.OccurredAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func decode(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing_json_data")
	}
	return nil
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}
func problem(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code}})
}
func bearer(r *http.Request) string {
	const prefix = "Bearer "
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(value, prefix))
}
func epoch(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.Header.Get("X-Hound-Lease-Epoch"), 10, 64)
}
func bounded(value string, max int) bool {
	return len(value) > 0 && len(value) <= max && strings.TrimSpace(value) == value
}
func supportedOutcome(value string) bool {
	return map[string]bool{"candidate_only_violation": true, "shared_violation": true, "no_reproduced_candidate_violation": true, "no_suspicion": true, "provider_stopped": true, "inconclusive": true, "cancelled": true}[value]
}
func (s *server) worker(r *http.Request) bool {
	return len(r.Header.Get("X-Hound-Worker-Key")) == len(s.workerKey) && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Hound-Worker-Key")), []byte(s.workerKey)) == 1
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := s.store.pool.Ping(ctx); err != nil {
			problem(w, 503, "database_unavailable")
			return
		}
		respond(w, 200, map[string]any{"status": "ready", "version": 1})
	})
	mux.HandleFunc("POST /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Case       string  `json:"case"`
			MaxCostUSD float64 `json:"maxCostUsd"`
			MaxTrials  int     `json:"maxTrials"`
		}
		if decode(w, r, &input) != nil {
			problem(w, 400, "invalid_json")
			return
		}
		if input.Case != "positive" && input.Case != "negative" || input.MaxCostUSD <= 0 || input.MaxCostUSD > 10 || input.MaxTrials < 1 || input.MaxTrials > 3 {
			problem(w, 422, "invalid_run")
			return
		}
		item, err := s.store.createRun(r.Context(), input.Case, input.MaxCostUSD, input.MaxTrials)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 201, item)
	})
	mux.HandleFunc("GET /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		limit := 20
		if raw := r.URL.Query().Get("limit"); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 || value > 100 {
				problem(w, 400, "invalid_limit")
				return
			}
			limit = value
		}
		items, err := s.store.listRuns(r.Context(), limit)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]any{"runs": items})
	})
	mux.HandleFunc("GET /v1/runs/{runID}", func(w http.ResponseWriter, r *http.Request) {
		item, err := s.store.getRun(r.Context(), r.PathValue("runID"))
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, item)
	})
	mux.HandleFunc("POST /v1/runs/{runID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.cancel(r.Context(), r.PathValue("runID")); err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]string{"status": "cancelled"})
	})
	mux.HandleFunc("GET /v1/runs/{runID}/events", s.eventRead)
	mux.HandleFunc("POST /v1/jobs/lease", func(w http.ResponseWriter, r *http.Request) {
		if !s.worker(r) {
			problem(w, 401, "worker_unauthorized")
			return
		}
		var input struct {
			WorkerID string `json:"workerId"`
		}
		if decode(w, r, &input) != nil || !workerIDPattern.MatchString(input.WorkerID) {
			problem(w, 422, "invalid_worker")
			return
		}
		item, err := s.store.lease(r.Context(), input.WorkerID)
		if err != nil {
			s.fail(w, err)
			return
		}
		if item == nil {
			w.WriteHeader(204)
			return
		}
		respond(w, 200, item)
	})
	mux.HandleFunc("POST /v1/jobs/{jobID}/start", func(w http.ResponseWriter, r *http.Request) {
		e, err := epoch(r)
		if err != nil {
			problem(w, 400, "invalid_lease")
			return
		}
		if err = s.store.start(r.Context(), r.PathValue("jobID"), bearer(r), e); err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]string{"status": "running"})
	})
	mux.HandleFunc("POST /v1/jobs/{jobID}/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		e, err := epoch(r)
		if err != nil {
			problem(w, 400, "invalid_lease")
			return
		}
		expires, err := s.store.heartbeat(r.Context(), r.PathValue("jobID"), bearer(r), e)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]any{"status": "ok", "leaseExpiresAt": expires})
	})
	mux.HandleFunc("POST /v1/jobs/{jobID}/events", func(w http.ResponseWriter, r *http.Request) {
		e, err := epoch(r)
		if err != nil {
			problem(w, 400, "invalid_lease")
			return
		}
		var input event
		now := time.Now()
		if decode(w, r, &input) != nil || !eventIDPattern.MatchString(input.WorkerEventID) || !eventTypePattern.MatchString(input.Type) || !bounded(input.Summary, 240) || input.OccurredAt.Before(now.Add(-24*time.Hour)) || input.OccurredAt.After(now.Add(time.Minute)) {
			problem(w, 422, "invalid_event")
			return
		}
		item, err := s.store.addEvent(r.Context(), r.PathValue("jobID"), bearer(r), e, input)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, item)
	})
	mux.HandleFunc("POST /v1/jobs/{jobID}/complete", func(w http.ResponseWriter, r *http.Request) {
		e, err := epoch(r)
		if err != nil {
			problem(w, 400, "invalid_lease")
			return
		}
		var input struct {
			State   string `json:"state"`
			Outcome string `json:"outcome"`
			Reason  string `json:"reason"`
		}
		if decode(w, r, &input) != nil {
			problem(w, 400, "invalid_json")
			return
		}
		valid := input.State == "completed" && supportedOutcome(input.Outcome) && input.Outcome != "cancelled" && input.Reason == "" || input.State == "failed" && input.Outcome == "" && bounded(input.Reason, 120)
		if !valid {
			problem(w, 422, "invalid_completion")
			return
		}
		if err = s.store.complete(r.Context(), r.PathValue("jobID"), bearer(r), e, input.State, input.Outcome, input.Reason); err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]string{"status": input.State})
	})
	return mux
}

func (s *server) eventRead(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if after < 0 {
		problem(w, 400, "invalid_event_cursor")
		return
	}
	if _, err := s.store.getRun(r.Context(), r.PathValue("runID")); err != nil {
		s.fail(w, err)
		return
	}
	follow := r.URL.Query().Get("follow") == "true" || strings.Contains(r.Header.Get("Accept"), "text/event-stream")
	if !follow {
		items, err := s.store.events(r.Context(), r.PathValue("runID"), after, 500)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, map[string]any{"events": items})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		problem(w, 500, "stream_unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	for {
		items, err := s.store.events(r.Context(), r.PathValue("runID"), after, 100)
		if err != nil {
			return
		}
		for _, item := range items {
			body, _ := json.Marshal(item)
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", item.Sequence, item.Type, body)
			after = item.Sequence
		}
		if len(items) > 0 {
			flusher.Flush()
		}
		item, err := s.store.getRun(r.Context(), r.PathValue("runID"))
		if err != nil {
			return
		}
		if (item.Status == "completed" || item.Status == "failed" || item.Status == "cancelled") && len(items) == 0 {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		case <-heartbeat.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
func (s *server) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotFound):
		problem(w, 404, "not_found")
	case errors.Is(err, errStaleLease):
		problem(w, 409, "stale_lease")
	case errors.Is(err, errConflict):
		problem(w, 409, "conflict")
	default:
		s.logger.Error("request failed", "error", err)
		problem(w, 500, "internal_error")
	}
}

func main() {
	cfg, err := envConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "database configuration failed")
		os.Exit(1)
	}
	defer pool.Close()
	if err = migrate(ctx, pool); err != nil {
		fmt.Fprintln(os.Stderr, "database migration failed")
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	app := &server{store: &store{pool: pool, leaseDuration: cfg.leaseDuration}, workerKey: cfg.workerKey, logger: logger}
	httpServer := &http.Server{Addr: cfg.listen, Handler: app.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 0, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = httpServer.Shutdown(shutdown)
	}()
	logger.Info("control plane ready", "address", cfg.listen, "leaseDuration", cfg.leaseDuration.String())
	if err = httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
