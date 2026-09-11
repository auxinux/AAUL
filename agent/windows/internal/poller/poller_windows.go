//go:build windows

// Package poller is the agent's main loop.
//
// It does three things on a timer: report state to the dashboard, execute
// whatever command comes back, and run the daily OS update when its time comes.
//
// Unlike the Python agent, the daily update is handled here rather than by a
// separate SYSTEM scheduled task running a second copy of the program. One
// always-running service that knows its own schedule cannot drift out of sync
// with config.json, and there is no task left behind if an uninstall is
// interrupted.
package poller

import (
	"net"
	"os"
	"sync"
	"time"

	"aaul-agent/internal/api"
	"aaul-agent/internal/commands"
	"aaul-agent/internal/config"
	"aaul-agent/internal/logs"
	"aaul-agent/internal/metrics"
	"aaul-agent/internal/osupdate"
	"aaul-agent/internal/service"
	"aaul-agent/internal/sysinfo"
	"aaul-agent/internal/version"
	"aaul-agent/internal/winapi"
)

// pollPayload is the heartbeat body. Field names and nullability match
// build_payload() (agent/app/agent_poller.py:39).
type pollPayload struct {
	AgentID             string           `json:"agentId"`
	DisplayName         string           `json:"displayName"`
	Hostname            string           `json:"hostname"`
	IP                  *string          `json:"ip"`
	AgentVersion        string           `json:"agentVersion"`
	LastSeenAt          string           `json:"lastSeenAt"`
	LastRunAt           *string          `json:"lastRunAt"`
	LastStatus          *string          `json:"lastStatus"`
	LastExitCode        *int             `json:"lastExitCode"`
	LastDurationSeconds *int             `json:"lastDurationSeconds"`
	Schedule            config.Schedule  `json:"schedule"`
	UptimeSeconds       int64            `json:"uptimeSeconds"`
	RebootRequired      bool             `json:"rebootRequired"`
	Metrics             *metrics.Metrics `json:"metrics"`
	LogStats            *logs.Stats      `json:"logStats"`
}

type logsPolicy struct {
	RetentionDays *int `json:"retentionDays"`
	MaxTotalMB    *int `json:"maxTotalMb"`
}

type pollResponse struct {
	OK                 bool              `json:"ok"`
	Command            *commands.Command `json:"command"`
	LatestAgentVersion string            `json:"latestAgentVersion"`
	Logs               *logsPolicy       `json:"logs"`
}

// retentionInterval bounds how often log retention is re-applied: it walks the
// log directory, which is cheap but pointless to redo at every poll.
const retentionInterval = time.Hour

// Poller owns the loop state for one agent.
type Poller struct {
	// commandMu is held for the whole duration of a command. The heartbeat
	// keeps running meanwhile, so the agent stays "online" during a long
	// operation such as a system update instead of looking dead.
	commandMu sync.Mutex

	lastRetentionAt time.Time

	// client is kept across polls so its connection pool is reused. Building a
	// new one every 15 seconds would open a fresh TCP and TLS session each time
	// and leave the previous pool's idle connections behind.
	client         *api.Client
	clientIdentity string
	// stop is closed to unwind the loop, either on service stop or after an
	// UNINSTALL.
	stop     chan struct{}
	stopOnce sync.Once
	// wake is signalled when a command finishes, so the loop polls again at
	// once and a queue of commands runs back to back instead of one per
	// poll interval.
	wake chan struct{}
	// restartRequested is set when a command needs the service to come back
	// with a new binary.
	restartRequested bool
	uninstalled      bool
}

// New creates a poller.
func New() *Poller {
	return &Poller{stop: make(chan struct{}), wake: make(chan struct{}, 1)}
}

// Stop unwinds the loop. Safe to call more than once.
func (p *Poller) Stop() {
	p.stopOnce.Do(func() { close(p.stop) })
}

// Run polls until Stop is called. It reloads the configuration on every
// iteration so a SET_POLL_INTERVAL takes effect without a restart.
func (p *Poller) Run() {
	logs.Append("[agent] started, version %s", version.Version)

	for {
		cfg, err := config.Load()
		if err != nil {
			logs.Append("[poll] configuration unreadable: %v", err)
			if !p.wait(time.Minute) {
				return
			}
			continue
		}

		if err := p.pollOnce(cfg, true); err != nil {
			logs.Append("[poll] error: %v", err)
		}
		p.runScheduledUpdate(cfg)

		if !p.wait(time.Duration(cfg.PollIntervalSeconds) * time.Second) {
			return
		}
	}
}

