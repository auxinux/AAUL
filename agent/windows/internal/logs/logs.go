// Package logs owns the agent's own log files: one per day, listed, read and
// pruned on behalf of the dashboard.
//
// The file naming, retention rules and JSON shapes match the Python agent
// (agent/app/lib/logs.py) because the dashboard UI renders them directly.
package logs

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"aaul-agent/internal/config"
)

// Only files the agent itself produced are ever eligible for deletion. A stray
// file dropped in the log directory by someone else is left alone.
var agentLogPattern = regexp.MustCompile(`^agent-\d{4}-\d{2}-\d{2}\.log$`)

// Safety rails on whatever the dashboard sends us: never let a bad setting wipe
// today's log or let retention effectively disable itself.
const (
	minRetentionDays = 1
	maxRetentionDays = 3650
	minTotalMBLimit  = 1
	maxTotalMBLimit  = 100000
)

// The service and the command worker write to the same file from different
// goroutines; appends are short so a plain mutex is enough.
var writeMu sync.Mutex

// Path returns today's log file, creating the log directory if needed.
func Path() string {
	_ = config.EnsureRuntimeDirs()
	return filepath.Join(config.LogDir(), todayName())
}

func todayName() string {
	return fmt.Sprintf("agent-%s.log", time.Now().Format("2006-01-02"))
}

// LocalNowISO matches the Python agent's local_now_iso(): an ISO-8601 timestamp
// with the machine's UTC offset.
func LocalNowISO() string {
	return time.Now().Format("2006-01-02T15:04:05.000000-07:00")
}

// UTCNowISO matches the Python agent's utc_now_iso(), the format every
// timestamp sent to the dashboard uses.
func UTCNowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000Z")
}

// Append writes one timestamped line to today's log. Logging must never be able
// to abort the caller, so write errors are swallowed.
func Append(format string, args ...any) {
	message := format
	if len(args) > 0 {
		message = fmt.Sprintf(format, args...)
	}
	AppendTo(Path(), message)
}

// AppendTo writes one timestamped line to a specific log file.
func AppendTo(path, message string) {
	writeMu.Lock()
	defer writeMu.Unlock()
	handle, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer handle.Close()
	line := fmt.Sprintf("[%s] %s\n", LocalNowISO(), message)
	handle.WriteString(line)
	if echoToStdout {
		os.Stdout.WriteString(line)
	}
}

// AppendRaw writes text verbatim, without a timestamp prefix. Used for the
// command transcripts written by an update run.
func AppendRaw(path, text string) {
	writeMu.Lock()
	defer writeMu.Unlock()
	handle, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer handle.Close()
	handle.WriteString(text)
}

// Entry is one log file as listed for the dashboard.
type Entry struct {
	Name       string `json:"name"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt"`
}

func toISO(t time.Time) string {
	return t.Format("2006-01-02T15:04:05.000000-07:00")
}

// List returns every *.log file in the log directory, sorted by name — the
// dashboard shows them as-is, including files the agent did not write.
func List() []Entry {
	entries := []Entry{}
	items, err := os.ReadDir(config.LogDir())
	if err != nil {
		return entries
	}
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".log") {
			continue
		}
		info, err := item.Info()
		if err != nil {
			continue
		}
		entries = append(entries, Entry{
			Name:       item.Name(),
			SizeBytes:  info.Size(),
			ModifiedAt: toISO(info.ModTime()),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries
}

// Content is a single log file returned to the dashboard, tail-truncated when
// it is too large to ship in a command result.
type Content struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	Truncated bool   `json:"truncated"`
	Content   string `json:"content"`
}

// DefaultMaxReadBytes matches the Python agent's read_log() limit.
const DefaultMaxReadBytes = 200000

// Read returns the contents of one log file. Only the base name is honoured, so
// a crafted `logName` cannot escape the log directory.
func Read(name string, maxBytes int64) (*Content, error) {
	safeName := filepath.Base(filepath.FromSlash(name))
	path := filepath.Join(config.LogDir(), safeName)

	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("log not found: %s", safeName)
	}

	handle, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer handle.Close()

	size := info.Size()
	truncated := false
	if size > maxBytes {
		truncated = true
		if _, err := handle.Seek(size-maxBytes, 0); err != nil {
			return nil, err
		}
	}
	data := make([]byte, 0, maxBytes)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := handle.Read(buf)
		if n > 0 {
			data = append(data, buf[:n]...)
		}
		if readErr != nil {
			break
		}
	}

	return &Content{
		Name:      safeName,
		SizeBytes: size,
		Truncated: truncated,
		Content:   string(data),
	}, nil
}

// Stats summarises disk usage so the dashboard can show it per host.
type Stats struct {
	FileCount  int     `json:"fileCount"`
	TotalBytes int64   `json:"totalBytes"`
	Oldest     *string `json:"oldest"`
	Newest     *string `json:"newest"`
}

