//go:build windows

// Package commands executes the work the dashboard queues for this agent.
//
// The command set and the JSON shape of every result match the Python agent's
// handle_command() (agent/app/agent_poller.py:78): the dashboard renders these
// payloads directly, so the contract is not ours to change.
package commands

import (
	"encoding/json"
	"fmt"

	"aaul-agent/internal/api"
	"aaul-agent/internal/config"
	"aaul-agent/internal/logs"
	"aaul-agent/internal/osupdate"
	"aaul-agent/internal/packages"
	"aaul-agent/internal/selfupdate"
	"aaul-agent/internal/sysinfo"
	"aaul-agent/internal/version"
)

// Command is one queued instruction, as returned by /api/agent/poll.
type Command struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Outcome is what the agent reports back to /api/agent/command-result, plus the
// two process-level actions a command can request.
type Outcome struct {
	Status       string
	Result       any
	ErrorMessage string
	// Restart asks for a service restart once the result has been reported.
	Restart bool
	// ExitAfter stops the agent for good — only UNINSTALL sets it.
	ExitAfter bool
}

func failed(format string, args ...any) Outcome {
	return Outcome{Status: "ERROR", Result: map[string]any{}, ErrorMessage: fmt.Sprintf(format, args...)}
}

func done(result any) Outcome {
	return Outcome{Status: "DONE", Result: result}
}

// Handle executes one command. It never panics out to the caller: any failure
// becomes an ERROR result the dashboard can display.
func Handle(client *api.Client, cfg *config.Config, command Command) (outcome Outcome) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logs.Append("[command] %s panicked: %v", command.Type, recovered)
			outcome = failed("internal error: %v", recovered)
		}
	}()

	switch command.Type {
	case "RUN_NOW":
		return runNow()
	case "SET_SCHEDULE":
		return setSchedule(cfg, command.Payload)
	case "UPDATE_AGENT":
		return updateAgent(client)
	case "SET_POLL_INTERVAL":
		return setPollInterval(cfg, command.Payload)
	case "UNINSTALL":
		return uninstall()
	case "LIST_LOGS":
		stats := logs.GetStats()
		return done(map[string]any{"logs": logs.List(), "stats": stats})
	case "PRUNE_LOGS":
		return pruneLogs(command.Payload)
	case "FETCH_LOG":
		return fetchLog(command.Payload)
	case "FETCH_INFO":
		return done(sysinfo.Collect())
	case "PACKAGES_LIST":
		return wrap(packages.ListInstalled())
	case "PACKAGE_SEARCH":
		return packageSearch(command.Payload)
	case "PACKAGE_INSTALL":
		return packageInstall(command.Payload)
	case "PACKAGE_REMOVE":
		return packageRemove(command.Payload)
	case "CHECK_UPDATES":
		return wrap(packages.CheckUpdates())
	case "UPDATE_PACKAGES":
		return updatePackages(command.Payload)
	default:
		return failed("Unknown command %s", command.Type)
	}
}

// wrap turns a (result, error) pair into an Outcome.
func wrap[T any](result T, err error) Outcome {
	if err != nil {
		return failed("%v", err)
	}
	return done(result)
}

func decode(payload json.RawMessage, target any) error {
	if len(payload) == 0 || string(payload) == "null" {
		return nil
	}
	return json.Unmarshal(payload, target)
}

func runNow() Outcome {
	result := osupdate.Run(false)
	outcome := done(map[string]any{
		"lastStatus":          result.Status,
		"lastExitCode":        result.ExitCode,
		"lastDurationSeconds": result.Duration,
	})
	if result.Status != "OK" {
		outcome.Status = "ERROR"
		outcome.ErrorMessage = result.Message
	}
	return outcome
}

