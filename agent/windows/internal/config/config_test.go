package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// installerConfig is what the PowerShell installer writes, including a key this
// agent version does not know about.
const installerConfig = `{
  "agentId": "8f2c-agent",
  "displayName": "Poste Réception",
  "dashboardUrl": "https://dash.example.com",
  "agentApiToken": "secret-token",
  "pollIntervalSeconds": 15,
  "schedule": { "enabled": true, "dailyTime": "03:30" },
  "futureSetting": { "nested": [1, 2] }
}`

func useTempRuntime(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	t.Setenv("AAUL_RUNTIME_DIR", directory)
	t.Setenv("AAUL_CONFIG_PATH", filepath.Join(directory, "config.json"))
	t.Setenv("AAUL_STATE_PATH", filepath.Join(directory, "state.json"))
	t.Setenv("AAUL_LOG_DIR", filepath.Join(directory, "logs"))
	t.Setenv("AAUL_SECURITY_CONFIG_PATH", filepath.Join(directory, "security.json"))
	return directory
}

func TestLoadReadsTheInstallerConfig(t *testing.T) {
	useTempRuntime(t)
	if err := os.WriteFile(ConfigPath(), []byte(installerConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentID != "8f2c-agent" || cfg.AgentAPIToken != "secret-token" {
		t.Errorf("identity not loaded: %+v", cfg)
	}
	if cfg.DisplayName != "Poste Réception" {
		t.Errorf("accented display name mangled: %q", cfg.DisplayName)
	}
	if cfg.PollIntervalSeconds != 15 {
		t.Errorf("pollIntervalSeconds = %d", cfg.PollIntervalSeconds)
	}
	if !cfg.Schedule.Enabled || cfg.Schedule.DailyTime != "03:30" {
		t.Errorf("schedule = %+v", cfg.Schedule)
	}
}

// A SET_SCHEDULE rewrites config.json. Any key added by a newer installer must
// survive that rewrite rather than be silently dropped.
func TestSavePreservesUnknownKeys(t *testing.T) {
	useTempRuntime(t)
	if err := os.WriteFile(ConfigPath(), []byte(installerConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Schedule = Schedule{Enabled: false, DailyTime: "05:00"}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if _, ok := saved["futureSetting"]; !ok {
		t.Errorf("unknown key was dropped on save: %s", raw)
	}
	if saved["agentApiToken"] != "secret-token" {
		t.Errorf("token was lost on save: %s", raw)
	}

	reloaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Schedule.Enabled || reloaded.Schedule.DailyTime != "05:00" {
		t.Errorf("schedule did not round-trip: %+v", reloaded.Schedule)
	}
}

func TestLoadAppliesDefaults(t *testing.T) {
	useTempRuntime(t)
	if err := os.WriteFile(ConfigPath(), []byte(`{"agentId":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Schedule.DailyTime != DefaultDailyTime {
		t.Errorf("dailyTime default = %q", cfg.Schedule.DailyTime)
	}
	if cfg.PollIntervalSeconds != 60 {
		t.Errorf("pollIntervalSeconds default = %d", cfg.PollIntervalSeconds)
	}
}

func TestLoadReportsAMissingConfig(t *testing.T) {
	useTempRuntime(t)
	if _, err := Load(); err == nil {
		t.Error("a missing config should be an error")
	}
}

// A corrupt state file must not stop the agent: it holds reporting data, not
// anything the agent needs to run.
func TestReadStateToleratesCorruption(t *testing.T) {
	useTempRuntime(t)
	if err := os.WriteFile(StatePath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state := ReadState(); state == nil || state.LastRunAt != nil {
		t.Errorf("expected an empty state, got %+v", state)
	}
}

func TestStateRoundTrip(t *testing.T) {
	useTempRuntime(t)
	state := ReadState()
	state.LastStatus = Str("OK")
	state.LastExitCode = Int(0)
	state.LastDurationSeconds = Int(42)
	if err := state.Write(); err != nil {
		t.Fatal(err)
	}

	reloaded := ReadState()
	if reloaded.LastStatus == nil || *reloaded.LastStatus != "OK" {
		t.Errorf("lastStatus = %v", reloaded.LastStatus)
	}
	if reloaded.LastDurationSeconds == nil || *reloaded.LastDurationSeconds != 42 {
		t.Errorf("lastDurationSeconds = %v", reloaded.LastDurationSeconds)
	}
	// Never run: must stay null rather than become a misleading zero.
	if reloaded.LastRunAt != nil {
		t.Errorf("lastRunAt should be null, got %v", *reloaded.LastRunAt)
	}
}

func TestSecurityDefaultsAreStrict(t *testing.T) {
	useTempRuntime(t)
	security := LoadSecurity()
	if !security.VerifyTLS || security.AllowSelfSigned || !security.SignRequests {
		t.Errorf("defaults are not strict: %+v", security)
	}
	if !security.ShouldVerifyResponses() {
		t.Error("response verification should follow signRequests by default")
	}

	// A damaged file must not silently downgrade the connection.
	if err := os.WriteFile(SecurityConfigPath(), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if damaged := LoadSecurity(); !damaged.VerifyTLS || damaged.AllowSelfSigned {
		t.Errorf("a corrupt security.json downgraded the policy: %+v", damaged)
	}
}

func TestShouldVerifyResponsesHonoursExplicitFalse(t *testing.T) {
	disabled := false
	security := Security{SignRequests: true, VerifyResponses: &disabled}
	if security.ShouldVerifyResponses() {
		t.Error("an explicit false should win over signRequests")
	}
}

// Windows PowerShell 5.1 writes a UTF-8 BOM for `Set-Content -Encoding UTF8`,
// which is how the installer writes config.json. encoding/json rejects it with
// "invalid character '\\ufeff' looking for beginning of value" -- the agent
// installed fine and then could not read its own configuration.
func TestLoadAcceptsAUTF8BOM(t *testing.T) {
	useTempRuntime(t)
	withBOM := append([]byte{0xEF, 0xBB, 0xBF}, []byte(installerConfig)...)
	if err := os.WriteFile(ConfigPath(), withBOM, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("a config written by PowerShell was rejected: %v", err)
	}
	if cfg.AgentID != "8f2c-agent" {
		t.Errorf("agentId = %q", cfg.AgentID)
	}
	if cfg.DisplayName != "Poste Réception" {
		t.Errorf("the BOM was stripped but the content was damaged: %q", cfg.DisplayName)
	}
}

// The same applies to the files an administrator may have opened in Notepad.
func TestStateAndSecurityAcceptAUTF8BOM(t *testing.T) {
	useTempRuntime(t)
	bom := []byte{0xEF, 0xBB, 0xBF}

	if err := os.WriteFile(StatePath(), append(bom, []byte(`{"lastStatus":"OK"}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	state := ReadState()
	if state.LastStatus == nil || *state.LastStatus != "OK" {
		t.Errorf("state with a BOM was not read: %+v", state)
	}

	if err := os.WriteFile(SecurityConfigPath(), append(bom, []byte(`{"verifyTls":false,"allowSelfSigned":true,"signRequests":true}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	// A BOM must not silently fall back to the strict defaults either: that
	// would ignore a policy the operator deliberately relaxed.
	if security := LoadSecurity(); security.VerifyTLS || !security.AllowSelfSigned {
		t.Errorf("security.json with a BOM was ignored: %+v", security)
	}
}