// wait sleeps for the interval, returning false if the poller was stopped.
func (p *Poller) wait(interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-p.stop:
		return false
	case <-timer.C:
		return true
	case <-p.wake:
		// A stop that raced the wake-up still wins.
		select {
		case <-p.stop:
			return false
		default:
			return true
		}
	}
}

// signalWake asks the loop to poll again now. Non-blocking: one pending
// wake-up is enough, however many commands finished meanwhile.
func (p *Poller) signalWake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// PollOnce performs a single synchronous poll, used by the CLI.
func PollOnce(cfg *config.Config) error {
	return New().pollOnce(cfg, false)
}

// clientFor returns the cached client, rebuilding it only when the dashboard
// URL or the token has changed under it (`config set-dashboard`, or a token
// rotation).
func (p *Poller) clientFor(cfg *config.Config) *api.Client {
	identity := cfg.DashboardURL + "\x00" + cfg.AgentAPIToken
	if p.client == nil || p.clientIdentity != identity {
		p.client = api.New(cfg)
		p.clientIdentity = identity
	}
	return p.client
}

func (p *Poller) pollOnce(cfg *config.Config, async bool) error {
	client := p.clientFor(cfg)

	// When a command is already running, ask the dashboard not to hand out a
	// new one — this poll is purely a heartbeat to refresh last_seen.
	busy := !p.commandMu.TryLock()
	if !busy {
		p.commandMu.Unlock()
	}
	var headers map[string]string
	if busy {
		headers = map[string]string{"X-Skip-Command": "true"}
	}

	var response pollResponse
	if err := client.Post("/api/agent/poll", buildPayload(cfg), &response, headers); err != nil {
		return err
	}

	state := config.ReadState()
	state.LastPoll = config.Str(logs.UTCNowISO())
	if err := state.Write(); err != nil {
		logs.Append("[poll] could not persist state: %v", err)
	}

	p.applyLogsPolicy(response.Logs)

	if response.LatestAgentVersion != "" && response.LatestAgentVersion != version.Version {
		logs.Append("[agent] update available: current=%s latest=%s (UPDATE_AGENT applies it)",
			version.Version, response.LatestAgentVersion)
	}

	if response.Command == nil {
		return nil
	}

	if !async {
		p.execute(client, cfg, *response.Command)
		return nil
	}

	if p.commandMu.TryLock() {
		go func(command commands.Command) {
			// Deferred in this order so the lock is released before the loop is
			// woken: woken while still locked, the next poll would look busy
			// and the rest of the queue would wait a whole interval.
			defer p.signalWake()
			defer p.commandMu.Unlock()
			p.execute(client, cfg, command)
		}(*response.Command)
	} else {
		logs.Append("[command] received while busy; will be picked up after the current one")
	}
	return nil
}

