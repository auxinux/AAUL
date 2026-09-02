package logs

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"aaul-agent/internal/config"
)

func useTempLogDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	t.Setenv("AAUL_RUNTIME_DIR", directory)
	t.Setenv("AAUL_LOG_DIR", filepath.Join(directory, "logs"))
	if err := config.EnsureRuntimeDirs(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(directory, "logs")
}

// writeLog creates an agent log dated ageDays ago, of the given size.
func writeLog(t *testing.T, directory string, ageDays int, sizeBytes int) string {
	t.Helper()
	day := time.Now().AddDate(0, 0, -ageDays)
	name := fmt.Sprintf("agent-%s.log", day.Format("2006-01-02"))
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, make([]byte, sizeBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	// Retention decides on modification time, so it has to be set explicitly.
	stamp := day.Add(12 * time.Hour)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestApplyRetentionByAge(t *testing.T) {
	directory := useTempLogDir(t)
	writeLog(t, directory, 0, 10)
	writeLog(t, directory, 3, 10)
	old := writeLog(t, directory, 40, 10)

	days := 7
	result := ApplyRetention(&days, nil)
	if !result.Applied {
		t.Fatal("retention should have been applied")
	}
	if len(result.Removed) != 1 || result.Removed[0] != old {
		t.Errorf("removed = %v, want [%s]", result.Removed, old)
	}
	if _, err := os.Stat(filepath.Join(directory, old)); !os.IsNotExist(err) {
		t.Error("the old log is still there")
	}
}

// The log being written to right now is the one an operator needs after an
// incident. No setting may delete it.
func TestApplyRetentionNeverDeletesTodaysLog(t *testing.T) {
	directory := useTempLogDir(t)
	today := writeLog(t, directory, 0, 5*1024*1024)
	writeLog(t, directory, 1, 5*1024*1024)

	days, maxMB := 1, 1
	ApplyRetention(&days, &maxMB)

	if _, err := os.Stat(filepath.Join(directory, today)); err != nil {
		t.Errorf("today's log was deleted: %v", err)
	}
}

func TestApplyRetentionBySizeRemovesOldestFirst(t *testing.T) {
	directory := useTempLogDir(t)
	writeLog(t, directory, 0, 1024)
	recent := writeLog(t, directory, 1, 2*1024*1024)
	oldest := writeLog(t, directory, 5, 2*1024*1024)

	maxMB := 3
	result := ApplyRetention(nil, &maxMB)
	if len(result.Removed) != 1 || result.Removed[0] != oldest {
		t.Fatalf("removed = %v, want [%s]", result.Removed, oldest)
	}
	if _, err := os.Stat(filepath.Join(directory, recent)); err != nil {
		t.Errorf("the newer log should have survived: %v", err)
	}
}

// The dashboard can send anything; the clamps stop a bad setting from wiping
// history or disabling retention entirely.
func TestApplyRetentionClampsOutOfRangeSettings(t *testing.T) {
	useTempLogDir(t)
	zero, huge := 0, 999999999
	result := ApplyRetention(&zero, &huge)
	if result.RetentionDays == nil || *result.RetentionDays != 1 {
		t.Errorf("retentionDays = %v, want 1", result.RetentionDays)
	}
	if result.MaxTotalMB == nil || *result.MaxTotalMB != 100000 {
		t.Errorf("maxTotalMb = %v, want 100000", result.MaxTotalMB)
	}
}

func TestApplyRetentionWithoutPolicyDoesNothing(t *testing.T) {
	directory := useTempLogDir(t)
	name := writeLog(t, directory, 100, 10)

	result := ApplyRetention(nil, nil)
	if result.Applied {
		t.Error("no policy means nothing to apply")
	}
	if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
		t.Error("a log was deleted with no policy set")
	}
}

// A file someone else dropped in the log directory is not ours to delete.
func TestApplyRetentionIgnoresForeignFiles(t *testing.T) {
	directory := useTempLogDir(t)
	foreign := filepath.Join(directory, "audit-export.log")
	if err := os.WriteFile(foreign, make([]byte, 4*1024*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().AddDate(0, 0, -400)
	if err := os.Chtimes(foreign, stamp, stamp); err != nil {
		t.Fatal(err)
	}

	days := 1
	result := ApplyRetention(&days, nil)
	if len(result.Removed) != 0 {
		t.Errorf("removed = %v, expected nothing", result.Removed)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Error("a foreign file was deleted")
	}
}

func TestGetStatsCountsOnlyAgentLogs(t *testing.T) {
	directory := useTempLogDir(t)
	writeLog(t, directory, 0, 100)
	writeLog(t, directory, 2, 200)
	if err := os.WriteFile(filepath.Join(directory, "other.log"), make([]byte, 999), 0o600); err != nil {
		t.Fatal(err)
	}

	stats := GetStats()
	if stats.FileCount != 2 {
		t.Errorf("fileCount = %d, want 2", stats.FileCount)
	}
	if stats.TotalBytes != 300 {
		t.Errorf("totalBytes = %d, want 300", stats.TotalBytes)
	}
	if stats.Oldest == nil || stats.Newest == nil {
		t.Error("oldest/newest should be set when logs exist")
	}
}

func TestReadTruncatesLargeLogsFromTheEnd(t *testing.T) {
	directory := useTempLogDir(t)
	name := fmt.Sprintf("agent-%s.log", time.Now().Format("2006-01-02"))
	body := append(make([]byte, 500), []byte("TAIL-MARKER")...)
	if err := os.WriteFile(filepath.Join(directory, name), body, 0o600); err != nil {
		t.Fatal(err)
	}

	content, err := Read(name, 20)
	if err != nil {
		t.Fatal(err)
	}
	if !content.Truncated {
		t.Error("the content should be flagged as truncated")
	}
	if content.SizeBytes != int64(len(body)) {
		t.Errorf("sizeBytes = %d, want %d", content.SizeBytes, len(body))
	}
	// Truncation keeps the end, which is where the failure being investigated is.
	if got := content.Content; got[len(got)-11:] != "TAIL-MARKER" {
		t.Errorf("the tail was not kept: %q", got)
	}
}

// logName comes from the dashboard; only the base name may ever be honoured.
func TestReadRefusesToEscapeTheLogDirectory(t *testing.T) {
	directory := useTempLogDir(t)
	secret := filepath.Join(filepath.Dir(directory), "config.json")
	if err := os.WriteFile(secret, []byte(`{"agentApiToken":"leak"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{`../config.json`, `..\config.json`, `logs/../../config.json`} {
		if _, err := Read(name, 1000); err == nil {
			t.Errorf("%q escaped the log directory", name)
		}
	}
}