func setSchedule(cfg *config.Config, payload json.RawMessage) Outcome {
	var body struct {
		Enabled   bool   `json:"enabled"`
		DailyTime string `json:"dailyTime"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid SET_SCHEDULE payload: %v", err)
	}
	if body.DailyTime == "" {
		body.DailyTime = config.DefaultDailyTime
	}

	cfg.Schedule = config.Schedule{Enabled: body.Enabled, DailyTime: body.DailyTime}
	if err := cfg.Save(); err != nil {
		return failed("could not save the schedule: %v", err)
	}
	// The service runs the daily update itself, so there is nothing else to
	// register: saving the config is the whole operation.
	logs.Append("[schedule] enabled=%t dailyTime=%s", body.Enabled, body.DailyTime)
	return done(map[string]any{"schedule": cfg.Schedule})
}

func updateAgent(client *api.Client) Outcome {
	newVersion, err := selfupdate.Run(client, version.Version)
	if err != nil {
		return failed("%v", err)
	}
	outcome := done(map[string]any{"version": newVersion})
	outcome.Restart = true
	return outcome
}

func setPollInterval(cfg *config.Config, payload json.RawMessage) Outcome {
	var body struct {
		PollIntervalSeconds int `json:"pollIntervalSeconds"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid SET_POLL_INTERVAL payload: %v", err)
	}
	if body.PollIntervalSeconds <= 0 {
		return failed("Invalid poll interval")
	}

	cfg.PollIntervalSeconds = body.PollIntervalSeconds
	if err := cfg.Save(); err != nil {
		return failed("could not save the poll interval: %v", err)
	}
	// The poll loop re-reads the interval on every iteration, so unlike the
	// Python agent this needs no restart to take effect.
	logs.Append("[config] poll interval set to %ds", body.PollIntervalSeconds)
	return done(map[string]any{"pollIntervalSeconds": body.PollIntervalSeconds})
}

// uninstall only reports success. The teardown itself happens after the result
// has been sent (see poller.execute): the dashboard must see the command
// succeed before the agent stops existing.
func uninstall() Outcome {
	logs.Append("[uninstall] requested")
	outcome := done(map[string]any{"uninstalled": true})
	outcome.ExitAfter = true
	return outcome
}

func pruneLogs(payload json.RawMessage) Outcome {
	var body struct {
		RetentionDays *int `json:"retentionDays"`
		MaxTotalMB    *int `json:"maxTotalMb"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid PRUNE_LOGS payload: %v", err)
	}
	result := logs.ApplyRetention(body.RetentionDays, body.MaxTotalMB)
	stats := logs.GetStats()
	result.Stats = &stats
	return done(result)
}

func fetchLog(payload json.RawMessage) Outcome {
	var body struct {
		LogName string `json:"logName"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid FETCH_LOG payload: %v", err)
	}
	if body.LogName == "" {
		return failed("Missing logName")
	}
	return wrap(logs.Read(body.LogName, logs.DefaultMaxReadBytes))
}

func packageSearch(payload json.RawMessage) Outcome {
	var body struct {
		Query string `json:"query"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid PACKAGE_SEARCH payload: %v", err)
	}
	return wrap(packages.Search(body.Query))
}

func packageInstall(payload json.RawMessage) Outcome {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid PACKAGE_INSTALL payload: %v", err)
	}
	result, err := packages.Install(body.Name)
	if err != nil {
		return failed("%v", err)
	}
	outcome := done(result)
	if !result.Success {
		outcome.Status = "ERROR"
		outcome.ErrorMessage = "Installation échouée"
	}
	return outcome
}

func packageRemove(payload json.RawMessage) Outcome {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid PACKAGE_REMOVE payload: %v", err)
	}
	result, err := packages.Remove(body.Name)
	if err != nil {
		return failed("%v", err)
	}
	outcome := done(result)
	if !result.Success {
		outcome.Status = "ERROR"
		outcome.ErrorMessage = "Désinstallation échouée"
	}
	return outcome
}

func updatePackages(payload json.RawMessage) Outcome {
	var body struct {
		Names []string `json:"names"`
	}
	if err := decode(payload, &body); err != nil {
		return failed("invalid UPDATE_PACKAGES payload: %v", err)
	}
	result, err := packages.UpdatePackages(body.Names)
	if err != nil {
		return failed("%v", err)
	}
	outcome := done(result)
	if !result.Success {
		outcome.Status = "ERROR"
		outcome.ErrorMessage = "Mise à jour échouée"
	}
	return outcome
}