// execute runs one command and reports its result.
func (p *Poller) execute(client *api.Client, cfg *config.Config, command commands.Command) {
	logs.Append("[command] %s (%s)", command.Type, command.ID)
	outcome := commands.Handle(client, cfg, command)

	result := outcome.Result
	if result == nil {
		result = map[string]any{}
	}
	payload := map[string]any{
		"agentId":      cfg.AgentID,
		"commandId":    command.ID,
		"status":       outcome.Status,
		"result":       result,
		"errorMessage": nilIfEmpty(outcome.ErrorMessage),
	}
	if err := client.Post("/api/agent/command-result", payload, nil, nil); err != nil {
		logs.Append("[command] could not report the result of %s: %v", command.ID, err)
	}

	// UNINSTALL is reported first and destroys the installation second, so the
	// dashboard sees the command succeed before the agent disappears.
	if outcome.ExitAfter {
		p.uninstalled = true
		if err := service.RemoveFromSystemPath(config.BinDir()); err != nil {
			logs.Append("[uninstall] could not clean PATH: %v", err)
		}
		p.Stop()
		return
	}
	if outcome.Restart {
		p.restartRequested = true
		p.Stop()
	}
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// RestartRequested reports whether a command asked for the service to come back
// (after a self-update).
func (p *Poller) RestartRequested() bool { return p.restartRequested }

// Uninstalled reports whether the agent removed itself.
func (p *Poller) Uninstalled() bool { return p.uninstalled }

func (p *Poller) applyLogsPolicy(policy *logsPolicy) {
	if policy == nil {
		return
	}
	if time.Since(p.lastRetentionAt) < retentionInterval {
		return
	}
	p.lastRetentionAt = time.Now()
	logs.ApplyRetention(policy.RetentionDays, policy.MaxTotalMB)
}

// --------------------------------------------------------------------------
//  Daily schedule
// --------------------------------------------------------------------------

// runScheduledUpdate applies the daily update window.
//
// It catches up on a slot missed while the machine was off, which the Python
// agent's scheduled task did not do, but it never runs a slot that fell before
// the agent was installed.
func (p *Poller) runScheduledUpdate(cfg *config.Config) {
	if !cfg.Schedule.Enabled {
		return
	}

	now := time.Now()
	state := config.ReadState()

	if state.ScheduleBaseline == nil {
		state.ScheduleBaseline = config.Str(now.Format(time.RFC3339))
		if err := state.Write(); err != nil {
			logs.Append("[schedule] could not persist the baseline: %v", err)
		}
		return
	}
	baseline, err := time.Parse(time.RFC3339, *state.ScheduleBaseline)
	if err != nil {
		baseline = now
	}

	slot, err := scheduledSlot(now, cfg.Schedule.DailyTime)
	if err != nil {
		logs.Append("[schedule] invalid dailyTime %q: %v", cfg.Schedule.DailyTime, err)
		return
	}
	if now.Before(slot) || slot.Before(baseline) {
		return
	}

	today := now.Format("2006-01-02")
	if state.LastScheduledRun != nil && *state.LastScheduledRun == today {
		return
	}

	// Never start the daily update on top of a command that is already running.
	if !p.commandMu.TryLock() {
		return
	}
	defer p.commandMu.Unlock()

	logs.Append("[schedule] running the daily update for slot %s", cfg.Schedule.DailyTime)
	state.LastScheduledRun = config.Str(today)
	if err := state.Write(); err != nil {
		logs.Append("[schedule] could not persist the run date: %v", err)
	}
	osupdate.Run(false)
}

// scheduledSlot turns "HH:MM" into today's instant in local time.
func scheduledSlot(now time.Time, dailyTime string) (time.Time, error) {
	parsed, err := time.Parse("15:04", dailyTime)
	if err != nil {
		return time.Time{}, err
	}
	return time.Date(now.Year(), now.Month(), now.Day(),
		parsed.Hour(), parsed.Minute(), 0, 0, now.Location()), nil
}

// --------------------------------------------------------------------------
//  Payload
// --------------------------------------------------------------------------

func buildPayload(cfg *config.Config) pollPayload {
	state := config.ReadState()
	payload := pollPayload{
		AgentID:             cfg.AgentID,
		DisplayName:         cfg.DisplayName,
		Hostname:            hostname(),
		IP:                  primaryIP(),
		AgentVersion:        version.Version,
		LastSeenAt:          logs.UTCNowISO(),
		LastRunAt:           state.LastRunAt,
		LastStatus:          state.LastStatus,
		LastExitCode:        state.LastExitCode,
		LastDurationSeconds: state.LastDurationSeconds,
		Schedule:            cfg.Schedule,
		UptimeSeconds:       winapi.UptimeSeconds(),
		RebootRequired:      sysinfo.RebootRequired(),
	}

	// Vital signs must never break a poll: a failed probe degrades to null.
	collected := metrics.Collect()
	payload.Metrics = &collected
	stats := logs.GetStats()
	payload.LogStats = &stats
	return payload
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

// primaryIP returns the address the host would use to reach the outside world.
// Dialling a UDP socket picks a route without sending a single packet.
func primaryIP() *string {
	connection, err := net.DialTimeout("udp", "8.8.8.8:80", 500*time.Millisecond)
	if err == nil {
		defer connection.Close()
		if address, ok := connection.LocalAddr().(*net.UDPAddr); ok && address.IP != nil {
			text := address.IP.String()
			if text != "" {
				return &text
			}
		}
	}
	// No default route: fall back to the first routable address on any adapter.
	if addresses := winapi.IPAddresses(); len(addresses) > 0 {
		return &addresses[0]
	}
	return nil
}
