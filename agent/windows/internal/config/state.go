package config

import (
	"encoding/json"
	"os"
)

// State holds the volatile result of the last update run, reported to the
// dashboard on every poll. The fields are pointers so an agent that has never
// run an update reports `null` rather than a misleading zero — same wire shape
// as the Python agent, which sends `state.get(...)`.
type State struct {
	LastRunAt           *string `json:"lastRunAt,omitempty"`
	LastStatus          *string `json:"lastStatus,omitempty"`
	LastExitCode        *int    `json:"lastExitCode,omitempty"`
	LastDurationSeconds *int    `json:"lastDurationSeconds,omitempty"`
	LastUpdate          *string `json:"lastUpdate,omitempty"`
	LastPoll            *string `json:"lastPoll,omitempty"`
	// ScheduleBaseline is when this agent first started watching the daily
	// schedule. A slot that fell before it is never run retroactively, so
	// installing at 14:00 with a 03:00 schedule does not kick off an update on
	// the spot.
	ScheduleBaseline *string `json:"scheduleBaseline,omitempty"`
	// LastScheduledRun is the YYYY-MM-DD of the last daily run, so a restart
	// during the day cannot trigger a second one.
	LastScheduledRun *string `json:"lastScheduledRun,omitempty"`
	extra            map[string]json.RawMessage
}

// ReadState returns the persisted state, or an empty state when the file is
// missing or unreadable. A corrupt state file must never stop the agent: it
// holds reporting data, not anything the agent needs to function.
func ReadState() *State {
	state := &State{}
	data, err := os.ReadFile(StatePath())
	if err != nil {
		return state
	}
	if err := json.Unmarshal(data, state); err != nil {
		return &State{}
	}
	_ = json.Unmarshal(data, &state.extra)
	return state
}

// Write persists the state atomically, preserving unknown keys.
func (s *State) Write() error {
	merged := map[string]json.RawMessage{}
	for key, value := range s.extra {
		merged[key] = value
	}
	known, err := json.Marshal(*s)
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
	return WriteFileAtomic(StatePath(), payload)
}

// Str is a helper for assigning optional string fields.
func Str(value string) *string { return &value }

// Int is a helper for assigning optional integer fields.
func Int(value int) *int { return &value }
