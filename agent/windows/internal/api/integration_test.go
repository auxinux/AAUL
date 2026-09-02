//go:build integration

package api

import (
	"os"
	"testing"

	"aaul-agent/internal/config"
)

// This test talks to a real dashboard. It is the only way to prove the agent's
// request signing is accepted by the actual middleware
// (dashboard/server/middleware/auth.js) rather than by a stub that agrees with
// us by construction — the failure mode being guarded against is precisely the
// two implementations drifting apart.
//
// Run it against a dashboard started with a scratch database:
//
//	AAUL_IT_URL=http://127.0.0.1:3999 \
//	AAUL_IT_AGENT_ID=it-agent-1 \
//	AAUL_IT_TOKEN=... \
//	go test -tags integration ./internal/api/
//
// The token must be ASCII, which real ones are: the dashboard mints them with
// crypto.randomBytes().toString("base64url") (server/utils/tokens.js:5), and it
// travels in an Authorization header.
func newIntegrationClient(t *testing.T) (*Client, string) {
	t.Helper()
	url := os.Getenv("AAUL_IT_URL")
	agentID := os.Getenv("AAUL_IT_AGENT_ID")
	token := os.Getenv("AAUL_IT_TOKEN")
	if url == "" || agentID == "" || token == "" {
		t.Skip("AAUL_IT_URL, AAUL_IT_AGENT_ID and AAUL_IT_TOKEN must all be set")
	}
	return New(&config.Config{
		AgentID:       agentID,
		DashboardURL:  url,
		AgentAPIToken: token,
	}), agentID
}

type pollReply struct {
	OK                 bool   `json:"ok"`
	LatestAgentVersion string `json:"latestAgentVersion"`
	Logs               *struct {
		RetentionDays int `json:"retentionDays"`
		MaxTotalMb    int `json:"maxTotalMb"`
	} `json:"logs"`
	Command *struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	} `json:"command"`
}

func TestPollIsAcceptedByTheDashboard(t *testing.T) {
	client, agentID := newIntegrationClient(t)

	// A payload with the awkward values: accents that Python would have escaped
	// as \uXXXX and Go does not, and characters encoding/json escapes by
	// default. Both only work because the server hashes the raw bytes.
	payload := map[string]any{
		"agentId":        agentID,
		"displayName":    "Poste Réception — café <&>",
		"hostname":       "WIN-TEST-01",
		"ip":             "192.168.1.42",
		"agentVersion":   "0.9.1",
		"lastSeenAt":     "2026-09-02T12:00:00.000000Z",
		"lastRunAt":      nil,
		"lastStatus":     nil,
		"schedule":       map[string]any{"enabled": true, "dailyTime": "03:00"},
		"uptimeSeconds":  123456,
		"rebootRequired": false,
		"metrics": map[string]any{
			"cpuPercent":  12.5,
			"loadAverage": nil,
			"memory":      map[string]any{"totalBytes": 8589934592, "percent": 41.2},
		},
	}

	var reply pollReply
	if err := client.Post("/api/agent/poll", payload, &reply, nil); err != nil {
		t.Fatalf("the dashboard rejected the signed poll: %v", err)
	}
	if !reply.OK {
		t.Errorf("poll not acknowledged: %+v", reply)
	}
	// The reply is signed too, and Post only returns once that signature has
	// been verified — reaching this line proves both directions agree.
	if reply.Logs == nil {
		t.Error("the poll response carried no log retention policy")
	}
}

func TestSkipCommandHeaderIsHonoured(t *testing.T) {
	client, agentID := newIntegrationClient(t)

	var reply pollReply
	err := client.Post("/api/agent/poll",
		map[string]any{"agentId": agentID, "hostname": "WIN-TEST-01"},
		&reply,
		map[string]string{"X-Skip-Command": "true"})
	if err != nil {
		t.Fatalf("the dashboard rejected the poll: %v", err)
	}
	if reply.Command != nil {
		t.Errorf("a command was handed out despite X-Skip-Command: %+v", reply.Command)
	}
}

// A tampered body must be refused. This is the check that makes the signature
// worth having, so it is worth asserting against the real server.
func TestTamperedSignatureIsRejected(t *testing.T) {
	client, agentID := newIntegrationClient(t)

	forged := New(&config.Config{
		AgentID:       agentID,
		DashboardURL:  client.Config().DashboardURL,
		AgentAPIToken: client.Config().AgentAPIToken + "-wrong",
	})
	err := forged.Post("/api/agent/poll", map[string]any{"agentId": agentID}, nil, nil)
	if err == nil {
		t.Fatal("a request signed with the wrong token was accepted")
	}
	httpError, ok := err.(*HTTPError)
	if !ok || httpError.StatusCode != 401 {
		t.Errorf("expected HTTP 401, got %v", err)
	}
}

// A command round trip: receive one from the poll and report its result. This
// covers /api/agent/command-result, the second signed endpoint, and the exact
// field names the dashboard expects in the report.
func TestCommandResultIsAcceptedByTheDashboard(t *testing.T) {
	client, agentID := newIntegrationClient(t)

	commandID := os.Getenv("AAUL_IT_COMMAND_ID")
	if commandID == "" {
		t.Skip("AAUL_IT_COMMAND_ID must point at a QUEUED command")
	}

	var reply pollReply
	if err := client.Post("/api/agent/poll",
		map[string]any{"agentId": agentID, "hostname": "WIN-TEST-01"}, &reply, nil); err != nil {
		t.Fatalf("poll rejected: %v", err)
	}
	if reply.Command == nil {
		t.Fatal("the queued command was not handed out")
	}
	if reply.Command.ID != commandID {
		t.Fatalf("got command %s, expected %s", reply.Command.ID, commandID)
	}

	result := map[string]any{
		"agentId":   agentID,
		"commandId": reply.Command.ID,
		"status":    "DONE",
		// A result carrying accents and JSON-significant characters, as a real
		// FETCH_INFO or package transcript would.
		"result":       map[string]any{"pollIntervalSeconds": 30, "note": "mis à jour <ok>"},
		"errorMessage": nil,
	}
	if err := client.Post("/api/agent/command-result", result, nil, nil); err != nil {
		t.Fatalf("the dashboard rejected the command result: %v", err)
	}
}
