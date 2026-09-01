package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIdentifiersAndTokens(t *testing.T) {
	id, err := runID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 61 || !strings.Contains(id, "Z-") {
		t.Fatalf("unexpected run id %q", id)
	}
	token, hash, err := leaseToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 || !checkLease(hash, token) || checkLease(hash, token+"x") {
		t.Fatal("lease token hashing failed")
	}
}

func TestDecodeRejectsTrailingData(t *testing.T) {
	for _, body := range []string{`{"value":1}{"value":2}`, `{"value":1} trailing`} {
		request := httptest.NewRequest("POST", "/", strings.NewReader(body))
		response := httptest.NewRecorder()
		var target struct {
			Value int `json:"value"`
		}
		if decode(response, request, &target) == nil {
			t.Fatalf("accepted trailing data in %q", body)
		}
	}
}

func TestSupportedOutcomes(t *testing.T) {
	for _, value := range []string{"candidate_only_violation", "no_suspicion", "inconclusive"} {
		if !supportedOutcome(value) {
			t.Fatalf("expected %s", value)
		}
	}
	for _, value := range []string{"", "success", "passed"} {
		if supportedOutcome(value) {
			t.Fatalf("unexpected %s", value)
		}
	}
}

func TestBounded(t *testing.T) {
	if !bounded("worker-1", 100) || bounded(" worker-1", 100) || bounded("", 100) || bounded(strings.Repeat("x", 101), 100) {
		t.Fatal("bounded validation failed")
	}
}

func TestStreamIdentifiersRejectLineInjection(t *testing.T) {
	if !workerIDPattern.MatchString("worker-1") || !eventIDPattern.MatchString("attempt.1:event-2") || !eventTypePattern.MatchString("trial_started") {
		t.Fatal("expected safe identifiers")
	}
	for _, value := range []string{"trial\nstarted", "TrialStarted", "trial started", ""} {
		if eventTypePattern.MatchString(value) {
			t.Fatalf("accepted unsafe event type %q", value)
		}
	}
}