type logFile struct {
	name    string
	size    int64
	modTime time.Time
}

// agentLogFiles returns agent-produced log files, newest first.
func agentLogFiles() []logFile {
	files := []logFile{}
	items, err := os.ReadDir(config.LogDir())
	if err != nil {
		return files
	}
	for _, item := range items {
		if item.IsDir() || !agentLogPattern.MatchString(item.Name()) {
			continue
		}
		info, err := item.Info()
		if err != nil {
			continue
		}
		files = append(files, logFile{item.Name(), info.Size(), info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modTime.After(files[j].modTime) })
	return files
}

// GetStats reports file count, total size and the age range of agent logs.
func GetStats() Stats {
	files := agentLogFiles()
	stats := Stats{FileCount: len(files)}
	for _, file := range files {
		stats.TotalBytes += file.size
	}
	if len(files) > 0 {
		newest := toISO(files[0].modTime)
		oldest := toISO(files[len(files)-1].modTime)
		stats.Newest = &newest
		stats.Oldest = &oldest
	}
	return stats
}

// RetentionResult reports what a retention pass removed.
type RetentionResult struct {
	Applied       bool     `json:"applied"`
	RetentionDays *int     `json:"retentionDays,omitempty"`
	MaxTotalMB    *int     `json:"maxTotalMb,omitempty"`
	Removed       []string `json:"removed"`
	FreedBytes    int64    `json:"freedBytes"`
	Stats         *Stats   `json:"stats,omitempty"`
}

func clamp(value *int, low, high int) *int {
	if value == nil {
		return nil
	}
	result := *value
	if result < low {
		result = low
	}
	if result > high {
		result = high
	}
	return &result
}

// ApplyRetention enforces the policy pushed by the dashboard and reports what
// it removed.
//
// Two independent limits, applied in this order:
//  1. age  — delete logs older than retentionDays;
//  2. size — while the remaining logs exceed maxTotalMB, delete the oldest one.
//
// The current day's log is never deleted, whatever the settings say: losing the
// log you are actively writing to would hide the very incident you are trying
// to diagnose.
func ApplyRetention(retentionDays, maxTotalMB *int) RetentionResult {
	days := clamp(retentionDays, minRetentionDays, maxRetentionDays)
	maxMB := clamp(maxTotalMB, minTotalMBLimit, maxTotalMBLimit)
	if days == nil && maxMB == nil {
		return RetentionResult{Applied: false, Removed: []string{}}
	}

	today := todayName()
	candidates := []logFile{}
	for _, file := range agentLogFiles() {
		if file.name != today {
			candidates = append(candidates, file)
		}
	}

	removed := []string{}
	var freed int64

	drop := func(file logFile) bool {
		if err := os.Remove(filepath.Join(config.LogDir(), file.name)); err != nil {
			return false
		}
		removed = append(removed, file.name)
		freed += file.size
		return true
	}

	if days != nil {
		cutoff := time.Now().AddDate(0, 0, -*days)
		survivors := []logFile{}
		for _, file := range candidates {
			if file.modTime.Before(cutoff) {
				drop(file)
			} else {
				survivors = append(survivors, file)
			}
		}
		candidates = survivors
	}

	if maxMB != nil {
		budget := int64(*maxMB) * 1024 * 1024
		var total int64
		for _, file := range candidates {
			total += file.size
		}
		// Today's log counts against the budget even though it is never deleted.
		if info, err := os.Stat(filepath.Join(config.LogDir(), today)); err == nil {
			total += info.Size()
		}
		// candidates is newest-first; take from the end to remove the oldest first.
		for total > budget && len(candidates) > 0 {
			oldest := candidates[len(candidates)-1]
			candidates = candidates[:len(candidates)-1]
			if drop(oldest) {
				total -= oldest.size
			}
		}
	}

	if len(removed) > 0 {
		Append("[logs] retention applied: %d file(s) removed, %d bytes freed (days=%s, maxMb=%s)",
			len(removed), freed, formatOptional(days), formatOptional(maxMB))
	}

	return RetentionResult{
		Applied:       true,
		RetentionDays: days,
		MaxTotalMB:    maxMB,
		Removed:       removed,
		FreedBytes:    freed,
	}
}

func formatOptional(value *int) string {
	if value == nil {
		return "None"
	}
	return fmt.Sprintf("%d", *value)
}

// echoToStdout mirrors every appended line to standard output. Console mode
// turns it on so a developer sees the same stream the service would have
// written to file.
var echoToStdout bool

// EchoToStdout enables or disables mirroring to standard output.
func EchoToStdout(enabled bool) {
	writeMu.Lock()
	defer writeMu.Unlock()
	echoToStdout = enabled
}
