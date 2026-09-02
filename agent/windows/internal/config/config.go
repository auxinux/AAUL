package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// DefaultDailyTime is the fallback schedule time, matching the Python agent.
const DefaultDailyTime = "03:00"

// Schedule is the daily OS-update window pushed by the dashboard.
type Schedule struct {
	Enabled   bool   `json:"enabled"`
	DailyTime string `json:"dailyTime"`
}

// Config is the agent identity and connection settings written by the installer.
//
// Unknown keys are preserved on save: the dashboard installer may grow new
// fields, and an older agent must not silently drop them when it rewrites the
// file after a SET_SCHEDULE.
type Config struct {
	AgentID             string   `json:"agentId"`
	DisplayName         string   `json:"displayName"`
	DashboardURL        string   `json:"dashboardUrl"`
	AgentAPIToken       string   `json:"agentApiToken"`
	PollIntervalSeconds int      `json:"pollIntervalSeconds"`
	Schedule            Schedule `json:"schedule"`

	extra map[string]json.RawMessage
}

// Load reads config.json, applying the same defaults as the Python agent.
func Load() (*Config, error) {
	path := ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("missing config: %s", path)
		}
		return nil, err
	}

	cfg := &Config{}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("invalid config %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &cfg.extra); err != nil {
		return nil, fmt.Errorf("invalid config %s: %w", path, err)
	}
	cfg.applyDefaults()
	return cfg, nil
}

func (c *Config) applyDefaults() {
	if c.Schedule.DailyTime == "" {
		c.Schedule.DailyTime = DefaultDailyTime
	}
	if c.PollIntervalSeconds <= 0 {
		c.PollIntervalSeconds = 60
	}
}

// Save writes config.json atomically, preserving any keys this agent version
// does not know about.
func (c *Config) Save() error {
	c.applyDefaults()

	merged := map[string]json.RawMessage{}
	for key, value := range c.extra {
		merged[key] = value
	}

	// Re-encode the known fields so they win over the preserved copies.
	known, err := json.Marshal(struct {
		AgentID             string   `json:"agentId"`
		DisplayName         string   `json:"displayName"`
		DashboardURL        string   `json:"dashboardUrl"`
		AgentAPIToken       string   `json:"agentApiToken"`
		PollIntervalSeconds int      `json:"pollIntervalSeconds"`
		Schedule            Schedule `json:"schedule"`
	}{
		c.AgentID, c.DisplayName, c.DashboardURL,
		c.AgentAPIToken, c.PollIntervalSeconds, c.Schedule,
	})
	if err != nil {
		return err
	}
	var knownMap map[string]json.RawMessage
	if err := json.Unmarshal(known, &knownMap); err != nil {
		return err
	}
	for key, value := range knownMap {
		merged[key] = value
	}

	payload, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(ConfigPath(), payload)
}

// WriteFileAtomic writes through a temporary file in the same directory so a
// crash mid-write can never leave a truncated config behind.
func WriteFileAtomic(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	// Windows Rename fails if the destination exists, unlike POSIX.
	if err := replaceFile(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
